import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'vitest';

const wait = async (predicate) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await setTimeout(25);
  }
  assert.fail('Timed out waiting for fixture output');
};

test('real dev/build launchers use the correct owner while reclaiming an exited Host', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'varin-host-generations-'));
  const web = path.join(repo, 'packages/web');
  const children = new Set();
  const write = (name, text) => {
    const destination = path.join(repo, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, text);
  };
  const copy = (name) => {
    const target = path.join(web, 'scripts', name);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(import.meta.dirname, name), target);
  };
  const run = (name, args = []) => {
    const child = spawn(process.execPath, [path.join(web, 'scripts', name), ...args], { cwd: web, env: { ...process.env, VARIN_TARGET_PLATFORM: 'linux' } });
    children.add(child);
    let log = '';
    child.stdout.on('data', (text) => { log += text; });
    child.stderr.on('data', (text) => { log += text; });
    const finished = once(child, 'exit');
    return { child, finished, log: () => log };
  };
  try {
    write('package.json', '{"type":"module"}');
    write('packages/web/package.json', '{"version":"0.0.0"}');
    for (const file of ['build-application-host.mjs', 'application-host-generations.mjs', 'run-application-host-dev.mjs']) copy(file);
    write('packages/web/scripts/copy-structure-runtime.mjs', '');
    write('scripts/host-production-boundary.mjs', 'export const pruneLegacyHostArtifacts = () => ({runtimeModules:2, removedArtifacts:0});');
    write('scripts/prepare-trivium-migrator.mjs', 'export const prepareTriviumMigrator = () => {};');
    write('packages/computer-driver/windows/build-helper.mjs', 'export const buildWindowsComputerHelper = () => {};');
    write('packages/computer-driver/macos/build-helper.mjs', 'export const buildMacComputerHelper = () => {};');
    write('packages/computer-driver/linux/driver', 'stub');
    write('packages/browser-connector/extension/manifest.json', '{}');
    write('node_modules/typescript/package.json', '{"type":"module"}');
    write('node_modules/typescript/lib/tsc.js', `
      import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
      const dir = process.argv[process.argv.indexOf('--outDir') + 1];
      mkdirSync(dir, {recursive:true});
      writeFileSync(dir + '/compiling', String(process.pid));
      while (!existsSync('allow-build')) await new Promise(r => setTimeout(r, 10));
      writeFileSync(dir + '/index.js', 'setInterval(() => {}, 1000);');
      writeFileSync(dir + '/index.d.ts', '');
      writeFileSync(dir + '/public-contract.js', '');
    `);
    write('packages/web/allow-build', 'ready');
    const old = run('run-application-host-dev.mjs');
    const oldGeneration = path.join(web, `.application-host-dev-${old.child.pid}`);
    await wait(() => existsSync(path.join(oldGeneration, 'index.js')));
    old.child.kill('SIGKILL');
    await old.finished;
    assert.ok(existsSync(oldGeneration), 'killed Hosts leave a generation to reclaim');

    rmSync(path.join(web, 'allow-build'));
    const watch = run('run-application-host-dev.mjs');
    const one = run('build-application-host.mjs', ['--output', path.join(web, 'out-one')]);
    const two = run('build-application-host.mjs', ['--output', path.join(web, 'out-two')]);
    const watchGeneration = path.join(web, `.application-host-dev-${watch.child.pid}`);
    await wait(() => readdirSync(web).filter(name => name.startsWith('.application-host-staging-')).length === 3);
    assert.ok(!existsSync(watchGeneration), 'partial staging must not appear at the Host-owned path');
    assert.ok(!existsSync(oldGeneration), 'the abandoned generation is reclaimed');
    for (const building of [one, two]) {
      assert.ok(existsSync(path.join(web, `.application-host-staging-${building.child.pid}`)));
    }
    write('packages/web/allow-build', 'ready');
    for (const building of [one, two]) assert.equal((await building.finished)[0], 0, building.log());
    await wait(() => existsSync(path.join(watchGeneration, 'index.js')));
    assert.ok(existsSync(path.join(web, 'out-one', 'index.js')));
    assert.ok(existsSync(path.join(web, 'out-two', 'index.js')));
    const clean = run('build-application-host.mjs', ['--clean']);
    assert.equal((await clean.finished)[0], 0, clean.log());
    assert.ok(existsSync(watchGeneration), 'cleanup must not touch a running Watch Host');
  } finally {
    write('packages/web/allow-build', 'ready');
    await Promise.all([...children].map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    rmSync(repo, { recursive: true, force: true });
  }
});
