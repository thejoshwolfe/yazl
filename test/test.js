var fs = require("fs");
var yazl = require("../");
var yauzl = require("yauzl");
var BufferList = require("bl");

(function() {
  var fileMetadata = {
    mtime: new Date(),
    mode: 0100664,
  };
  var zipfile = new yazl.ZipFile();
  zipfile.addFile(__filename, "unicōde.txt");
  zipfile.addFile(__filename, "without-compression.txt", {compress: false});
  zipfile.addReadStream(fs.createReadStream(__filename), "readStream.txt", fileMetadata);
  var expectedContents = fs.readFileSync(__filename);
  zipfile.addBuffer(expectedContents, "with/directories.txt", fileMetadata);
  zipfile.addBuffer(expectedContents, "with\\windows-paths.txt", fileMetadata);
  zipfile.end(function(finalSize) {
    if (finalSize !== -1) throw new Error("finalSize is impossible to know before compression");
    zipfile.outputStream.pipe(new BufferList(function(err, data) {
      if (err) throw err;
      yauzl.fromBuffer(data, function(err, zipfile) {
        if (err) throw err;
        zipfile.on("entry", function(entry) {
          zipfile.openReadStream(entry, function(err, readStream) {
            if (err) throw err;
            readStream.pipe(new BufferList(function(err, data) {
              if (err) throw err;
              if (expectedContents.toString("binary") !== data.toString("binary")) throw new Error("unexpected contents");
              console.log(entry.fileName + ": pass");
            }));
          });
        });
      });
    }));
  });
})();

(function() {
  var fileMetadata = {
    mtime: new Date(),
    mode: 0100664,
    compress: false,
  };
  var zipfile = new yazl.ZipFile();
  zipfile.addFile(__filename, "asdf.txt", {compress: false});
  zipfile.addFile(__filename, "fdsa.txt", {compress: false});
  zipfile.addBuffer(new Buffer("buffer"), "buffer.txt", fileMetadata);
  fileMetadata.size = "stream".length;
  zipfile.addReadStream(new BufferList().append("stream"), "stream.txt", fileMetadata);
  zipfile.end(function(finalSize) {
    if (finalSize === -1) throw new Error("finalSize should be known");
    zipfile.outputStream.pipe(new BufferList(function(err, data) {
      if (data.length !== finalSize) throw new Error("finalSize prediction is wrong. " + finalSize + " !== " + data.length);
      console.log("finalSize: pass");
    }));
  });
})();

(function() {
  var zipfile = new yazl.ZipFile();
  // all options parameters are optional
  zipfile.addFile(__filename, "a.txt");
  zipfile.addBuffer(new Buffer("buffer"), "b.txt");
  zipfile.addReadStream(new BufferList().append("stream"), "c.txt");
  zipfile.addEmptyDirectory("d/");
  zipfile.addEmptyDirectory("e");
  zipfile.end(function(finalSize) {
    if (finalSize !== -1) throw new Error("finalSize should be unknown");
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

(function() {
  var zipfile = new yazl.ZipFile();
  // all options parameters are optional
  zipfile.addBuffer(new Buffer("hello"), "hello.txt", {compress: false});
  zipfile.end(function(finalSize) {
    if (finalSize === -1) throw new Error("finalSize should be known");
    zipfile.outputStream.pipe(new BufferList(function(err, data) {
      if (err) throw err;
      if (data.length !== finalSize) throw new Error("finalSize prediction is wrong. " + finalSize + " !== " + data.length);
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
