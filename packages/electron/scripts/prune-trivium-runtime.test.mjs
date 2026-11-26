import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import pruneTriviumRuntime from './prune-trivium-runtime.cjs';

test('TriviumDB retains only the target addon on every desktop target', () => {
  const targets = ['linux-x64-gnu', 'linux-arm64-gnu', 'darwin-x64', 'darwin-arm64', 'win32-x64-msvc', 'win32-arm64-msvc'];
  for (const target of targets) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-trivium-payload-'));
    try {
      const directory = path.join(root, 'triviumdb');
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'index.js'), 'loader');
      fs.writeFileSync(path.join(directory, 'LICENSE'), 'license');
      for (const binary of targets) fs.writeFileSync(path.join(directory, `triviumdb.${binary}.node`), binary);
      const [platform, architecture] = target.split('-');
      pruneTriviumRuntime(root, platform, architecture);
      assert.deepEqual(fs.readdirSync(directory).sort(), ['LICENSE', 'index.js', `triviumdb.${target}.node`].sort());
      assert.equal(fs.readFileSync(path.join(directory, `triviumdb.${target}.node`), 'utf8'), target);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('a missing target fails packaging before removing any addons', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-trivium-missing-'));
  try {
    fs.mkdirSync(path.join(root, 'triviumdb'));
    fs.writeFileSync(path.join(root, 'triviumdb', 'triviumdb.darwin-arm64.node'), 'foreign addon');
    assert.throws(() => pruneTriviumRuntime(root, 'linux', 'x64'), /Missing target TriviumDB binary/);
    assert.equal(fs.existsSync(path.join(root, 'triviumdb', 'triviumdb.darwin-arm64.node')), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
