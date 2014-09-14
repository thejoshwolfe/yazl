
var fs = require("fs");
var path = require("path");
var Transform = require("stream").Transform;
var util = require("util");
var EventEmitter = require("events").EventEmitter;

exports.open = open;
exports.ZipFile = ZipFile;
exports.dateToDosDateTime = dateToDosDateTime;

function open(path, callback) {
  if (callback == null) callback = defaultCallback;
  fs.open(path, "w", function(err, fd) {
    if (err) return callback(err);
    var outputStream = fs.createWriteStream(path, {fd: fd});
    callback(null, new ZipFile(outputStream));
  });
}

util.inherits(ZipFile, EventEmitter);
function ZipFile(outputStream) {
  var self = this;
  self.outputStream = outputStream;
  self.outputStream.on("error", function(err) {
    self.emit("error", err);
  });
  self.entries = [];
  self.centralDirectoryBuffers = [];
  self.outputStreamCursor = 0;
  self.ended = false;
}

ZipFile.prototype.addFile = function(realPath, metadataPath, options) {
  var self = this;
  validateMetadataPath(metadataPath);
  if (options == null) options = {};

  var entry = new Entry(metadataPath, options);
  self.entries.push(entry);
  fs.open(realPath, "r", function(err, fd) {
    if (err) return self.emit("error", err);
    fs.fstat(fd, function(err, stats) {
      if (err) return self.emit("error", err);
      if (!stats.isFile()) return self.emit("error", new Error("not a file: " + realPath));
      entry.uncompressedSize = stats.size;
      entry.setLastModDate(stats.mtime);
      entry.setFileDataPumpFunction(function() {
        var readStream = fs.createReadStream(null, {fd: fd});
        readStream.on("error", function(err) {
          self.emit("error", err);
        });
        var compressedSizeCounter = new ByteCounter();
        readStream.pipe(compressedSizeCounter).pipe(self.outputStream, {end: false});
        compressedSizeCounter.on("finish", function() {
          // TODO: compression sometimes i guess
          entry.compressedSize = compressedSizeCounter.byteCount;
          self.outputStreamCursor += entry.compressedSize;
          writeToOutputStream(self, entry.getFileDescriptor());
          entry.state = Entry.FILE_DATA_DONE;
          pumpEntries(self);
        });
      });
      pumpEntries(self);
    });
  });
};

ZipFile.NO_COMPRESSION = 0;
ZipFile.DEFLATE_COMPRESSION = 8;

ZipFile.prototype.end = function() {
  this.ended = true;
  pumpEntries(this);
};

function writeToOutputStream(self, buffer) {
  self.outputStream.write(buffer);
  self.outputStreamCursor += buffer.length;
}

function pumpEntries(self) {
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
    }
  }
}

function getEndOfCentralDirectoryRecord(self) {
  var buffer = new Buffer(22);
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

function validateMetadataPath(metadataPath) {
  if (metadataPath.indexOf("\\") !== -1) throw new Error("invalid characters in path: " + metadataPath);
  if (/^[a-zA-Z]:/.test(metadataPath) || /^\//.test(metadataPath)) throw new Error("absolute path: " + metadataPath);
  if (metadataPath.split("/").indexOf("..") !== -1) throw new Error("invalid relative path: " + metadataPath);
  return metadataPath;
}

// this class is not part of the public API
function Entry(metadataPath, options) {
  this.utf8FileName = new Buffer(metadataPath);
  if (this.utf8FileName.length > 0xffff) throw new Error("utf8 file name too long. " + utf8FileName.length + " > " + 0xffff);
  this.state = Entry.WAITING_FOR_METADATA;
  this.setExtraFields(options.extraFields != null ? options.extraFields : []);
  // i promise this is the crc32 :|
  this.crc32 = 0x12341234;
}
Entry.WAITING_FOR_METADATA = 0;
Entry.READY_TO_PUMP_FILE_DATA = 1;
Entry.FILE_DATA_DONE = 2;
Entry.prototype.setExtraFields = function(extraFields) {
  var extraFieldBuffers = [];
  extraFields.forEach(function(extraField) {
    var id = extraField.id;
    var data = extraField.data;
    var headerBuffer = new Buffer(4);
    headerBuffer.writeUInt16LE(id, 0);
    headerBuffer.writeUInt16LE(data.length, 2);
    extraFieldBuffers.push(headerBuffer);
    extraFieldBuffers.push(data);
  });
  this.extraFields = Buffer.concat(extraFieldBuffers);
  if (this.extraFields.length > 0xffff) throw new Error("extra fields too long. " + extraFields.length + " > " + 0xffff);
};
Entry.prototype.setLastModDate = function(date) {
  var dosDateTime = dateToDosDateTime(date);
  this.lastModFileTime = dosDateTime.time;
  this.lastModFileDate = dosDateTime.date;
};
Entry.prototype.setFileDataPumpFunction = function(doFileDataPump) {
  this.doFileDataPump = doFileDataPump;
  this.state = Entry.READY_TO_PUMP_FILE_DATA;
};
// this version enables utf8 filename compression
var VERSION_NEEDED_TO_EXTRACT = 0x0014;
// this is the "version made by" reported by linux info-zip.
var VERSION_MADE_BY_INFO_ZIP = 0x031e;
var FILE_NAME_IS_UTF8 = 1 << 11;
var UNKNOWN_CRC32_AND_FILE_SIZES = 1 << 3;
Entry.prototype.getLocalFileHeader = function() {
  var fixedSizeStuff = new Buffer(30);
  var generalPurposeBitFlag = UNKNOWN_CRC32_AND_FILE_SIZES | FILE_NAME_IS_UTF8;
  fixedSizeStuff.writeUInt32LE(0x04034b50, 0);                // local file header signature     4 bytes  (0x04034b50)
  fixedSizeStuff.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT, 4); // version needed to extract       2 bytes
  fixedSizeStuff.writeUInt16LE(generalPurposeBitFlag, 6);     // general purpose bit flag        2 bytes
  fixedSizeStuff.writeUInt16LE(ZipFile.NO_COMPRESSION, 8);    // compression method              2 bytes
  fixedSizeStuff.writeUInt16LE(this.lastModFileTime, 10);     // last mod file time              2 bytes
  fixedSizeStuff.writeUInt16LE(this.lastModFileDate, 12);     // last mod file date              2 bytes
  fixedSizeStuff.writeUInt32LE(0, 14);                        // crc-32                          4 bytes
  fixedSizeStuff.writeUInt32LE(0, 18);                        // compressed size                 4 bytes
  fixedSizeStuff.writeUInt32LE(0, 22);                        // uncompressed size               4 bytes
  fixedSizeStuff.writeUInt16LE(this.utf8FileName.length, 26); // file name length                2 bytes
  fixedSizeStuff.writeUInt16LE(this.extraFields.length, 28);  // extra field length              2 bytes
  return Buffer.concat([
    fixedSizeStuff,
    this.utf8FileName,                                        // file name (variable size)
    this.extraFields,                                         // extra field (variable size)
  ]);
};
Entry.prototype.getFileDescriptor = function() {
  var buffer = new Buffer(12);
  buffer.writeUInt32LE(this.crc32, 0);            // crc-32                          4 bytes
  buffer.writeUInt32LE(this.compressedSize, 4);   // compressed size                 4 bytes
  buffer.writeUInt32LE(this.uncompressedSize, 8); // uncompressed size               4 bytes
  return buffer;
}
Entry.prototype.getCentralDirectoryRecord = function() {
  var fixedSizeStuff = new Buffer(46);
  fixedSizeStuff.writeUInt32LE(0x02014b50, 0);                // central file header signature   4 bytes  (0x02014b50)
  fixedSizeStuff.writeUInt16LE(VERSION_MADE_BY_INFO_ZIP, 4);  // version made by                 2 bytes
  fixedSizeStuff.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT, 6); // version needed to extract       2 bytes
  fixedSizeStuff.writeUInt16LE(FILE_NAME_IS_UTF8, 8);         // general purpose bit flag        2 bytes
  fixedSizeStuff.writeUInt16LE(ZipFile.NO_COMPRESSION, 10);   // compression method              2 bytes
  fixedSizeStuff.writeUInt16LE(this.lastModFileTime, 12);     // last mod file time              2 bytes
  fixedSizeStuff.writeUInt16LE(this.lastModFileDate, 14);     // last mod file date              2 bytes
  fixedSizeStuff.writeUInt32LE(this.crc32, 16);               // crc-32                          4 bytes
  fixedSizeStuff.writeUInt32LE(this.compressedSize, 20);      // compressed size                 4 bytes
  fixedSizeStuff.writeUInt32LE(this.uncompressedSize, 24);    // uncompressed size               4 bytes
  fixedSizeStuff.writeUInt16LE(this.utf8FileName.length, 28); // file name length                2 bytes
  fixedSizeStuff.writeUInt16LE(this.extraFields.length, 30);  // extra field length              2 bytes
  fixedSizeStuff.writeUInt16LE(0, 32);                        // file comment length             2 bytes
  fixedSizeStuff.writeUInt16LE(0, 34);                        // disk number start               2 bytes
  fixedSizeStuff.writeUInt16LE(0, 36);                        // internal file attributes        2 bytes
  fixedSizeStuff.writeUInt32LE(0, 38);                        // external file attributes        4 bytes
  fixedSizeStuff.writeUInt32LE(0, 42);                        // relative offset of local header 4 bytes
  return Buffer.concat([
    fixedSizeStuff,
    this.utf8FileName,                                        // file name (variable size)
    this.extraFields,                                         // extra field (variable size)
    /* empty comment */                                       // file comment (variable size)
  ]);
};

function dateToDosDateTime(jsDate) {
  var date = 0;
  date |= jsDate.getDay() & 0x1f; // 1-31
  date |= ((jsDate.getMonth() + 1) & 0xf) << 5; // 0-11, 1-12
  date |= ((jsDate.getYear() - 1980) & 0x7f) << 9; // 0-128, 1980-2108

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
