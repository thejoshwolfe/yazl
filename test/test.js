var yazl = require("../");
var fs = require("fs");
var path = require("path");

var dump_dir = path.join(__dirname, "dump");
try { fs.mkdirSync(dump_dir); } catch (err) { }
var dump_zip = path.join(dump_dir, "dump.zip");
var zipfile = new yazl.ZipFile();
zipfile.addFile(__filename, "unicōde.txt");
zipfile.addFile(__filename, "with/directories.txt");
zipfile.end();
zipfile.outputStream.pipe(fs.createWriteStream(dump_zip)).on("finish", function() {
  console.log("done");
});
