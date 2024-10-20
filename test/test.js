var fs = require("fs");
var yazl = require("../");
var yauzl = require("yauzl");
var BufferList = require("./bl-minimal.js");

// Test:
//  * filename canonicalization.
//  * addFile, addReadStream, and addBuffer
//  * extracting the zip file (via yauzl) gives the correct contents.
//  * compress: false
//  * specifying mode and mtime options, but not checking them.
(function() {
  var fileMetadata = {
    mtime: new Date(),
    mode: 0o100664,
  };
  var zipfile = new yazl.ZipFile();
  zipfile.addFile(__filename, "unicōde.txt");
  zipfile.addFile(__filename, "without-compression.txt", {compress: false});
  zipfile.addReadStream(fs.createReadStream(__filename), "readStream.txt", fileMetadata);
  var expectedContents = fs.readFileSync(__filename);
  zipfile.addBuffer(expectedContents, "with/directories.txt", fileMetadata);
  zipfile.addBuffer(expectedContents, "with\\windows-paths.txt", fileMetadata);
  zipfile.end(function(calculatedTotalSize) {
    if (calculatedTotalSize !== -1) throw new Error("calculatedTotalSize is impossible to know before compression");
    zipfile.outputStream.pipe(new BufferList(function(err, data) {
      if (err) throw err;
      yauzl.fromBuffer(data, function(err, zipfile) {
        if (err) throw err;
        zipfile.on("entry", function(entry) {
          zipfile.openReadStream(entry, function(err, readStream) {
            if (err) throw err;
            readStream.pipe(new BufferList(function(err, data) {
              if (err) throw err;
              if (!expectedContents.equals(data)) throw new Error("unexpected contents");
              console.log(entry.fileName + ": pass");
            }));
          });
        });
      });
    }));
  });
})();

// Test:
//  * forceZip64Format for various subsets of entries.
//  * specifying size for addReadStream.
//  * calculatedTotalSize should always be known.
//  * calculatedTotalSize is correct.
(function() {
  var zip64Combinations = [
    [0, 0, 0, 0, 0],
    [1, 1, 0, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 0, 1, 0],
    [0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
  ];
  zip64Combinations.forEach(function(zip64Config) {
    var options = {
      compress: false,
      size: null,
      forceZip64Format: false,
    };
    var zipfile = new yazl.ZipFile();
    options.forceZip64Format = !!zip64Config[0];
    zipfile.addFile(__filename, "asdf.txt", options);
    options.forceZip64Format = !!zip64Config[1];
    zipfile.addFile(__filename, "fdsa.txt", options);
    options.forceZip64Format = !!zip64Config[2];
    zipfile.addBuffer(bufferFrom("buffer"), "buffer.txt", options);
    options.forceZip64Format = !!zip64Config[3];

    var someBuffer = bufferFrom("stream");
    options.size = someBuffer.length;
    zipfile.addReadStream(new BufferList().append(someBuffer), "stream.txt", options);
    options.size = null;

    zipfile.end({forceZip64Format:!!zip64Config[4]}, function(calculatedTotalSize) {
      if (calculatedTotalSize === -1) throw new Error("calculatedTotalSize should be known");
      zipfile.outputStream.pipe(new BufferList(function(err, data) {
        if (data.length !== calculatedTotalSize) throw new Error("calculatedTotalSize prediction is wrong. " + calculatedTotalSize + " !== " + data.length);
        console.log("calculatedTotalSize(" + zip64Config.join("") + "): pass");
      }));
    });
  });
})();

// Test adding empty directories and verifying their names in the resulting zipfile.
(function() {
  var zipfile = new yazl.ZipFile();
  zipfile.addFile(__filename, "a.txt");
  zipfile.addBuffer(bufferFrom("buffer"), "b.txt");
  zipfile.addReadStream(new BufferList().append(bufferFrom("stream")), "c.txt");
  zipfile.addEmptyDirectory("d/");
  zipfile.addEmptyDirectory("e");
  zipfile.end(function(calculatedTotalSize) {
    if (calculatedTotalSize !== -1) throw new Error("calculatedTotalSize should be unknown");
    zipfile.outputStream.pipe(new BufferList(function(err, data) {
      if (err) throw err;
      yauzl.fromBuffer(data, function(err, zipfile) {
        if (err) throw err;
        var entryNames = ["a.txt", "b.txt", "c.txt", "d/", "e/"];
        zipfile.on("entry", function(entry) {
          var expectedName = entryNames.shift();
          if (entry.fileName !== expectedName) {
            throw new Error("unexpected entry fileName: " + entry.fileName + ", expected: " + expectedName);
          }
        });
        zipfile.on("end", function() {
          if (entryNames.length === 0) console.log("optional parameters and directories: pass");
        });
      });
    }));
  });
})();

// Test:
//  * just calling addBuffer() and no other add functions.
//  * calculatedTotalSize should be known and correct for addBuffer with compress:false.
(function() {
  var zipfile = new yazl.ZipFile();
  zipfile.addBuffer(bufferFrom("hello"), "hello.txt", {compress: false});
  zipfile.end(function(calculatedTotalSize) {
    if (calculatedTotalSize === -1) throw new Error("calculatedTotalSize should be known");
    zipfile.outputStream.pipe(new BufferList(function(err, data) {
      if (err) throw err;
      if (data.length !== calculatedTotalSize) throw new Error("calculatedTotalSize prediction is wrong. " + calculatedTotalSize + " !== " + data.length);
      yauzl.fromBuffer(data, function(err, zipfile) {
        if (err) throw err;
        var entryNames = ["hello.txt"];
        zipfile.on("entry", function(entry) {
          var expectedName = entryNames.shift();
          if (entry.fileName !== expectedName) {
            throw new Error("unexpected entry fileName: " + entry.fileName + ", expected: " + expectedName);
          }
        });
        zipfile.on("end", function() {
          if (entryNames.length === 0) console.log("justAddBuffer: pass");
        });
      });
    }));
  });
})();

// Test:
//  * zipfile with no entries.
//  * comment can be string or Buffer.
//  * archive comment uses CP437 encoding for non-ASCII strings. (or rather that yazl and yauzl agree on the encoding.)
var weirdChars = '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
(function() {
  var testCases = [
    ["Hello World", "Hello World"],
    [bufferFrom("Hello"), "Hello"],
    [weirdChars, weirdChars],
  ];
  testCases.forEach(function(testCase, i) {
    var zipfile = new yazl.ZipFile();
    zipfile.end({
      comment: testCase[0],
    }, function(calculatedTotalSize) {
      if (calculatedTotalSize === -1) throw new Error("calculatedTotalSize should be known");
      zipfile.outputStream.pipe(new BufferList(function(err, data) {
        if (err) throw err;
        if (data.length !== calculatedTotalSize) throw new Error("calculatedTotalSize prediction is wrong. " + calculatedTotalSize + " !== " + data.length);
        yauzl.fromBuffer(data, function(err, zipfile) {
          if (err) throw err;
          if (zipfile.comment !== testCase[1]) {
            throw new Error("comment is wrong. " + JSON.stringify(zipfile.comment) + " !== " + JSON.stringify(testCase[1]));
          }
          console.log("comment(" + i + "): pass");
        });
      }));
    });
  });
})();

// Test ensuring that archive comment cannot create an ambiguous zip file.
(function() {
  var zipfile = new yazl.ZipFile();
  try {
    zipfile.end({
      comment: bufferFrom("01234567890123456789" + "\x50\x4b\x05\x06" + "01234567890123456789")
    });
  } catch (e) {
    if (e.toString().indexOf("comment contains end of central directory record signature") !== -1) {
      console.log("block eocdr signature in comment: pass");
      return;
    }
  }
  throw new Error("expected error for including eocdr signature in comment");
})();

// Test:
//  * specifying fileComment via addBuffer.
//  * fileComment can be string or Buffer.
//  * yauzl and yazl agree on the encoding.
//  * calculatedTotalSize is known and correct with compress:false.
(function() {
  var testCases = [
    ["Hello World!", "Hello World!"],
    [bufferFrom("Hello!"), "Hello!"],
    [weirdChars, weirdChars],
  ];
  testCases.forEach(function(testCase, i) {
    var zipfile = new yazl.ZipFile();
    zipfile.addBuffer(bufferFrom("hello"), "hello.txt", {compress: false, fileComment: testCase[0]});
    zipfile.end(function(calculatedTotalSize) {
      if (calculatedTotalSize === -1) throw new Error("calculatedTotalSize should be known");
      zipfile.outputStream.pipe(new BufferList(function(err, data) {
        if (err) throw err;
        if (data.length !== calculatedTotalSize) throw new Error("calculatedTotalSize prediction is wrong. " + calculatedTotalSize + " !== " + data.length);
        yauzl.fromBuffer(data, function(err, zipfile) {
          if (err) throw err;
          var entryNames = ["hello.txt"];
          zipfile.on("entry", function(entry) {
            var expectedName = entryNames.shift();
            if (entry.fileComment !== testCase[1]) {
              throw new Error("fileComment is wrong. " + JSON.stringify(entry.fileComment) + " !== " + JSON.stringify(testCase[1]));
            }
          });
          zipfile.on("end", function() {
            if (entryNames.length === 0) console.log("fileComment(" + i + "): pass");
          });
        });
      }));
    });
  });
})();

// Test:
//  * giving an error to the addReadStreamLazy callback emits the error on the zipfile.
//  * calling addReadStreamLazy with no options argument.
//  * trying to add beyond end() throws an error.
(function() {
  var zipfile = new yazl.ZipFile();
  zipfile.on("error", function(err) {
    if (err.message !== "error 1") throw new Error("expected only error 1, got: " + err.message);
  });
  zipfile.addReadStreamLazy("hello.txt", function(cb) {
    cb(new Error("error 1"));
  });
  zipfile.addReadStreamLazy("hello2.txt", function(cb) {
    cb(new Error("error 2"));
  });
  zipfile.end(function() {
    throw new Error("should not call calculatedTotalSizeCallback in error conditions")
  });
  var gotError = false;
  try {
    zipfile.addBuffer(bufferFrom("a"), "a");
  } catch (err) {
    gotError = true;
  }
  if (!gotError) throw new Error("expected error for adding after calling end()");
})();

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
