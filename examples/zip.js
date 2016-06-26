var usage =
  "node " + __filename.replace(/.*[\/\\]/, "") + " " +
  "[FILE | --[no-]compress | {--file|--buffer|--stream} | --[no-]zip64 | --[no-]verbose]... -o OUTPUT.zip" + "\n" +
  "\n" +
  "all arguments and switches are processed in order. for example:" + "\n" +
  "  node zip.js --compress a.txt --no-compress b.txt -o out.zip" + "\n" +
  "would result in compression for a.txt, but not for b.txt.";
var yazl = require("../");
var fs = require("fs");

var zipfile = new yazl.ZipFile();
var options = {compress: false, forceZip64Format: false};
var addStrategy = "addFile";
var verbose = false;

var args = process.argv.slice(2);
if (Math.max(args.indexOf("-h"), args.indexOf("--help")) !== -1) {
  console.log("usage: " + usage);
  process.exit(1);
}
// this one's important
if (args.indexOf("-o") === -1) throw new Error("missing -o");
if (args.indexOf("-o") + 1 >= args.length) throw new Error("missing argument after -o");

var its_the_dash_o = false;
args.forEach(function(arg) {
  if (its_the_dash_o) {
    its_the_dash_o = false;
    var stream = arg === "-" ? process.stdout : fs.createWriteStream(arg);
    zipfile.outputStream.pipe(stream);
  } else if (arg === "--compress") {
    options.compress = true;
  } else if (arg === "--no-compress") {
    options.compress = false;
  } else if (arg === "--file") {
    addStrategy = "addFile";
  } else if (arg === "--buffer") {
    addStrategy = "addBuffer";
  } else if (arg === "--stream") {
    addStrategy = "addReadStream";
  } else if (arg === "--no-verbose") {
    verbose = false;
  } else if (arg === "--verbose") {
    verbose = true;
  } else if (arg === "--zip64") {
    options.forceZip64Format = true;
  } else if (arg === "--no-zip64") {
    options.forceZip64Format = false;
  } else if (arg === "-o") {
    its_the_dash_o = true;
  } else if (arg === "-") {
    zipfile.addReadStream(process.stdin);
  } else {
    // file thing
    var stats = fs.statSync(arg);
    if (stats.isFile()) {
      switch (addStrategy) {
        case "addFile":
          if (verbose) console.log("addFile(" +
                                   JSON.stringify(arg) + ", " +
                                   JSON.stringify(arg) + ", " +
                                   JSON.stringify(options) + ");");
          zipfile.addFile(arg, arg, options);
          break;
        case "addBuffer":
          if (verbose) console.log("addBuffer(fs.readFileSync(" +
                                   JSON.stringify(arg) + "), " +
                                   JSON.stringify(arg) + ", " +
                                   JSON.stringify(options) + ");");
          zipfile.addBuffer(fs.readFileSync(arg), arg, options);
          break;
        case "addReadStream":
          if (verbose) console.log("addReadStream(fs.createReadStream(" +
                                   JSON.stringify(arg) + "), " +
                                   JSON.stringify(arg) + ", " +
                                   JSON.stringify(options) + ");");
          zipfile.addReadStream(fs.createReadStream(arg), arg, options);
          break;
        default: throw new Error();
      }
    } else if (stats.isDirectory()) {
      if (verbose) console.log("addEmptyDirectory(" +
                               JSON.stringify(arg) + ", ");
      zipfile.addEmptyDirectory(arg);
    } else {
      throw new Error("what is this: " + arg);
    }
  }
});
zipfile.end({forceZip64Format: options.forceZip64Format}, function(finalSize) {
  console.log("finalSize prediction: " + finalSize);
});
