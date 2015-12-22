var fs = require("fs");
var Transform = require("stream").Transform;
var PassThrough = require("stream").PassThrough;
var zlib = require("zlib");
var util = require("util");
var EventEmitter = require("events").EventEmitter;
var crc32 = require("buffer-crc32");

exports.ZipFile = ZipFile;
exports.dateToDosDateTime = dateToDosDateTime;

util.inherits(ZipFile, EventEmitter);
function ZipFile() {
  this.outputStream = new PassThrough();
  this.entries = [];
  this.outputStreamCursor = 0;
  this.ended = false; // .end() sets this
  this.allDone = false; // set when we've written the last bytes
}

ZipFile.prototype.addFile = function(realPath, metadataPath, options) {
  var self = this;
  metadataPath = validateMetadataPath(metadataPath, false);
  if (options == null) options = {};

  var entry = new Entry(metadataPath, false, options);
  self.entries.push(entry);
  fs.stat(realPath, function(err, stats) {
    if (err) return self.emit("error", err);
    if (!stats.isFile()) return self.emit("error", new Error("not a file: " + realPath));
    entry.uncompressedSize = stats.size;
    if (options.mtime == null) entry.setLastModDate(stats.mtime);
    if (options.mode == null) entry.setFileAttributesMode(stats.mode);
    entry.setFileDataPumpFunction(function() {
      var readStream = fs.createReadStream(realPath);
      entry.state = Entry.FILE_DATA_IN_PROGRESS;
      readStream.on("error", function(err) {
        self.emit("error", err);
      });
      pumpFileDataReadStream(self, entry, readStream);
    });
    pumpEntries(self);
  });
};

ZipFile.prototype.addReadStream = function(readStream, metadataPath, options) {
  var self = this;
  metadataPath = validateMetadataPath(metadataPath, false);
  if (options == null) options = {};
  var entry = new Entry(metadataPath, false, options);
  self.entries.push(entry);
  entry.setFileDataPumpFunction(function() {
    entry.state = Entry.FILE_DATA_IN_PROGRESS;
    pumpFileDataReadStream(self, entry, readStream);
  });
  pumpEntries(self);
};

ZipFile.prototype.addBuffer = function(buffer, metadataPath, options) {
  var self = this;
  metadataPath = validateMetadataPath(metadataPath, false);
  if (options == null) options = {};
  if (options.size != null) throw new Error("options.size not allowed");
  var entry = new Entry(metadataPath, false, options);
  entry.uncompressedSize = buffer.length;
  entry.crc32 = crc32.unsigned(buffer);
  entry.crcAndFileSizeKnown = true;
  self.entries.push(entry);
  if (!entry.compress) {
    setCompressedBuffer(buffer);
  } else {
    zlib.deflateRaw(buffer, function(err, compressedBuffer) {
      setCompressedBuffer(compressedBuffer);
    });
  }
  function setCompressedBuffer(compressedBuffer) {
    entry.compressedSize = compressedBuffer.length;
    entry.setFileDataPumpFunction(function() {
      writeToOutputStream(self, compressedBuffer);
      writeToOutputStream(self, entry.getFileDescriptor());
      entry.state = Entry.FILE_DATA_DONE;

      // don't call pumpEntries() recursively.
      // (also, don't call process.nextTick recursively.)
      setImmediate(function() {
        pumpEntries(self);
      });
    });
    pumpEntries(self);
  }
};

ZipFile.prototype.addEmptyDirectory = function(metadataPath, options) {
  var self = this;
  metadataPath = validateMetadataPath(metadataPath, true);
  if (options == null) options = {};
  if (options.size != null) throw new Error("options.size not allowed");
  if (options.compress != null) throw new Error("options.compress not allowed");
  var entry = new Entry(metadataPath, true, options);
  self.entries.push(entry);
  entry.setFileDataPumpFunction(function() {
    writeToOutputStream(self, entry.getFileDescriptor());
    entry.state = Entry.FILE_DATA_DONE;
    pumpEntries(self);
  });
  pumpEntries(self);
};

ZipFile.prototype.end = function(finalSizeCallback) {
  if (this.ended) return;
  this.ended = true;
  this.finalSizeCallback = finalSizeCallback;
  pumpEntries(this);
};

function writeToOutputStream(self, buffer) {
  self.outputStream.write(buffer);
  self.outputStreamCursor += buffer.length;
}

function pumpFileDataReadStream(self, entry, readStream) {
  var crc32Watcher = new Crc32Watcher();
  var uncompressedSizeCounter = new ByteCounter();
  var compressor = entry.compress ? new zlib.DeflateRaw() : new PassThrough();
  var compressedSizeCounter = new ByteCounter();
  readStream.pipe(crc32Watcher)
            .pipe(uncompressedSizeCounter)
            .pipe(compressor)
            .pipe(compressedSizeCounter)
            .pipe(self.outputStream, {end: false});
  compressedSizeCounter.on("end", function() {
    entry.crc32 = crc32Watcher.crc32;
    if (entry.uncompressedSize == null) {
      entry.uncompressedSize = uncompressedSizeCounter.byteCount;
    } else {
      if (entry.uncompressedSize !== uncompressedSizeCounter.byteCount) return self.emit("error", new Error("file data stream has unexpected number of bytes"));
    }
    entry.compressedSize = compressedSizeCounter.byteCount;
    self.outputStreamCursor += entry.compressedSize;
    writeToOutputStream(self, entry.getFileDescriptor());
    entry.state = Entry.FILE_DATA_DONE;
    pumpEntries(self);
  });
}

function pumpEntries(self) {
  if (self.allDone) return;
  // first check if finalSize is finally known
  if (self.ended && self.finalSizeCallback != null) {
    var finalSize = calculateFinalSize(self);
    if (finalSize != null) {
      // we have an answer
      self.finalSizeCallback(finalSize);
      self.finalSizeCallback = null;
    }
  }

  // pump entries
  var entry = getFirstNotDoneEntry();
  function getFirstNotDoneEntry() {
    for (var i = 0; i < self.entries.length; i++) {
      var entry = self.entries[i];
      if (entry.state < Entry.FILE_DATA_DONE) return entry;
    }
    return null;
  }
  if (entry != null) {
    // this entry is not done yet
    if (entry.state < Entry.READY_TO_PUMP_FILE_DATA) return; // input file not open yet
    if (entry.state === Entry.FILE_DATA_IN_PROGRESS) return; // we'll get there
    // start with local file header
    entry.relativeOffsetOfLocalHeader = self.outputStreamCursor;
    var localFileHeader = entry.getLocalFileHeader();
    writeToOutputStream(self, localFileHeader);
    entry.doFileDataPump();
  } else {
    // all cought up on writing entries
    if (self.ended) {
      // head for the exit
      self.offsetOfStartOfCentralDirectory = self.outputStreamCursor;
      self.entries.forEach(function(entry) {
        var centralDirectoryRecord = entry.getCentralDirectoryRecord();
        writeToOutputStream(self, centralDirectoryRecord);
      });
      writeToOutputStream(self, getEndOfCentralDirectoryRecord(self));
      self.outputStream.end();
      self.allDone = true;
    }
  }
}

function calculateFinalSize(self) {
  var result = 0;
  for (var i = 0; i < self.entries.length; i++) {
    var entry = self.entries[i];
    // compression is too hard to predict
    if (entry.compress) return -1;
    if (entry.state >= Entry.READY_TO_PUMP_FILE_DATA) {
      // if addReadStream was called without providing the size, we can't predict the final size
      if (entry.uncompressedSize == null) return -1;
    } else {
      // if we're still waiting for fs.stat, we might learn the size someday
      if (entry.uncompressedSize == null) return null;
    }
    result += LOCAL_FILE_HEADER_FIXED_SIZE + entry.utf8FileName.length +
              entry.uncompressedSize +
              CENTRAL_DIRECTORY_RECORD_FIXED_SIZE + entry.utf8FileName.length;
    if (!entry.crcAndFileSizeKnown) result += FILE_DESCRIPTOR_SIZE;
  }
  result += END_OF_CENTRAL_DIRECTORY_RECORD_SIZE;
  return result;
}

var END_OF_CENTRAL_DIRECTORY_RECORD_SIZE = 22;
function getEndOfCentralDirectoryRecord(self) {
  var buffer = new Buffer(END_OF_CENTRAL_DIRECTORY_RECORD_SIZE);
  buffer.writeUInt32LE(0x06054b50, 0);           // end of central dir signature    4 bytes  (0x06054b50)
  buffer.writeUInt16LE(0, 4);                    // number of this disk             2 bytes
  buffer.writeUInt16LE(0, 6);                    // number of the disk with the     start of the central directory  2 bytes
  buffer.writeUInt16LE(self.entries.length, 8);  // total number of entries in the  central directory on this disk  2 bytes
  buffer.writeUInt16LE(self.entries.length, 10); // total number of entries in      the central directory           2 bytes
  buffer.writeUInt32LE(self.outputStreamCursor - self.offsetOfStartOfCentralDirectory, 12); // size of the central directory   4 bytes
  buffer.writeUInt32LE(self.offsetOfStartOfCentralDirectory, 16); // offset of start of central directory with respect to the starting disk number        4 bytes
  buffer.writeUInt16LE(0, 20);                   // .ZIP file comment length        2 bytes
  /* no comment */                               // .ZIP file comment       (variable size)
  return buffer;
}

function validateMetadataPath(metadataPath, isDirectory) {
  if (metadataPath === "") throw new Error("empty metadataPath");
  metadataPath = metadataPath.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(metadataPath) || /^\//.test(metadataPath)) throw new Error("absolute path: " + metadataPath);
  if (metadataPath.split("/").indexOf("..") !== -1) throw new Error("invalid relative path: " + metadataPath);
  var looksLikeDirectory = /\/$/.test(metadataPath);
  if (isDirectory) {
    // append a trailing '/' if necessary.
    if (!looksLikeDirectory) metadataPath += "/";
  } else {
    if (looksLikeDirectory) throw new Error("file path cannot end with '/': " + metadataPath);
  }
  return metadataPath;
}

// this class is not part of the public API
function Entry(metadataPath, isDirectory, options) {
  this.utf8FileName = new Buffer(metadataPath);
  if (this.utf8FileName.length > 0xffff) throw new Error("utf8 file name too long. " + utf8FileName.length + " > " + 0xffff);
  this.isDirectory = isDirectory;
  this.state = Entry.WAITING_FOR_METADATA;
  this.setLastModDate(options.mtime != null ? options.mtime : new Date());
  if (options.mode != null) {
    this.setFileAttributesMode(options.mode);
  } else {
    this.setFileAttributesMode(isDirectory ? 040775 : 0100664);
  }
  if (isDirectory) {
    this.crcAndFileSizeKnown = true;
    this.crc32 = 0;
    this.uncompressedSize = 0;
    this.compressedSize = 0;
  } else {
    // unknown so far
    this.crcAndFileSizeKnown = false;
    this.crc32 = null;
    this.uncompressedSize = null;
    this.compressedSize = null;
    if (options.size != null) this.uncompressedSize = options.size;
  }
  if (isDirectory) {
    this.compress = false;
  } else {
    this.compress = true; // default
    if (options.compress != null) this.compress = !!options.compress;
  }
}
Entry.WAITING_FOR_METADATA = 0;
Entry.READY_TO_PUMP_FILE_DATA = 1;
Entry.FILE_DATA_IN_PROGRESS = 2;
Entry.FILE_DATA_DONE = 3;
Entry.prototype.setLastModDate = function(date) {
  var dosDateTime = dateToDosDateTime(date);
  this.lastModFileTime = dosDateTime.time;
  this.lastModFileDate = dosDateTime.date;
};
Entry.prototype.setFileAttributesMode = function(mode) {
  if ((mode & 0xffff) !== mode) throw new Error("invalid mode. expected: 0 <= " + mode + " <= " + 0xffff);
  // http://unix.stackexchange.com/questions/14705/the-zip-formats-external-file-attribute/14727#14727
  this.externalFileAttributes = (mode << 16) >>> 0;
};
// doFileDataPump() should not call pumpEntries() directly. see issue #9.
Entry.prototype.setFileDataPumpFunction = function(doFileDataPump) {
  this.doFileDataPump = doFileDataPump;
  this.state = Entry.READY_TO_PUMP_FILE_DATA;
};
var LOCAL_FILE_HEADER_FIXED_SIZE = 30;
// this version enables utf8 filename encoding
var VERSION_NEEDED_TO_EXTRACT = 0x0014;
// this is the "version made by" reported by linux info-zip.
var VERSION_MADE_BY_INFO_ZIP = 0x031e;
var FILE_NAME_IS_UTF8 = 1 << 11;
var UNKNOWN_CRC32_AND_FILE_SIZES = 1 << 3;
Entry.prototype.getLocalFileHeader = function() {
  var crc32 = 0;
  var compressedSize = 0;
  var uncompressedSize = 0;
  if (this.crcAndFileSizeKnown) {
    crc32 = this.crc32;
    compressedSize = this.compressedSize;
    uncompressedSize = this.uncompressedSize;
  }

  var fixedSizeStuff = new Buffer(LOCAL_FILE_HEADER_FIXED_SIZE);
  var generalPurposeBitFlag = FILE_NAME_IS_UTF8;
  if (!this.crcAndFileSizeKnown) generalPurposeBitFlag |= UNKNOWN_CRC32_AND_FILE_SIZES;

  fixedSizeStuff.writeUInt32LE(0x04034b50, 0);                  // local file header signature     4 bytes  (0x04034b50)
  fixedSizeStuff.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT, 4);   // version needed to extract       2 bytes
  fixedSizeStuff.writeUInt16LE(generalPurposeBitFlag, 6);       // general purpose bit flag        2 bytes
  fixedSizeStuff.writeUInt16LE(this.getCompressionMethod(), 8); // compression method              2 bytes
  fixedSizeStuff.writeUInt16LE(this.lastModFileTime, 10);       // last mod file time              2 bytes
  fixedSizeStuff.writeUInt16LE(this.lastModFileDate, 12);       // last mod file date              2 bytes
  fixedSizeStuff.writeUInt32LE(crc32, 14);                      // crc-32                          4 bytes
  fixedSizeStuff.writeUInt32LE(compressedSize, 18);             // compressed size                 4 bytes
  fixedSizeStuff.writeUInt32LE(uncompressedSize, 22);           // uncompressed size               4 bytes
  fixedSizeStuff.writeUInt16LE(this.utf8FileName.length, 26);   // file name length                2 bytes
  fixedSizeStuff.writeUInt16LE(0, 28);                          // extra field length              2 bytes
  return Buffer.concat([
    fixedSizeStuff,
    this.utf8FileName,                                          // file name (variable size)
    /* no extra fields */                                       // extra field (variable size)
  ]);
};
var FILE_DESCRIPTOR_SIZE = 16
Entry.prototype.getFileDescriptor = function() {
  if (this.crcAndFileSizeKnown) {
    // MAC's Archive Utility requires this not be present unless we set general purpose bit 3
    return new Buffer(0);
  }
  var buffer = new Buffer(FILE_DESCRIPTOR_SIZE);
  buffer.writeUInt32LE(0x08074b50, 0);             // optional signature (required according to Archive Utility)
  buffer.writeUInt32LE(this.crc32, 4);             // crc-32                          4 bytes
  buffer.writeUInt32LE(this.compressedSize, 8);    // compressed size                 4 bytes
  buffer.writeUInt32LE(this.uncompressedSize, 12); // uncompressed size               4 bytes
  return buffer;
};
var CENTRAL_DIRECTORY_RECORD_FIXED_SIZE = 46;
Entry.prototype.getCentralDirectoryRecord = function() {
  var fixedSizeStuff = new Buffer(CENTRAL_DIRECTORY_RECORD_FIXED_SIZE);
  var generalPurposeBitFlag = FILE_NAME_IS_UTF8;
  if (!this.crcAndFileSizeKnown) generalPurposeBitFlag |= UNKNOWN_CRC32_AND_FILE_SIZES;
  
  fixedSizeStuff.writeUInt32LE(0x02014b50, 0);                        // central file header signature   4 bytes  (0x02014b50)
  fixedSizeStuff.writeUInt16LE(VERSION_MADE_BY_INFO_ZIP, 4);          // version made by                 2 bytes
  fixedSizeStuff.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT, 6);         // version needed to extract       2 bytes
  fixedSizeStuff.writeUInt16LE(generalPurposeBitFlag, 8);             // general purpose bit flag        2 bytes
  fixedSizeStuff.writeUInt16LE(this.getCompressionMethod(), 10);      // compression method              2 bytes
  fixedSizeStuff.writeUInt16LE(this.lastModFileTime, 12);             // last mod file time              2 bytes
  fixedSizeStuff.writeUInt16LE(this.lastModFileDate, 14);             // last mod file date              2 bytes
  fixedSizeStuff.writeUInt32LE(this.crc32, 16);                       // crc-32                          4 bytes
  fixedSizeStuff.writeUInt32LE(this.compressedSize, 20);              // compressed size                 4 bytes
  fixedSizeStuff.writeUInt32LE(this.uncompressedSize, 24);            // uncompressed size               4 bytes
  fixedSizeStuff.writeUInt16LE(this.utf8FileName.length, 28);         // file name length                2 bytes
  fixedSizeStuff.writeUInt16LE(0, 30);                                // extra field length              2 bytes
  fixedSizeStuff.writeUInt16LE(0, 32);                                // file comment length             2 bytes
  fixedSizeStuff.writeUInt16LE(0, 34);                                // disk number start               2 bytes
  fixedSizeStuff.writeUInt16LE(0, 36);                                // internal file attributes        2 bytes
  fixedSizeStuff.writeUInt32LE(this.externalFileAttributes, 38);      // external file attributes        4 bytes
  fixedSizeStuff.writeUInt32LE(this.relativeOffsetOfLocalHeader, 42); // relative offset of local header 4 bytes
  return Buffer.concat([
    fixedSizeStuff,
    this.utf8FileName,                                                // file name (variable size)
    /* no extra fields */                                             // extra field (variable size)
    /* empty comment */                                               // file comment (variable size)
  ]);
};
Entry.prototype.getCompressionMethod = function() {
  var NO_COMPRESSION = 0;
  var DEFLATE_COMPRESSION = 8;
  return this.compress ? DEFLATE_COMPRESSION : NO_COMPRESSION;
};

function dateToDosDateTime(jsDate) {
  var date = 0;
  date |= jsDate.getDate() & 0x1f; // 1-31
  date |= ((jsDate.getMonth() + 1) & 0xf) << 5; // 0-11, 1-12
  date |= ((jsDate.getFullYear() - 1980) & 0x7f) << 9; // 0-128, 1980-2108

  var time = 0;
  time |= Math.floor(jsDate.getSeconds() / 2); // 0-59, 0-29 (lose odd numbers)
  time |= (jsDate.getMinutes() & 0x3f) << 5; // 0-59
  time |= (jsDate.getHours() & 0x1f) << 11; // 0-23

  return {date: date, time: time};
}

function defaultCallback(err) {
  if (err) throw err;
}

util.inherits(ByteCounter, Transform);
function ByteCounter(options) {
  Transform.call(this, options);
  this.byteCount = 0;
}
ByteCounter.prototype._transform = function(chunk, encoding, cb) {
  this.byteCount += chunk.length;
  cb(null, chunk);
};

util.inherits(Crc32Watcher, Transform);
function Crc32Watcher(options) {
  Transform.call(this, options);
  this.crc32 = 0;
}
Crc32Watcher.prototype._transform = function(chunk, encoding, cb) {
  this.crc32 = crc32.unsigned(chunk, this.crc32);
  cb(null, chunk);
};
