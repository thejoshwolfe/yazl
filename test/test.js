var fs = require("fs");
var yazl = require("../");
var yauzl = require("yauzl");
var BufferList = require("bl");

var fileMetadata = {
  mtime: new Date(),
  mode: 0100664,
};
var zipfile = new yazl.ZipFile();
zipfile.addFile(__filename, "unicōde.txt");
zipfile.addReadStream(fs.createReadStream(__filename), "readStream.txt", fileMetadata);
var expectedContents = fs.readFileSync(__filename);
zipfile.addBuffer(expectedContents, "with/directories.txt", fileMetadata);
zipfile.end();
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
