(function (root, factory) {
  "use strict";

  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.MaterialBatchSha256 = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var ROUND_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function rotateRight(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
  }

  function asBytes(input) {
    if (input instanceof Uint8Array) return input;

    if (typeof ArrayBuffer !== "undefined" && input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }

    if (typeof ArrayBuffer !== "undefined"
        && typeof ArrayBuffer.isView === "function"
        && ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }

    throw new TypeError("SHA-256 输入必须是 Uint8Array、ArrayBuffer 或 ArrayBufferView");
  }

  function Sha256Hasher() {
    this.state = new Uint32Array([
      0x6a09e667,
      0xbb67ae85,
      0x3c6ef372,
      0xa54ff53a,
      0x510e527f,
      0x9b05688c,
      0x1f83d9ab,
      0x5be0cd19,
    ]);
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.bytesLow = 0;
    this.bytesHigh = 0;
    this.words = new Uint32Array(64);
    this.finished = false;
    this.hexDigest = "";
  }

  Sha256Hasher.prototype.addLength = function (byteLength) {
    var lowPart = byteLength >>> 0;
    var highPart = Math.floor(byteLength / 0x100000000) >>> 0;
    var sum = this.bytesLow + lowPart;
    var carry = sum >= 0x100000000 ? 1 : 0;

    this.bytesLow = sum >>> 0;
    this.bytesHigh = (this.bytesHigh + highPart + carry) >>> 0;
  };

  Sha256Hasher.prototype.compress = function (bytes, offset) {
    var words = this.words;
    var index;

    for (index = 0; index < 16; index += 1) {
      var byteIndex = offset + (index * 4);
      words[index] = (
        (bytes[byteIndex] << 24)
        | (bytes[byteIndex + 1] << 16)
        | (bytes[byteIndex + 2] << 8)
        | bytes[byteIndex + 3]
      ) >>> 0;
    }

    for (index = 16; index < 64; index += 1) {
      var word15 = words[index - 15];
      var word2 = words[index - 2];
      var sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      var sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    var a = this.state[0];
    var b = this.state[1];
    var c = this.state[2];
    var d = this.state[3];
    var e = this.state[4];
    var f = this.state[5];
    var g = this.state[6];
    var h = this.state[7];

    for (index = 0; index < 64; index += 1) {
      var sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      var choose = (e & f) ^ (~e & g);
      var temporary1 = (h + sum1 + choose + ROUND_CONSTANTS[index] + words[index]) >>> 0;
      var sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      var majority = (a & b) ^ (a & c) ^ (b & c);
      var temporary2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  };

  Sha256Hasher.prototype.update = function (input) {
    if (this.finished) {
      throw new Error("SHA-256 摘要已完成，不能继续更新");
    }

    var bytes = asBytes(input);
    var length = bytes.byteLength;
    var offset = 0;
    this.addLength(length);

    if (this.bufferLength > 0) {
      var missing = 64 - this.bufferLength;
      var copied = Math.min(missing, length);
      this.buffer.set(bytes.subarray(0, copied), this.bufferLength);
      this.bufferLength += copied;
      offset += copied;

      if (this.bufferLength === 64) {
        this.compress(this.buffer, 0);
        this.bufferLength = 0;
      }
    }

    while (offset + 64 <= length) {
      this.compress(bytes, offset);
      offset += 64;
    }

    if (offset < length) {
      this.buffer.set(bytes.subarray(offset), 0);
      this.bufferLength = length - offset;
    }

    return this;
  };

  function wordToHex(word) {
    var hex = (word >>> 0).toString(16);
    return "00000000".slice(hex.length) + hex;
  }

  Sha256Hasher.prototype.digestHex = function () {
    if (this.finished) return this.hexDigest;

    var bitLow = (this.bytesLow << 3) >>> 0;
    var bitHigh = ((this.bytesHigh << 3) | (this.bytesLow >>> 29)) >>> 0;
    var buffer = this.buffer;
    var offset = this.bufferLength;

    buffer[offset] = 0x80;
    offset += 1;

    if (offset > 56) {
      buffer.fill(0, offset, 64);
      this.compress(buffer, 0);
      offset = 0;
    }

    buffer.fill(0, offset, 56);
    buffer[56] = bitHigh >>> 24;
    buffer[57] = bitHigh >>> 16;
    buffer[58] = bitHigh >>> 8;
    buffer[59] = bitHigh;
    buffer[60] = bitLow >>> 24;
    buffer[61] = bitLow >>> 16;
    buffer[62] = bitLow >>> 8;
    buffer[63] = bitLow;
    this.compress(buffer, 0);

    var output = "";
    for (var index = 0; index < this.state.length; index += 1) {
      output += wordToHex(this.state[index]);
    }

    this.finished = true;
    this.hexDigest = output;
    return output;
  };

  function createHasher() {
    return new Sha256Hasher();
  }

  function hashHex(bytes) {
    return createHasher().update(bytes).digestHex();
  }

  return {
    createHasher: createHasher,
    hashHex: hashHex,
  };
});
