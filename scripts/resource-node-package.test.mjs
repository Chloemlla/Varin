import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { checkResourceNodeLock, collectResourceClosure } from './build-resource-node.mjs';
import { verifyInstall } from './verify-resource-node-install.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-resource-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, text) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof text === 'string' ? text : JSON.stringify(text));
  };
  return { root, write };
}

test('resource role follows imports from its emitted entry only and fails closed on unsupported imports', t => {
  const { root, write } = fixture(t);
  write('resource-node.js', "import './owned.js'; import('node:fs');");
  write('owned.js', "export { Router } from 'express'; const asset = new URL('./profile.dat', import.meta.url);");
  write('profile.dat', 'owned');
  write('index.js', "import 'sherpa-onnx-node';");
  const graph = collectResourceClosure(root, ts);
  assert.deepEqual(graph.files, ['owned.js', 'profile.dat', 'resource-node.js']);
  assert.deepEqual(Object.keys(graph.dependencies), ['express']);
  write('owned.js', 'import(selectedPackage);');
  assert.throws(() => collectResourceClosure(root, ts), /Non-literal/);
  write('owned.js', "import 'untracked-resource-dependency';");
  assert.throws(() => collectResourceClosure(root, ts), /not declared/);
  write('owned.js', "import './missing.js';");
  assert.throws(() => collectResourceClosure(root, ts), /Unshippable/);
});

test('Node and the Bun build interpreter trace the same compiled Node role imports', t => {
  const { root, write } = fixture(t);
  const builder = new URL('./build-resource-node.mjs', import.meta.url).href;
  const compile = (name, source) => write(`${name}/resource-node.js`, ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
  }).outputText);
  compile('valid', `import 'node:fs'; import 'ws'; import 'undici'; const sqlite = () => import('node:sqlite');`);
  const invalid = ['bun:sqlite', 'node:ws', 'node:undici'];
  invalid.forEach((name, index) => compile('invalid' + index, `import('${name}');`));
  const script = `import path from 'node:path'; import ts from 'typescript';
    import {collectResourceClosure} from ${JSON.stringify(builder)};
    const trace = folder => collectResourceClosure(path.join(${JSON.stringify(root)}, folder), ts).dependencies;
    const valid = Object.keys(trace('valid'));
    const failures = Array.from({ length: ${invalid.length} }, (_, i) => {
      try { trace('invalid' + i); return null; } catch (error) { return error.message; }
    });
    console.log(JSON.stringify({valid, failures}));`;
  const findBun = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  if (findBun.error?.code === 'ENOENT') { t.skip('Bun build interpreter is unavailable'); return; }
  assert.equal(findBun.status, 0, findBun.stderr);
  for (const executable of [process.execPath, 'bun']) {
    const reply = spawnSync(executable, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(reply.status, 0, reply.stderr);
    assert.deepEqual(JSON.parse(reply.stdout), {
      valid: ['undici', 'ws'], failures: invalid.map(name => 'Unsupported resource-node import: resource-node.js -> ' + name),
    });
  }
});

test('committed resolution locks match their own role manifests', () => {
  for (const role of ['resources', 'browser', 'computer', 'extensions']) checkResourceNodeLock({ role });
});

test('dedicated role closure traces never include an unreferenced role entry', t => {
  const { root, write } = fixture(t);
  write('browser-node.js', "import 'ws';");
  write('computer-node.js', "import './active.js';");
  write('extension-node.js', "import 'tar';");
  write('active.js', "import 'express';");
  write('index.js', "import 'lost-host-only-dependency';");
  assert.deepEqual(collectResourceClosure(root, ts, 'browser-node').files, ['browser-node.js']);
  assert.deepEqual(collectResourceClosure(root, ts, 'computer-node').files, ['active.js', 'computer-node.js']);
  assert.deepEqual(collectResourceClosure(root, ts, 'extension-node').files, ['extension-node.js']);
});

test('installed resource dependency validation rejects missing and unreferenced locked packages', t => {
  const { root, write } = fixture(t);
  const dependencies = { resourceExample: '1.0.0' };
  write('resource-node.json', { role: 'resources', entrypoint: 'packages/web/server/resource-node.js', workspaces: ['web'], dependencies });
  write('bun.lock', { packages: { resourceExample: ['resourceExample@1.0.0'],
    unusedExample: ['unusedExample@1.0.0'] } });
  write('packages/web/package.json', { name: '@varin/web', version: '1.0.0', dependencies });
  assert.throws(() => verifyInstall(root), /cannot resolve resourceExample/);
  write('node_modules/resourceExample/package.json', { name: 'resourceExample', version: '1.0.0' });
  assert.deepEqual(verifyInstall(root), { packages: 1, workspaces: 1 });
  write('node_modules/unusedExample/package.json', { name: 'unusedExample', version: '1.0.0' });
  assert.throws(() => verifyInstall(root), /outside the resource dependency closure/);
});
