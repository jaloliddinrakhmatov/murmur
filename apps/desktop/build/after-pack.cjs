// electron-builder afterPack hook: removes extended attributes (Finder info, provenance) that
// the copied Electron framework carries, which `codesign` refuses ("detritus not allowed").
// Touches only the packaged copy in release/, never node_modules.
const { execFileSync } = require("node:child_process");

exports.default = async function afterPack(context) {
  execFileSync("xattr", ["-cr", context.appOutDir]);
};
