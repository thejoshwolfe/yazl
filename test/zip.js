var usage = "node " + __filename.replace(/.*[\/\\]/, "") + " " +
            "[FILE | --compress | --no-compress]... -o OUTPUT.zip";
var yazl = require("../");
var fs = require("fs");

var zipfile = new yazl.ZipFile();
var options = {compress: false};

var args = process.argv.slice(2);
if (Math.max(args.indexOf("-h"), args.indexOf("--help")) !== -1) throw new Error("usage: " + usage);
var outputFileIndex = args.indexOf("-o");
if (outputFileIndex === -1) throw new Error("missing -o");
zipfile.outputStream.pipe(fs.createWriteStream(args[outputFileIndex + 1]));
args.splice(outputFileIndex, 2);
args.forEach(function(arg) {
  if (/--compress/.test(arg)) {
    options.compress = true;
  } else if (/--no-compress/.test(arg)) {
    options.compress = false;
  } else {
    // file thing
    var stats = fs.statSync(arg);
    if (stats.isFile()) {
      zipfile.addFile(arg, arg, options);
    } else if (stats.isDirectory()) {
      zipfile.addEmptyDirectory(arg);
    } else {
      throw new Error("what is this: " + arg);
    }
  }
});
zipfile.end();
