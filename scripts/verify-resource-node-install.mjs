import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));

export function verifyInstall(root = process.cwd()) {
  const runtime = read(path.join(root, 'resource-node.json'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'bun.lock'), 'utf8').replace(/,(\s*[}\]])/g, '$1'));
  const locked = new Set(Object.values(lock.packages).filter(entry => Array.isArray(entry)).map(entry => entry[0]));
  const workspace = new Set(runtime.workspaces.map(directory => fs.realpathSync(path.join(root, 'packages', directory))));
  const visited = new Set();
  function resolveDependency(name, from) {
    for (let directory = from; ; directory = path.dirname(directory)) {
      if (path.basename(directory) !== 'node_modules') {
        const target = path.join(directory, 'node_modules', name);
        if (fs.existsSync(path.join(target, 'package.json'))) return fs.realpathSync(target);
      }
      if (directory === root || directory === path.dirname(directory)) return null;
    }
  }
  function visit(directory) {
    if (visited.has(directory)) return;
    assert(directory.startsWith(root + path.sep), `Resource dependency resolves outside its package: ${directory}`);
    visited.add(directory);
    const p = read(path.join(directory, 'package.json'));
    if (!workspace.has(directory)) {
      assert(locked.has(`${p.name}@${p.version}`), `Unlocked installed package: ${p.name}@${p.version}`);
    }
    for (const name of new Set([...Object.keys(p.dependencies ?? {}), ...Object.keys(p.optionalDependencies ?? {}),
      ...Object.keys(p.peerDependencies ?? {})])) {
      const target = resolveDependency(name, directory);
      // Optional native variants are represented by the same role lock on all platforms.
      const required = name in (p.dependencies ?? {}) && !(name in (p.optionalDependencies ?? {}));
      if (!target) { assert(!required, `${p.name} cannot resolve ${name}`); continue; }
      visit(target);
    }
  }
  for (const dir of workspace) visit(dir);

  // Walk Bun's install roots (both isolated store and workspace-facing links).
  // Only descend into Node package layouts, not dependency-owned vendored assets.
  const observed = new Set();
  function inspect(modules) {
    if (!fs.existsSync(modules)) return;
    const group = (folder) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const p = path.join(folder, entry.name);
        if (entry.name.startsWith('@') && entry.isDirectory()) { group(p); continue; }
        if (!fs.existsSync(path.join(p, 'package.json'))) continue;
        const resolved = fs.realpathSync(p);
        if (observed.has(resolved)) continue;
        observed.add(resolved);
        inspect(path.join(resolved, 'node_modules'));
      }
    };
    group(modules);
    const store = path.join(modules, '.bun');
    if (fs.existsSync(store)) for (const name of fs.readdirSync(store)) inspect(path.join(store, name, 'node_modules'));
  }
  inspect(path.join(root, 'node_modules'));
  for (const dir of workspace) inspect(path.join(dir, 'node_modules'));
  for (const dir of observed) assert(visited.has(dir), `Installed package is outside the resource dependency closure: ${dir}`);
  const entries = { resources: 'resource-node', browser: 'browser-node', computer: 'computer-node' };
  assert(Object.hasOwn(entries, runtime.role), 'Unexpected dedicated node role');
  assert.equal(runtime.entrypoint, `packages/web/server/${entries[runtime.role]}.js`);
  assert.deepEqual(runtime.dependencies, read(path.join(root, 'packages/web/package.json')).dependencies);
  const otherEntries = Object.entries(entries).filter(([role]) => role !== runtime.role)
    .map(([, name]) => `packages/web/server/${name}.js`);
  for (const p of ['packages/web/dist', 'packages/web/bin', 'packages/web/server/index.js', ...otherEntries]) {
    assert(!fs.existsSync(path.join(root, p)), `Unexpected Host asset in resource node: ${p}`);
  }
  return { packages: visited.size - workspace.size, workspaces: workspace.size };
}

export async function verifyKernelBundle(root) {
  const web = path.join(root, 'packages/web');
  const directory = path.join(web, 'kernel');
  const manifest = read(path.join(directory, 'manifest.json'));
  assert.equal(manifest.buildIdentity, read(path.join(web, 'package.json')).version, 'Resource Node kernel build mismatch');
  assert.equal(manifest.platform, process.platform, 'Resource Node kernel platform mismatch');
  assert.equal(manifest.arch, process.arch, 'Resource Node kernel architecture mismatch');
  const expected = process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel';
  assert.equal(manifest.executable, expected);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(path.join(directory, expected))) hash.update(chunk);
  assert.equal(hash.digest('hex'), manifest.sha256, 'Resource Node kernel checksum mismatch');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  console.log('Verified resource node installed dependency closure:', verifyInstall(root));
  // Resolve the real compiled module under TARGETPLATFORM, not a graph-only fixture.
  await verifyKernelBundle(root);
  const manifest = read(path.join(root, 'resource-node.json'));
  if (manifest.role === 'computer') {
    const platform = { linux: 'linux/driver-host.py', darwin: 'macos/Varin Computer.app/Contents/MacOS/VarinComputer',
      win32: 'windows/VarinComputer.exe' }[process.platform];
    assert(platform && fs.existsSync(path.join(root, 'packages/web/server/computer-driver', platform)), 'Missing platform Computer driver');
  }
  await import(pathToFileURL(path.join(root, manifest.entrypoint)).href);
}
