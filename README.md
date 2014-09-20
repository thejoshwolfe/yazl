# yazl

yet another zip library for node

Design principles:

 * Don't block the JavaScript thread.
   Use and provide async APIs.
 * Keep memory usage under control.
   Don't attempt to buffer entire files in RAM at once.

## Usage

```js
var yazl = require("yazl");

var zipfile = new yazl.ZipFile();
zipfile.addFile("file1.txt", "file1.txt");
// (add only files, not directories)
zipfile.addFile("path/to/file.txt", "path/in/zipfile.txt");
// pipe() can be called any time after the constructor
zipfile.outputStream.pipe(fs.createWriteStream("output.zip")).on("finish", function() {
  console.log("done");
});
// alternate apis for adding files:
zipfile.addReadStream(process.stdin, "stdin.txt", {
  mtime: new Date(),
  mode: 0100664, // -rw-rw-r--
});
zipfile.addBuffer(new Buffer("hello"), "hello.txt", {
  mtime: new Date(),
  mode: 0100664, // -rw-rw-r--
});
// call end() after all the files have been added
zipfile.end();
```

## API

### Class: ZipFile

#### new ZipFile()

No parameters.
Nothing can go wrong.

#### addFile(realPath, metadataPath, [options])

Adds a file from the file system at `realPath` into the zipfile as `metadataPath`.
Typically `metadataPath` would be calculated as `path.relative(root, realPath)`.
Unzip programs would extract the file from the zipfile as `metadataPath`.
`realPath` is not stored in the zipfile.

This function throws an error if `metadataPath` starts with `"/"` or `/[A-Za-z]:\//`
or if it contains `".."` path segments or `"\\"`.
These would be illegal file names according to the spec.

`options` may be omitted or null has the following structure and default values:

```js
{
  mtime: stats.mtime, // optional
  mode: stats.mode,   // optional
}
```

Use `options.mtime` and/or `options.mode` to override the values
that would normally be obtained by the `fs.Stats` for the `realPath`.
The mtime and mode (unix permission bits and file type) are stored in the zip file
in the fields "last mod file time", "last mod file date", and "external file attributes".
yazl does not store group and user ids in the zip file.

Internally, `fs.open()` is called immediately in the `addFile` function,
and the fd obtained is later used for getting stats and file data.
So theoretically, clients could delete the file from the file system immediately after calling this function,
and yazl would be able to function without any trouble.

#### addReadStream(readStream, metadataPath, options)

Adds a file to the zip file whose content is read from `readStream`.
See `addFile()` for info about the `metadataPath` parameter.
`options` is an `Object` and has the following structure:

```js
{
  mtime: new Date(), // required
  mode: 0100664,     // required
  size: 12345,       // optional
}
```

See `addFile()` for the meaning of `mtime` and `mode`.
If `size` is given, it will be checked against the actual number of bytes in the `readStream`,
and an error will be emitted if there is a mismatch.

#### addBuffer(buffer, metadataPath, options)

Adds a file to the zip file whose content is `buffer`.
See `addFile()` for info about the `metadataPath` parameter.
`options` is an `Object` and has the following structure:

```js
{
  mtime: new Date(), // required
  mode: 0100664,     // required
}
```

See `addFile()` for the meaning of `mtime` and `mode`.

#### end()

Indicates that no more files will be added via `addFile()`, `addReadStream()`, or `addBuffer()`.
Some time after calling this function, `outputStream` will be ended.

#### outputStream

A readable stream that will produce the contents of the zip file.
It is typical to pipe this stream to a writable stream created from `fs.createWriteStream()`.

Internally, large amounts of file data are piped to `outputStream` using `pipe()`,
which means throttling happens appropriately when this stream is piped to a slow destination.

Data becomes available in this stream soon after calling `addFile()` or the like for the first time.
Clients can call `pipe()` on this stream immediately after getting a new `ZipFile` instance.
It is not necessary to add all files and call `end()` before calling `pipe()` on this stream.

### dateToDosDateTime(jsDate)

`jsDate` is a `Date` instance.
Returns `{date: date, time: time}`, where `date` and `time` are unsigned 16-bit integers.

## Output Structure

The Zip File Spec leaves a lot of flexibility up to the zip file creator.
This section explains and justifies yazl's interpretation and decisions regarding this flexibility.

This section is probably not useful to yazl clients,
but may be interesting to unzip implementors and zip file enthusiasts.

### Disk Numbers

All values related to disk numbers are `0`,
because yazl has no multi-disk archive support.

### Version Made By

Always `0x031e`.
This is the value reported by a Linux build of Info-Zip.
Instead of experimenting with different values of this field
to see how different unzip clients would behave,
yazl mimics Info-Zip, which should work everywhere.

Note that the top byte means "UNIX"
and has implications in the External File Attributes.

### Version Needed to Extract

Always `0x0014`.
Without this value, Info-Zip, and possibly other unzip implementations,
refuse to acknowledge General Purpose Bit `8`, which enables utf8 filename encoding.

### General Purpose Bit Flag

Bit `8` is always set.
Filenames are always encoded in utf8, even if the result is indistinguishable from ascii.

Bit `3` is set in the Local File Header.
To support both a streaming input and streaming output api,
it is impossible to know the crc32 before processing the file data.
File Descriptors are given after each file data with this information, as per the spec.
But remember a complete metadata listing is still always available in the central directory record,
so if unzip implementations are relying on that, like they should,
none of this paragraph will matter anyway.

All other bits are unset.

### Internal File Attributes

Always `0`.
The "apparently an ASCII or text file" bit is always unset meaning "apparently binary".
This kind of determination is outside the scope of yazl,
and is probably not significant in any modern unzip implementation.

### External File Attributes

Always `stats.mode << 16`.
This is apparently the convention for "version made by" = `0x03xx` (UNIX).
