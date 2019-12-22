const fs = require('fs');
const zlib = require('zlib');
const crc32 = require('buffer-crc32');
const { EventEmitter } = require('events');
const { Transform, PassThrough } = require('stream');

module.exports.dateToDosDateTime = dateToDosDateTime;

const ZIP64_END_OF_CENTRAL_DIRECTORY_RECORD_SIZE = 56;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIZE = 20;
const END_OF_CENTRAL_DIRECTORY_RECORD_SIZE = 22;
const EMPTY_BUFFER = bufferAlloc(0);

const LOCAL_FILE_HEADER_FIXED_SIZE = 30;
const VERSION_NEEDED_TO_EXTRACT_UTF8 = 20;
const VERSION_NEEDED_TO_EXTRACT_ZIP64 = 45;

// 3 = unix. 63 = spec version 6.3
const VERSION_MADE_BY = (3 << 8) | 63;
const FILE_NAME_IS_UTF8 = 1 << 11;
const UNKNOWN_CRC32_AND_FILE_SIZES = 1 << 3;

const DATA_DESCRIPTOR_SIZE = 16;
const ZIP64_DATA_DESCRIPTOR_SIZE = 24;

const CENTRAL_DIRECTORY_RECORD_FIXED_SIZE = 46;
const ZIP64_EXTENDED_INFORMATION_EXTRA_FIELD_SIZE = 28;

module.exports.ZipFile = class ZipFile extends EventEmitter {
  constructor() {
    super();
    this.outputStream = new PassThrough();
    this.entries = [];
    this.outputStreamCursor = 0;
    this.ended = false; // .end() sets this
    this.allDone = false; // set when we've written the last bytes
    this.forceZip64Eocd = false; // configurable in .end()
  }

  static eocdrSignatureBuffer = bufferFrom([0x50, 0x4b, 0x05, 0x06]);

  addFile(realPath, metadataPath, options) {
    metadataPath = validateMetadataPath(metadataPath, false);
    if (options == null) options = {};

    const entry = new Entry(metadataPath, false, options);
    this.entries.push(entry);
    fs.stat(realPath, (err, stats) => {
      if (err)
        return this.emit("error", err);
      if (!stats.isFile())
        return this.emit("error", new Error("not a file: " + realPath));

      entry.uncompressedSize = stats.size;

      if (options.mtime == null)
        entry.setLastModDate(stats.mtime);
      if (options.mode == null)
        entry.setFileAttributesMode(stats.mode);

      entry.setFileDataPumpFunction(() => {
        const readStream = fs.createReadStream(realPath);
        entry.state = Entry.FILE_DATA_IN_PROGRESS;
        readStream.on("error", err => {
          this.emit("error", err);
        });
        this._pumpFileDataReadStream(entry, readStream);
      });
      this._pumpEntries();
    });
  }

  addReadStream(readStream, metadataPath, options) {
    metadataPath = validateMetadataPath(metadataPath, false);
    if (options == null) options = {};
    const entry = new Entry(metadataPath, false, options);
    this.entries.push(entry);
    entry.setFileDataPumpFunction(() => {
      entry.state = Entry.FILE_DATA_IN_PROGRESS;
      this._pumpFileDataReadStream(entry, readStream);
    });
    this._pumpEntries();
  }

  addBuffer(buffer, metadataPath, options) {
    metadataPath = validateMetadataPath(metadataPath, false);
    if (buffer.length > 0x3fffffff) throw new Error("buffer too large: " + buffer.length + " > " + 0x3fffffff);
    if (options == null) options = {};
    if (options.size != null) throw new Error("options.size not allowed");
    const entry = new Entry(metadataPath, false, options);
    entry.uncompressedSize = buffer.length;
    entry.crc32 = crc32.unsigned(buffer);
    entry.crcAndFileSizeKnown = true;
    this.entries.push(entry);

    const setCompressedBuffer = compressedBuffer => {
      entry.compressedSize = compressedBuffer.length;
      entry.setFileDataPumpFunction(() => {
        this._writeToOutputStream(compressedBuffer);
        this._writeToOutputStream(entry.getDataDescriptor());
        entry.state = Entry.FILE_DATA_DONE;

        // don't call pumpEntries() recursively.
        // (also, don't call process.nextTick recursively.)
        setImmediate(() => {
          this._pumpEntries();
        });
      });
      this._pumpEntries();
    }

    if (!entry.compress) {
      setCompressedBuffer(buffer);
    } else {
      zlib.deflateRaw(buffer, (err, compressedBuffer) => {
        setCompressedBuffer(compressedBuffer);
      });
    }
  };

  /**
   * @param {string} metadataPath
   * @param {*} options
   */
  addEmptyDirectory(metadataPath, options) {
    metadataPath = validateMetadataPath(metadataPath, true);
    if (options == null)
      options = {};
    if (options.size != null)
      throw new Error("options.size not allowed");
    if (options.compress != null)
      throw new Error("options.compress not allowed");

    const entry = new Entry(metadataPath, true, options);
    this.entries.push(entry);
    entry.setFileDataPumpFunction(() => {
      this._writeToOutputStream(entry.getDataDescriptor());
      entry.state = Entry.FILE_DATA_DONE;
      this._pumpEntries();
    });
    this._pumpEntries();
  }

  end(options, finalSizeCallback) {
    if (typeof options === "function") {
      finalSizeCallback = options;
      options = null;
    }
    if (options === null)
      options = {};
    if (this.ended)
      return;
    this.ended = true;
    this.finalSizeCallback = finalSizeCallback;
    this.forceZip64Eocd = !!options.forceZip64Format;
    if (options.comment) {
      if (typeof options.comment === "string") {
        this.comment = encodeCp437(options.comment);
      } else {
        // It should be a Buffer
        this.comment = options.comment;
      }

      if (this.comment.length > 0xffff)
        throw new Error("comment is too large");

      // gotta check for this, because the zipfile format is actually ambiguous.
      if (bufferIncludes(this.comment, ZipFile.eocdrSignatureBuffer))
        throw new Error("comment contains end of central directory record signature");
    } else {
      // no comment.
      this.comment = EMPTY_BUFFER;
    }
    this._pumpEntries();
  }

  /**
   * @param {Buffer} buffer
   */
  _writeToOutputStream(buffer) {
    this.outputStream.write(buffer);
    this.outputStreamCursor += buffer.length;
  };

  _pumpFileDataReadStream(entry, readStream) {
    const crc32Watcher = new Crc32Watcher();
    const uncompressedSizeCounter = new ByteCounter();
    const compressor = entry.compress ? new zlib.DeflateRaw() : new PassThrough();
    const compressedSizeCounter = new ByteCounter();
    readStream.pipe(crc32Watcher)
      .pipe(uncompressedSizeCounter)
      .pipe(compressor)
      .pipe(compressedSizeCounter)
      .pipe(this.outputStream, { end: false });
    compressedSizeCounter.on('end', () => {
      entry.crc32 = crc32Watcher.crc32;
      if (entry.uncompressedSize == null) {
        entry.uncompressedSize = uncompressedSizeCounter.byteCount;
      } else {
        if (entry.uncompressedSize !== uncompressedSizeCounter.byteCount)
          return this.emit('error', new Error('file data stream has unexpected number of bytes'));
      }
      entry.compressedSize = compressedSizeCounter.byteCount;
      this.outputStreamCursor += entry.compressedSize;
      this._writeToOutputStream(entry.getDataDescriptor());
      entry.state = Entry.FILE_DATA_DONE;
      this._pumpEntries();
    });
  }

  _pumpEntries() {
    if (this.allDone)
      return;
    // first check if finalSize is finally known
    if (this.ended && this.finalSizeCallback !== null) {
      const finalSize = this.calculateFinalSize();
      if (finalSize !== null) {
        // we have an answer
        this.finalSizeCallback(finalSize);
        this.finalSizeCallback = null;
      }
    }

    // pump entries
    const entry = this.entries.find(entry => entry.state < Entry.FILE_DATA_DONE) || null;

    if (entry !== null) {
      // this entry is not done yet
      if (entry.state < Entry.READY_TO_PUMP_FILE_DATA)
        return; // input file not open yet
      if (entry.state === Entry.FILE_DATA_IN_PROGRESS)
        return; // we'll get there
      // start with local file header
      entry.relativeOffsetOfLocalHeader = this.outputStreamCursor;
      this._writeToOutputStream(entry.getLocalFileHeader());
      entry.doFileDataPump();
    } else {
      // all cought up on writing entries
      if (this.ended) {
        // head for the exit
        this.offsetOfStartOfCentralDirectory = this.outputStreamCursor;
        this.entries.forEach(entry => {
          this._writeToOutputStream(entry.getCentralDirectoryRecord());
        });
        this._writeToOutputStream(this.getEndOfCentralDirectoryRecord());
        this.outputStream.end();
        this.allDone = true;
      }
    }
  }

  calculateFinalSize() {
    let pretendOutputCursor = 0;
    let centralDirectorySize = 0;
    for (const entry of this.entries) {
      // compression is too hard to predict
      if (entry.compress)
        return -1;
      if (entry.state >= Entry.READY_TO_PUMP_FILE_DATA) {
        // if addReadStream was called without providing the size, we can't predict the final size
        if (entry.uncompressedSize == null)
          return -1;
      } else {
        // if we're still waiting for fs.stat, we might learn the size someday
        if (entry.uncompressedSize == null)
          return null;
      }
      // we know this for sure, and this is important to know if we need ZIP64 format.
      entry.relativeOffsetOfLocalHeader = pretendOutputCursor;
      const useZip64Format = entry.useZip64Format();

      pretendOutputCursor += LOCAL_FILE_HEADER_FIXED_SIZE + entry.utf8FileName.length;
      pretendOutputCursor += entry.uncompressedSize;
      if (!entry.crcAndFileSizeKnown) {
        // use a data descriptor
        if (useZip64Format) {
          pretendOutputCursor += ZIP64_DATA_DESCRIPTOR_SIZE;
        } else {
          pretendOutputCursor += DATA_DESCRIPTOR_SIZE;
        }
      }

      centralDirectorySize += CENTRAL_DIRECTORY_RECORD_FIXED_SIZE + entry.utf8FileName.length + entry.fileComment.length;
      if (useZip64Format) {
        centralDirectorySize += ZIP64_EXTENDED_INFORMATION_EXTRA_FIELD_SIZE;
      }
    }

    let endOfCentralDirectorySize = 0;
    if (this.forceZip64Eocd ||
      this.entries.length >= 0xffff ||
      centralDirectorySize >= 0xffff ||
      pretendOutputCursor >= 0xffffffff) {
      // use zip64 end of central directory stuff
      endOfCentralDirectorySize += ZIP64_END_OF_CENTRAL_DIRECTORY_RECORD_SIZE + ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIZE;
    }
    endOfCentralDirectorySize += END_OF_CENTRAL_DIRECTORY_RECORD_SIZE + this.comment.length;
    return pretendOutputCursor + centralDirectorySize + endOfCentralDirectorySize;
  }

  /**
   * @param {boolean} actuallyJustTellMeHowLongItWouldBe
   * @returns
   */
  getEndOfCentralDirectoryRecord(actuallyJustTellMeHowLongItWouldBe) {
    let needZip64Format = false;
    let normalEntriesLength = this.entries.length;
    if (this.forceZip64Eocd || this.entries.length >= 0xffff) {
      normalEntriesLength = 0xffff;
      needZip64Format = true;
    }
    let sizeOfCentralDirectory = this.outputStreamCursor - this.offsetOfStartOfCentralDirectory;
    let normalSizeOfCentralDirectory = sizeOfCentralDirectory;
    if (this.forceZip64Eocd || sizeOfCentralDirectory >= 0xffffffff) {
      normalSizeOfCentralDirectory = 0xffffffff;
      needZip64Format = true;
    }
    let normalOffsetOfStartOfCentralDirectory = this.offsetOfStartOfCentralDirectory;
    if (this.forceZip64Eocd || this.offsetOfStartOfCentralDirectory >= 0xffffffff) {
      normalOffsetOfStartOfCentralDirectory = 0xffffffff;
      needZip64Format = true;
    }
    if (actuallyJustTellMeHowLongItWouldBe) {
      if (needZip64Format) {
        return (
          ZIP64_END_OF_CENTRAL_DIRECTORY_RECORD_SIZE +
          ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIZE +
          END_OF_CENTRAL_DIRECTORY_RECORD_SIZE
        );
      } else {
        return END_OF_CENTRAL_DIRECTORY_RECORD_SIZE;
      }
    }

    let eocdrBuffer = bufferAlloc(END_OF_CENTRAL_DIRECTORY_RECORD_SIZE + this.comment.length);
    // end of central dir signature                       4 bytes  (0x06054b50)
    eocdrBuffer.writeUInt32LE(0x06054b50, 0);
    // number of this disk                                2 bytes
    eocdrBuffer.writeUInt16LE(0, 4);
    // number of the disk with the start of the central directory  2 bytes
    eocdrBuffer.writeUInt16LE(0, 6);
    // total number of entries in the central directory on this disk  2 bytes
    eocdrBuffer.writeUInt16LE(normalEntriesLength, 8);
    // total number of entries in the central directory   2 bytes
    eocdrBuffer.writeUInt16LE(normalEntriesLength, 10);
    // size of the central directory                      4 bytes
    eocdrBuffer.writeUInt32LE(normalSizeOfCentralDirectory, 12);
    // offset of start of central directory with respect to the starting disk number  4 bytes
    eocdrBuffer.writeUInt32LE(normalOffsetOfStartOfCentralDirectory, 16);
    // .ZIP file comment length                           2 bytes
    eocdrBuffer.writeUInt16LE(this.comment.length, 20);
    // .ZIP file comment                                  (variable size)
    this.comment.copy(eocdrBuffer, 22);

    if (!needZip64Format)
      return eocdrBuffer;

    // ZIP64 format
    // ZIP64 End of Central Directory Record
    const zip64EocdrBuffer = bufferAlloc(ZIP64_END_OF_CENTRAL_DIRECTORY_RECORD_SIZE);
    // zip64 end of central dir signature                                             4 bytes  (0x06064b50)
    zip64EocdrBuffer.writeUInt32LE(0x06064b50, 0);
    // size of zip64 end of central directory record                                  8 bytes
    writeUInt64LE(zip64EocdrBuffer, ZIP64_END_OF_CENTRAL_DIRECTORY_RECORD_SIZE - 12, 4);
    // version made by                                                                2 bytes
    zip64EocdrBuffer.writeUInt16LE(VERSION_MADE_BY, 12);
    // version needed to extract                                                      2 bytes
    zip64EocdrBuffer.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT_ZIP64, 14);
    // number of this disk                                                            4 bytes
    zip64EocdrBuffer.writeUInt32LE(0, 16);
    // number of the disk with the start of the central directory                     4 bytes
    zip64EocdrBuffer.writeUInt32LE(0, 20);
    // total number of entries in the central directory on this disk                  8 bytes
    writeUInt64LE(zip64EocdrBuffer, this.entries.length, 24);
    // total number of entries in the central directory                               8 bytes
    writeUInt64LE(zip64EocdrBuffer, this.entries.length, 32);
    // size of the central directory                                                  8 bytes
    writeUInt64LE(zip64EocdrBuffer, sizeOfCentralDirectory, 40);
    // offset of start of central directory with respect to the starting disk number  8 bytes
    writeUInt64LE(zip64EocdrBuffer, this.offsetOfStartOfCentralDirectory, 48);
    // zip64 extensible data sector                                                   (variable size)
    // nothing in the zip64 extensible data sector


    // ZIP64 End of Central Directory Locator
    const zip64EocdlBuffer = bufferAlloc(ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIZE);
    // zip64 end of central dir locator signature                               4 bytes  (0x07064b50)
    zip64EocdlBuffer.writeUInt32LE(0x07064b50, 0);
    // number of the disk with the start of the zip64 end of central directory  4 bytes
    zip64EocdlBuffer.writeUInt32LE(0, 4);
    // relative offset of the zip64 end of central directory record             8 bytes
    writeUInt64LE(zip64EocdlBuffer, this.outputStreamCursor, 8);
    // total number of disks                                                    4 bytes
    zip64EocdlBuffer.writeUInt32LE(1, 16);


    return Buffer.concat([
      zip64EocdrBuffer,
      zip64EocdlBuffer,
      eocdrBuffer,
    ]);
  }
}

/**
 * @param {string} metadataPath
 * @param {boolean} isDirectory
 * @returns
 */
function validateMetadataPath(metadataPath, isDirectory) {
  if (metadataPath === "")
    throw new Error("empty metadataPath");

  metadataPath = metadataPath.replace(/\\/g, "/");

  if (/^[a-zA-Z]:/.test(metadataPath) || /^\//.test(metadataPath))
    throw new Error("absolute path: " + metadataPath);
  if (metadataPath.split("/").indexOf("..") !== -1)
    throw new Error("invalid relative path: " + metadataPath);

  const looksLikeDirectory = /\/$/.test(metadataPath);
  if (isDirectory) {
    // append a trailing '/' if necessary.
    if (!looksLikeDirectory) metadataPath += "/";
  } else {
    if (looksLikeDirectory)
      throw new Error("file path cannot end with '/': " + metadataPath);
  }
  return metadataPath;
}


// this class is not part of the public API
class Entry {
  /**
   * Creates an instance of Entry.
   * @param {string} metadataPath
   * @param {boolean} isDirectory
   * @param {*} options
   * @memberof Entry
   */
  constructor(metadataPath, isDirectory, options = {}) {
    this.utf8FileName = bufferFrom(metadataPath);
    if (this.utf8FileName.length > 0xffff)
      throw new Error("utf8 file name too long. " + utf8FileName.length + " > " + 0xffff);
    this.isDirectory = isDirectory;
    this.state = Entry.WAITING_FOR_METADATA;
    this.setLastModDate(options.mtime !== null && typeof options.mtime !== 'undefined'
      ? options.mtime
      : new Date()
    );

    this.setFileAttributesMode(options.mode !== null && typeof options.mode !== 'undefined'
      ? options.mode
      : isDirectory ? 0o40775 : 0o100664
    );

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
    this.forceZip64Format = !!options.forceZip64Format;
    if (options.fileComment) {
      if (typeof options.fileComment === "string") {
        this.fileComment = bufferFrom(options.fileComment, "utf-8");
      } else {
        // It should be a Buffer
        this.fileComment = options.fileComment;
      }
      if (this.fileComment.length > 0xffff) throw new Error("fileComment is too large");
    } else {
      // no comment.
      this.fileComment = EMPTY_BUFFER;
    }
  }

  static WAITING_FOR_METADATA = 0;
  static READY_TO_PUMP_FILE_DATA = 1;
  static FILE_DATA_IN_PROGRESS = 2;
  static FILE_DATA_DONE = 3;

  /**
   * @param {Date} date
   * @memberof Entry
   */
  setLastModDate(date) {
    const { time, date: lastModFileDate } = dateToDosDateTime(date);
    this.lastModFileTime = time;
    this.lastModFileDate = lastModFileDate;
  }

  /**
   * @param {number} mode
   * @memberof Entry
   */
  setFileAttributesMode(mode) {
    if ((mode & 0xffff) !== mode)
      throw new Error("invalid mode. expected: 0 <= " + mode + " <= " + 0xffff);
    // http://unix.stackexchange.com/questions/14705/the-zip-formats-external-file-attribute/14727#14727
    this.externalFileAttributes = (mode << 16) >>> 0;
  }

  // doFileDataPump() should not call pumpEntries() directly. see issue #9.
  setFileDataPumpFunction(doFileDataPump) {
    this.doFileDataPump = doFileDataPump;
    this.state = Entry.READY_TO_PUMP_FILE_DATA;
  }

  useZip64Format = () => (
    (this.forceZip64Format) ||
    (this.uncompressedSize != null && this.uncompressedSize > 0xfffffffe) ||
    (this.compressedSize != null && this.compressedSize > 0xfffffffe) ||
    (this.relativeOffsetOfLocalHeader != null && this.relativeOffsetOfLocalHeader > 0xfffffffe)
  );

  getLocalFileHeader() {
    let crc32 = 0;
    let compressedSize = 0;
    let uncompressedSize = 0;
    if (this.crcAndFileSizeKnown) {
      crc32 = this.crc32;
      compressedSize = this.compressedSize;
      uncompressedSize = this.uncompressedSize;
    }

    let fixedSizeStuff = bufferAlloc(LOCAL_FILE_HEADER_FIXED_SIZE);
    let generalPurposeBitFlag = FILE_NAME_IS_UTF8;
    if (!this.crcAndFileSizeKnown)
      generalPurposeBitFlag |= UNKNOWN_CRC32_AND_FILE_SIZES;

    // local file header signature     4 bytes  (0x04034b50)
    fixedSizeStuff.writeUInt32LE(0x04034b50, 0);
    // version needed to extract       2 bytes
    fixedSizeStuff.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT_UTF8, 4);
    // general purpose bit flag        2 bytes
    fixedSizeStuff.writeUInt16LE(generalPurposeBitFlag, 6);
    // compression method              2 bytes
    fixedSizeStuff.writeUInt16LE(this.getCompressionMethod(), 8);
    // last mod file time              2 bytes
    fixedSizeStuff.writeUInt16LE(this.lastModFileTime, 10);
    // last mod file date              2 bytes
    fixedSizeStuff.writeUInt16LE(this.lastModFileDate, 12);
    // crc-32                          4 bytes
    fixedSizeStuff.writeUInt32LE(crc32, 14);
    // compressed size                 4 bytes
    fixedSizeStuff.writeUInt32LE(compressedSize, 18);
    // uncompressed size               4 bytes
    fixedSizeStuff.writeUInt32LE(uncompressedSize, 22);
    // file name length                2 bytes
    fixedSizeStuff.writeUInt16LE(this.utf8FileName.length, 26);
    // extra field length              2 bytes
    fixedSizeStuff.writeUInt16LE(0, 28);
    return Buffer.concat([
      fixedSizeStuff,
      // file name (variable size)
      this.utf8FileName,
      // extra field (variable size)
      // no extra fields
    ]);
  }

  getDataDescriptor() {
    if (this.crcAndFileSizeKnown) {
      // the Mac Archive Utility requires this not be present unless we set general purpose bit 3
      return EMPTY_BUFFER;
    }
    if (!this.useZip64Format()) {
      const buffer = bufferAlloc(DATA_DESCRIPTOR_SIZE);
      // optional signature (required according to Archive Utility)
      buffer.writeUInt32LE(0x08074b50, 0);
      // crc-32                          4 bytes
      buffer.writeUInt32LE(this.crc32, 4);
      // compressed size                 4 bytes
      buffer.writeUInt32LE(this.compressedSize, 8);
      // uncompressed size               4 bytes
      buffer.writeUInt32LE(this.uncompressedSize, 12);
      return buffer;
    } else {
      // ZIP64 format
      const buffer = bufferAlloc(ZIP64_DATA_DESCRIPTOR_SIZE);
      // optional signature (unknown if anyone cares about this)
      buffer.writeUInt32LE(0x08074b50, 0);
      // crc-32                          4 bytes
      buffer.writeUInt32LE(this.crc32, 4);
      // compressed size                 8 bytes
      writeUInt64LE(buffer, this.compressedSize, 8);
      // uncompressed size               8 bytes
      writeUInt64LE(buffer, this.uncompressedSize, 16);
      return buffer;
    }
  }

  getCentralDirectoryRecord() {
    const fixedSizeStuff = bufferAlloc(CENTRAL_DIRECTORY_RECORD_FIXED_SIZE);
    const generalPurposeBitFlag = this.crcAndFileSizeKnown
      ? FILE_NAME_IS_UTF8 | UNKNOWN_CRC32_AND_FILE_SIZES
      : FILE_NAME_IS_UTF8;

    const isZip64 = this.useZip64Format();

    const {
      versionNeededToExtract,
      zeiefBuffer,
      normalCompressedSize,
      normalUncompressedSize,
      normalRelativeOffsetOfLocalHeader,
    } = isZip64 ? {
      versionNeededToExtract: VERSION_NEEDED_TO_EXTRACT_ZIP64,
      zeiefBuffer: bufferAlloc(ZIP64_EXTENDED_INFORMATION_EXTRA_FIELD_SIZE),
      normalCompressedSize: 0xffffffff,
      normalUncompressedSize: 0xffffffff,
      normalRelativeOffsetOfLocalHeader: 0xffffffff,
    } : {
          versionNeededToExtract: VERSION_NEEDED_TO_EXTRACT_UTF8,
          zeiefBuffer: EMPTY_BUFFER,
          normalCompressedSize: this.compressedSize,
          normalUncompressedSize: this.uncompressedSize,
          normalRelativeOffsetOfLocalHeader: this.relativeOffsetOfLocalHeader,
        };

    if (isZip64) {
      // 0x0001                  2 bytes    Tag for this "extra" block type
      zeiefBuffer.writeUInt16LE(0x0001, 0);
      // Size                    2 bytes    Size of this "extra" block
      zeiefBuffer.writeUInt16LE(ZIP64_EXTENDED_INFORMATION_EXTRA_FIELD_SIZE - 4, 2);
      // Original Size           8 bytes    Original uncompressed file size
      writeUInt64LE(zeiefBuffer, this.uncompressedSize, 4);
      // Compressed Size         8 bytes    Size of compressed data
      writeUInt64LE(zeiefBuffer, this.compressedSize, 12);
      // Relative Header Offset  8 bytes    Offset of local header record
      writeUInt64LE(zeiefBuffer, this.relativeOffsetOfLocalHeader, 20);
      // Disk Start Number       4 bytes    Number of the disk on which this file starts
      // (omit)
    }
    // central file header signature   4 bytes  (0x02014b50)
    fixedSizeStuff.writeUInt32LE(0x02014b50, 0);
    // version made by                 2 bytes
    fixedSizeStuff.writeUInt16LE(VERSION_MADE_BY, 4);
    // version needed to extract       2 bytes
    fixedSizeStuff.writeUInt16LE(versionNeededToExtract, 6);
    // general purpose bit flag        2 bytes
    fixedSizeStuff.writeUInt16LE(generalPurposeBitFlag, 8);
    // compression method              2 bytes
    fixedSizeStuff.writeUInt16LE(this.getCompressionMethod(), 10);
    // last mod file time              2 bytes
    fixedSizeStuff.writeUInt16LE(this.lastModFileTime, 12);
    // last mod file date              2 bytes
    fixedSizeStuff.writeUInt16LE(this.lastModFileDate, 14);
    // crc-32                          4 bytes
    fixedSizeStuff.writeUInt32LE(this.crc32, 16);
    // compressed size                 4 bytes
    fixedSizeStuff.writeUInt32LE(normalCompressedSize, 20);
    // uncompressed size               4 bytes
    fixedSizeStuff.writeUInt32LE(normalUncompressedSize, 24);
    // file name length                2 bytes
    fixedSizeStuff.writeUInt16LE(this.utf8FileName.length, 28);
    // extra field length              2 bytes
    fixedSizeStuff.writeUInt16LE(zeiefBuffer.length, 30);
    // file comment length             2 bytes
    fixedSizeStuff.writeUInt16LE(this.fileComment.length, 32);
    // disk number start               2 bytes
    fixedSizeStuff.writeUInt16LE(0, 34);
    // internal file attributes        2 bytes
    fixedSizeStuff.writeUInt16LE(0, 36);
    // external file attributes        4 bytes
    fixedSizeStuff.writeUInt32LE(this.externalFileAttributes, 38);
    // relative offset of local header 4 bytes
    fixedSizeStuff.writeUInt32LE(normalRelativeOffsetOfLocalHeader, 42);

    return Buffer.concat([
      fixedSizeStuff,
      // file name (variable size)
      this.utf8FileName,
      // extra field (variable size)
      zeiefBuffer,
      // file comment (variable size)
      this.fileComment,
    ]);
  }

  getCompressionMethod() {
    const NO_COMPRESSION = 0;
    const DEFLATE_COMPRESSION = 8;
    return this.compress ? DEFLATE_COMPRESSION : NO_COMPRESSION;
  }
}

/**
 *
 * @param {Date} jsDate
 * @returns {{ date: number, time: number }}
 */
function dateToDosDateTime(jsDate) {
  let date = 0;
  date |= jsDate.getDate() & 0x1f; // 1-31
  date |= ((jsDate.getMonth() + 1) & 0xf) << 5; // 0-11, 1-12
  date |= ((jsDate.getFullYear() - 1980) & 0x7f) << 9; // 0-128, 1980-2108

  let time = 0;
  time |= Math.floor(jsDate.getSeconds() / 2); // 0-59, 0-29 (lose odd numbers)
  time |= (jsDate.getMinutes() & 0x3f) << 5; // 0-59
  time |= (jsDate.getHours() & 0x1f) << 11; // 0-23

  return { date, time };
}

/**
 * 
 * @param {Buffer} buffer
 * @param {number} n
 * @param {number} offset
 */
function writeUInt64LE(buffer, n, offset) {
  // can't use bitshift here, because JavaScript only allows bitshifting on 32-bit integers.
  const high = Math.floor(n / 0x100000000);
  const low = n % 0x100000000;
  buffer.writeUInt32LE(low, offset);
  buffer.writeUInt32LE(high, offset + 4);
}

function defaultCallback(err) {
  if (err) throw err;
}

/**
 * @class ByteCounter
 * @extends {Transform}
 */
class ByteCounter extends Transform {
  constructor(options) {
    super(options);
    this.byteCount = 0;
  }

  _transform(chunk, encoding, cb) {
    this.byteCount += chunk.length;
    cb(null, chunk);
  }
}

class Crc32Watcher extends Transform {
  constructor(options) {
    super(options);
    this.crc32 = 0;
  }
  _transform(chunk, encoding, cb) {
    this.crc32 = crc32.unsigned(chunk, this.crc32);
    cb(null, chunk);
  }
}

const cp437 =
  '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !"#$%&\'()*+,-./0123456789:;<=>' +
  '?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂Çüé' +
  'âäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟' +
  '╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

if (cp437.length !== 256)
  throw new Error("assertion failure");

let reverseCp437 = null;

/**
 * @param {string} str
 * @returns
 */
function encodeCp437(str) {
  if (/^[\x20-\x7e]*$/.test(str)) {
    // CP437, ASCII, and UTF-8 overlap in this range.
    return bufferFrom(str, "utf-8");
  }

  // This is the slow path.
  if (reverseCp437 === null) {
    // cache this once
    reverseCp437 = {};
    for (let i = 0; i < cp437.length; i++) {
      reverseCp437[cp437[i]] = i;
    }
  }

  const result = bufferAlloc(str.length);
  for (let i = 0; i < str.length; i++) {
    const b = reverseCp437[str[i]];
    if (b == null) throw new Error("character not encodable in CP437: " + JSON.stringify(str[i]));
    result[i] = b;
  }

  return result;
}

/**
 *
 * @param {number} size
 * @returns {Buffer}
 */
function bufferAlloc(size) {
  bufferAlloc = modern;
  try {
    return bufferAlloc(size);
  } catch (e) {
    bufferAlloc = legacy;
    return bufferAlloc(size);
  }
  function modern(size) {
    return Buffer.allocUnsafe(size);
  }
  function legacy(size) {
    return new Buffer(size);
  }
}

/**
 *
 * @param {string} something
 * @param {BufferEncoding} encoding
 * @returns {Buffer}
 */
function bufferFrom(something, encoding) {
  bufferFrom = modern;
  try {
    return bufferFrom(something, encoding);
  } catch (e) {
    bufferFrom = legacy;
    return bufferFrom(something, encoding);
  }
  function modern(something, encoding) {
    return Buffer.from(something, encoding);
  }
  function legacy(something, encoding) {
    return new Buffer(something, encoding);
  }
}

/**
 *
 * @param {Buffer} buffer
 * @param {string | number | Buffer} content
 * @returns
 */
function bufferIncludes(buffer, content) {
  try {
    return modern(buffer, content);
  } catch (e) {
    return legacy(buffer, content);
  }

  /**
   * @param {Buffer} buffer
   * @param {string | number | Buffer} content
   * @returns
   */
  function modern(buffer, content) {
    return buffer.includes(content);
  }
  /**
   * @param {Buffer} buffer
   * @param {string | number | Buffer} content
   * @returns
   */
  function legacy(buffer, content) {
    for (let i = 0; i <= buffer.length - content.length; i++) {
      for (let j = 0; ; j++) {
        if (j === content.length)
          return true;
        if (buffer[i + j] !== content[j])
          break;
      }
    }
    return false;
  }
}
