// This module is inspired by bl by Rod Vagg. https://github.com/rvagg/bl

const {Duplex} = require("node:stream");
class BufferList extends Duplex {
  constructor(endCallback) {
    super();
    this.endCallback = endCallback;
    this.chunks = [];
  }

  append(chunk) {
    this.chunks.push(chunk);
    return this;
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(chunk);
    callback();
  }
  _final(callback) {
    if (this.endCallback != null) {
      // Collect all the buffered data and provide it as a single buffer.
      this.endCallback(null, Buffer.concat(this.chunks));
    }
    callback();
  }

  _read(size) {
    this.push(Buffer.concat(this.chunks));
    this.push(null);
  }
}

module.exports = BufferList;
