
var fs = require("fs");
var path = require("path");

exports.open = open;
exports.ZipFile = ZipFile;
exports.dateToDosDateTime = dateToDosDateTime;

function open(path, callback) {
  if (callback == null) callback = defaultCallback;
  fs.open(path, "w", function(err, fd) {
    if (err) return callback(err);
    var outputStream = fs.createWriteStream(path, {fd: fd});
    callback(null, new ZipFile(outputStream, {autoClose: true}));
  });
}

function ZipFile(outputStream, options) {
  this.outputStream = outputStream;
  options = options || {autoClose: false};
  this.autoClose = !!options.autoClose;
  this.entries = [];
  this.centralDirectoryBuffers = [];
  this.outputStreamCursor = 0;
  this.ended = false;
}

ZipFile.prototype.addFile = function(realPath, options) {
  var self = this;
  var metadataPath = getMetadataPath(options, realPath);

  var entry = new Entry(metadataPath, options);
  self.entries.push(entry);
  fs.open(realPath, "r", function(err, fd) {
    if (err) return self.emit("error", err);
    fs.fstat(fd, function(err, stats) {
      if (err) return self.emit("error", err);
      if (!stats.isFile()) return self.emit("error", new Error("not a file: " + realPath));
      entry.setLastModDate(stats.mtime);
      entry.setFileDataPumpFunction(function() {
        var readStream = fs.createReadStream(null, {fd: fd});
        readStream.on("error", function(err) {
          self.emit("error", err);
        });
        readStream.on("end", function() {
          entry.state = Entry.FILE_DATA_DONE;
          pumpEntries(self);
        });
        readStream.pipe(self.outputStream, {end: false});
        readStream.on("data", function(data) {
          self.outputStreamCursor += data.length;
        });
      });
      pumpEntries(self);
    });
  });
};

ZipFile.prototype.addBuffer = function(buffer, options) {
  var self = this;
  var metadataPath = getMetadataPath(options);
  var entry = new Entry(metadataPath, options);
  if (options.mtime == null) throw new Error("missing mtime");
  entry.setLastModDate(options.mtime);
  self.entries.push(entry);
  entry.setFileDataPumpFunction(function() {
    writeToOutputStream(self, buffer);
    entry.state = Entry.FILE_DATA_DONE;
    pumpEntries(self);
  });
  pumpEntries(self);
};

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
      self.entries.forEach(function(entry) {
        var centralDirectoryRecord = entry.getCentralDirectoryRecord();
        writeToOutputStream(self, centralDirectoryRecord);
      });
    }
  }
}

function getMetadataPath(options, realPath) {
  var metadataPath = options.metadataPath;
  if (metadataPath == null) {
    if (realPath == null) throw new Error("missing metadataPath");
    if (options.archiveRootPath == null) throw new Error("one of metadataPath or archiveRootPath is required");
    metadataPath = path.relative(options.archiveRootPath, realPath);
  }
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
  if (options.extraFields != null) this.setExtraFields(options.extraFields);
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
var CENTRAL_DIRECOTRY_GENERAL_PURPOSE_BIT_FLAG =
  (1 << 11) | // utf8 filename
  0;
var LOCAL_FILE_HEADER_GENERAL_PURPOSE_BIT_FLAG =
  (1 << 3) | // crc32 and file sizes are unknown before we encode the file
  (1 << 11) | // utf8 filename
  0;
Entry.prototype.getLocalFileHeader = function() {
  var fixedSizeStuff = new Buffer(30);
  // local file header signature     4 bytes  (0x04034b50)
  fixedSizeStuff.writeUInt32LE(0x04034b50, 0);
  // version needed to extract       2 bytes
  // (mimic linux info-zip)
  fixedSizeStuff.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT, 4);
  // general purpose bit flag        2 bytes
  fixedSizeStuff.writeUInt16LE(LOCAL_FILE_HEADER_GENERAL_PURPOSE_BIT_FLAG, 6);
  // compression method              2 bytes
  fixedSizeStuff.writeUInt16LE(0, 8);
  // last mod file time              2 bytes
  fixedSizeStuff.writeUInt16LE(this.lastModFileTime, 10);
  // last mod file date              2 bytes
  fixedSizeStuff.writeUInt16LE(this.lastModFileDate, 12);
  // crc-32                          4 bytes
  fixedSizeStuff.writeUInt32LE(0, 14);
  // compressed size                 4 bytes
  fixedSizeStuff.writeUInt32LE(0, 18);
  // uncompressed size               4 bytes
  fixedSizeStuff.writeUInt32LE(0, 22);
  // file name length                2 bytes
  fixedSizeStuff.writeUInt16LE(this.utf8FileName.length, 26);
  // extra field length              2 bytes
  fixedSizeStuff.writeUInt16LE(this.extraFields.length, 28);
  // file name (variable size)
  // extra field (variable size)
  // should we concat here, or write each individually? They're probably pretty small.
  return Buffers.concat([fixedSizeStuff, this.utf8FileName, this.extraFields]);
};
Entry.prototype.getCentralDirectoryRecord = function() {
  // central file header signature   4 bytes  (0x02014b50)
  fixedSizeStuff.writeUInt32LE(0x02014b50, 0);
  // version made by                 2 bytes
  // (impersonate linux info-zip)
  fixedSizeStuff.writeUInt16LE(0x031e, 4);
  // version needed to extract       2 bytes
  // (mimic linux info-zip)
  fixedSizeStuff.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT, 6);
  // general purpose bit flag        2 bytes
  fixedSizeStuff.writeUInt16LE(CENTRAL_DIRECOTRY_GENERAL_PURPOSE_BIT_FLAG, 8);
  // compression method              2 bytes
  fixedSizeStuff.writeUInt16LE(0, 10);
  // last mod file time              2 bytes
  fixedSizeStuff.writeUInt16LE(this.lastModFileTime, 12);
  // last mod file date              2 bytes
  fixedSizeStuff.writeUInt16LE(this.lastModFileDate, 14);
  // crc-32                          4 bytes
  fixedSizeStuff.writeUInt16LE(this.crc32, 16);
  // compressed size                 4 bytes
  fixedSizeStuff.writeUInt16LE(this.compressedSize, 20);
  // uncompressed size               4 bytes
  fixedSizeStuff.writeUInt16LE(this.uncompressedSize, 24);
  // file name length                2 bytes
  // extra field length              2 bytes
  // file comment length             2 bytes
  // disk number start               2 bytes
  // internal file attributes        2 bytes
  // external file attributes        4 bytes
  // relative offset of local header 4 bytes
  // file name (variable size)
  // extra field (variable size)
  // file comment (variable size)
};

function dateToDosDateTime(jsDate) {
  var date = 0;
  date |= jsDate.getDay() & 0x1f; // 1-31
  date |= ((jsDate.getMonth() + 1) & 0xf) << 5; // 0-11, 1-12
  date |= ((jsDate.getYear() - 1980) & 0x7f) << 9; // 0-128, 1980-2108

  var time = 0;
  time |= Math.floor(jsDate.getSecond() / 2); // 0-59, 0-29 (lose odd numbers)
  time |= (jsDate.getMinute() & 0x3f) << 5; // 0-59
  time |= (jsDate.getHour() & 0x1f) << 11; // 0-23

  return {date: date, time: time};
}

function defaultCallback(err) {
  if (err) throw err;
}
