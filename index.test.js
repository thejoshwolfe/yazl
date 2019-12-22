import fs from 'fs';
import * as yazl from '.';
import * as yauzl from 'yauzl';
import BufferList from 'bl';

const weirdChars = '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

const bufferFrom = (something, encoding) => {
  try {
    return Buffer.from(something, encoding);
  } catch {
    return new Buffer(something, encoding);
  }
}


describe('yazl', () => {
  it('1', async () => {
    const fileMetadata = {
      mtime: new Date(),
      mode: 0o100664,
    };
    const zipfile = new yazl.ZipFile();
    zipfile.addFile(__filename, "unicōde.txt");
    zipfile.addFile(__filename, "without-compression.txt", { compress: false });
    zipfile.addReadStream(fs.createReadStream(__filename), "readStream.txt", fileMetadata);
    const expectedContents = fs.readFileSync(__filename);
    zipfile.addBuffer(expectedContents, "with/directories.txt", fileMetadata);
    zipfile.addBuffer(expectedContents, "with\\windows-paths.txt", fileMetadata);
    await expect(new Promise((resolve, reject) => {
      zipfile.end(finalSize => {
        if (finalSize !== -1)
          return reject(new Error("finalSize is impossible to know before compression"));
        zipfile.outputStream.pipe(new BufferList((err, data) => {
          if (err)
            return reject(err);
          yauzl.fromBuffer(data, (err, zipfile) => {
            if (err)
              return reject(err);
            zipfile.on("entry", entry => {
              zipfile.openReadStream(entry, (err, readStream) => {
                if (err)
                  return reject(err);
                readStream.pipe(new BufferList((err, data) => {
                  if (err)
                    return reject(err);
                  if (expectedContents.toString("binary") !== data.toString("binary"))
                    return reject(new Error("unexpected contents"));
                  resolve(true);
                }));
              });
            });
          });
        }));
      });
    })).resolves.toBe(true);
  });

  it('2: zip64 - correct sizes', async () => {
    const zip64Combinations = [
      [0, 0, 0, 0, 0],
      [1, 1, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 1, 0],
      [0, 0, 0, 0, 1],
      [1, 1, 1, 1, 1],
    ];

    await expect(Promise.all(zip64Combinations.map(zip64Config => {
      const options = {
        compress: false,
        size: null,
        forceZip64Format: false,
      };
      const zipfile = new yazl.ZipFile();
      options.forceZip64Format = !!zip64Config[0];
      zipfile.addFile(__filename, "asdf.txt", options);
      options.forceZip64Format = !!zip64Config[1];
      zipfile.addFile(__filename, "fdsa.txt", options);
      options.forceZip64Format = !!zip64Config[2];
      zipfile.addBuffer(bufferFrom("buffer"), "buffer.txt", options);
      options.forceZip64Format = !!zip64Config[3];
      options.size = "stream".length;
      zipfile.addReadStream(new BufferList().append("stream"), "stream.txt", options);
      options.size = null;
      return new Promise((resolve, reject) => {
        zipfile.end({ forceZip64Format: !!zip64Config[4] }, finalSize => {
          if (finalSize === -1)
            return reject(new Error("finalSize should be known"));
          zipfile.outputStream.pipe(new BufferList((err, data) => {
            if (data.length !== finalSize)
              return reject(new Error("finalSize prediction is wrong. " + finalSize + " !== " + data.length));
            resolve(true);
          }));
        });
      });
    }))).resolves.toStrictEqual([true, true, true, true, true, true]);
  });

  it('3: Optional Parameters & Directories', async () => {
    const zipfile = new yazl.ZipFile();
    // all options parameters are optional
    zipfile.addFile(__filename, "a.txt");
    zipfile.addBuffer(bufferFrom("buffer"), "b.txt");
    zipfile.addReadStream(new BufferList().append("stream"), "c.txt");
    zipfile.addEmptyDirectory("d/");
    zipfile.addEmptyDirectory("e");
    await expect(new Promise((resolve, reject) => {
      zipfile.end(finalSize => {
        if (finalSize !== -1)
          return reject(new Error("finalSize should be unknown"));
        zipfile.outputStream.pipe(new BufferList((err, data) => {
          if (err) return reject(err);
          yauzl.fromBuffer(data, (err, zipfile) => {
            if (err) return reject(err);
            const entryNames = ["a.txt", "b.txt", "c.txt", "d/", "e/"];
            zipfile.on("entry", entry => {
              const expectedName = entryNames.shift();
              if (entry.fileName !== expectedName) {
                return reject(new Error("unexpected entry fileName: " + entry.fileName + ", expected: " + expectedName));
              }
            });
            zipfile.on("end", () => {
              if (entryNames.length === 0)
                return resolve(true);
            });
          });
        }));
      });
    })).resolves.toBe(true);
  });

  it('4: justAddBuffer', async () => {
    const zipfile = new yazl.ZipFile();
    // all options parameters are optional
    zipfile.addBuffer(bufferFrom("hello"), "hello.txt", { compress: false });
    await expect(new Promise((resolve, reject) => {
      zipfile.end(finalSize => {
        if (finalSize === -1)
          return reject(new Error("finalSize should be known"));
        zipfile.outputStream.pipe(new BufferList((err, data) => {
          if (err)
            return reject(err);
          if (data.length !== finalSize)
            return reject(new Error("finalSize prediction is wrong. " + finalSize + " !== " + data.length));
          yauzl.fromBuffer(data, (err, zipfile) => {
            if (err)
              return reject(err);
            const entryNames = ["hello.txt"];
            zipfile.on("entry", entry => {
              const expectedName = entryNames.shift();
              if (entry.fileName !== expectedName) {
                return reject(new Error("unexpected entry fileName: " + entry.fileName + ", expected: " + expectedName));
              }
            });
            zipfile.on("end", () => {
              if (entryNames.length === 0)
                return resolve(true);
            });
          });
        }));
      });
    })).resolves.toBe(true);
  });

  it('5: Comments', async () => {
    const testCases = [
      ["Hello World", "Hello World"],
      [bufferFrom("Hello"), "Hello"],
      [weirdChars, weirdChars],
    ];
    await expect(Promise.all(testCases.map((testCase, i) => {
      const zipfile = new yazl.ZipFile();
      return new Promise((resolve, reject) => {
        zipfile.end({
          comment: testCase[0],
        }, finalSize => {
          if (finalSize === -1)
            return reject(new Error("finalSize should be known"));
          zipfile.outputStream.pipe(new BufferList((err, data) => {
            if (err)
              return reject(err);
            if (data.length !== finalSize)
              return reject(new Error("finalSize prediction is wrong. " + finalSize + " !== " + data.length));
            yauzl.fromBuffer(data, (err, zipfile) => {
              if (err)
                return reject(err);
              if (zipfile.comment !== testCase[1]) {
                return reject(new Error("comment is wrong. " + JSON.stringify(zipfile.comment) + " !== " + JSON.stringify(testCase[1])));
              }
              return resolve(true);
            });
          }));
        });
      });
    }))).resolves.toBeInstanceOf(Array);
  });

  it('6: Comment with end of central directory record signature', () => {
    const zipfile = new yazl.ZipFile();
    try {
      zipfile.end({
        comment: bufferFrom("01234567890123456789" + "\x50\x4b\x05\x06" + "01234567890123456789")
      });
      fail(new Error("expected error for including eocdr signature in comment"));
    } catch (e) {
      expect(e.toString())
        .toContain("comment contains end of central directory record signature");
    }
  });

  it('7: File Comments', async () => {
    const testCases = [
      ["Hello World!", "Hello World!"],
      [bufferFrom("Hello!"), "Hello!"],
      [weirdChars, weirdChars],
    ];
    await expect(Promise.all(testCases.map((testCase, i) => {
      const zipfile = new yazl.ZipFile();
      // all options parameters are optional
      zipfile.addBuffer(bufferFrom("hello"), "hello.txt", { compress: false, fileComment: testCase[0] });
      return new Promise((resolve, reject) => {
        zipfile.end(finalSize => {
          if (finalSize === -1)
            return reject(new Error("finalSize should be known"));
          zipfile.outputStream.pipe(new BufferList((err, data) => {
            if (err)
              return reject(err);
            if (data.length !== finalSize)
              return reject(new Error("finalSize prediction is wrong. " + finalSize + " !== " + data.length));
            yauzl.fromBuffer(data, (err, zipfile) => {
              if (err)
                return reject(err);
              zipfile.on("entry", entry => {
                if (entry.fileComment !== testCase[1]) {
                  return reject(new Error("fileComment is wrong. " + JSON.stringify(entry.fileComment) + " !== " + JSON.stringify(testCase[1])));
                }
              });
              zipfile.on("end", () => {
                return resolve(true);
              });
            });
          }));
        });
      });
    }))).resolves.toStrictEqual([true, true, true]);
  });
});
