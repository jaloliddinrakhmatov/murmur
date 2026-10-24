// Loads the prebuilt addon. N-API is ABI-stable, so the same file loads in Node and Electron.
const path = require("node:path");

module.exports = require(path.join(__dirname, "murmur_native.node"));
