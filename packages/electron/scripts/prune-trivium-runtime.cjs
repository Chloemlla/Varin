const fs = require('node:fs');
const path = require('node:path');

// The npm archive contains several platforms. Ship the target addon's bytes.
module.exports = function pruneTriviumRuntime(modulesRoot, platform, architecture) {
  const suffix = platform === 'win32' ? '-msvc' : platform === 'linux' ? '-gnu' : '';
  const binary = `triviumdb.${platform}-${architecture}${suffix}.node`;
  const root = path.join(modulesRoot, 'triviumdb');
  if (!fs.statSync(path.join(root, binary), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Missing target TriviumDB binary: ${path.join(root, binary)}`);
  }
  for (const name of fs.readdirSync(root)) {
    if (name.endsWith('.node') && name !== binary) fs.rmSync(path.join(root, name));
  }
};
