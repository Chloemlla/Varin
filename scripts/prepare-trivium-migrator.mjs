import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import targets from './kernel-binary-identity.cjs';
import { windowsMsvcEnvironment } from './windows-msvc.cjs';
import release from './trivium-release.json' with { type: 'json' };

const root = path.resolve(import.meta.dirname, '..');

/** Ship the official, revision-matched tool with the Host. The end user needs neither Cargo nor Python. */
export function prepareTriviumMigrator(destination) {
  const platform = process.env.VARIN_TARGET_PLATFORM || process.platform;
  const arch = targets.normalizeKernelArchitecture(process.env.VARIN_TARGET_ARCH || process.arch);
  const target = targets.defaultKernelTargetTriple(platform, arch);
  const filename = 'triviumdb-migrate' + (platform === 'win32' ? '.exe' : '');
  const web = createRequire(path.join(root, 'packages/web/package.json'));
  const installed = web('triviumdb/package.json').version;
  if (installed !== release.version) throw new Error(`Review the TriviumDB migrator revision for ${installed} (pinned to ${release.version})`);
  const cache = path.join(root, 'artifacts/build/tdb-tools', target, release.revision);
  const binary = process.env.VARIN_TDB_MIGRATOR_PREBUILT || path.join(cache, 'bin', filename);
  if (!process.env.VARIN_TDB_MIGRATOR_PREBUILT && !fs.existsSync(binary)) {
    execFileSync('cargo', ['install', '--git', 'https://github.com/Astrmira/TriviumDB.git', '--rev', release.revision,
      '--locked', '--target', target, '--root', cache, 'triviumdb-migrate'], {
      cwd: root, stdio: ['ignore', 2, 2], windowsHide: true,
      env: process.platform === 'win32' ? windowsMsvcEnvironment(arch) : process.env,
    });
  }
  const identity = targets.detectKernelBinaryIdentity(fs.readFileSync(binary));
  if (identity.platform !== platform || identity.arch !== arch) throw new Error(`Wrong TriviumDB migrator target for ${target}: ${binary}`);
  if (destination) {
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(binary, path.join(destination, filename));
    fs.copyFileSync(path.join(path.dirname(web.resolve('triviumdb/package.json')), 'LICENSE'), path.join(destination, 'TriviumDB-LICENSE'));
    if (platform !== 'win32') fs.chmodSync(path.join(destination, filename), 0o755);
  }
  return path.resolve(binary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(prepareTriviumMigrator(process.argv[2]));
}
