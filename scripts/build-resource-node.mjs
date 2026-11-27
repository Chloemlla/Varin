#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const roleEntry = { resources: 'resource-node', browser: 'browser-node', computer: 'computer-node', extensions: 'extension-node' };
function selectRole(role) {
  if (!Object.hasOwn(roleEntry, role)) throw new Error('Unknown dedicated node role');
  const basename = roleEntry[role];
  return { basename, entrypoint: `packages/web/server/${basename}.js`, lockPath: path.join(root, `scripts/${basename}.bun.lock`) };
}
const original = (relative) => path.join(root, relative);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, json) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
};
const readLock = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/,(\s*[}\]])/g, '$1'));
const packageName = specifier => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
const sort = entries => Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
const stableValue = object => JSON.stringify(sort(object || {}));
const run = (cwd, command, args) => {
  const out = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (out.error || out.status !== 0) throw out.error ?? new Error(`${command} exited ${out.status}`);
};

// BuildKit compiles the Host in oven/bun, but deployed roles execute on Node.
// Bun treats several npm packages and its own runtime as builtins. Those are
// not part of the role's Node module namespace. Explicit Node-only modules
// are present in Node releases even where the builder does not implement them.
const builderOnlyBuiltins = new Set(['bun', 'ws', 'undici']);
const explicitNodeBuiltins = new Set(['node:sea', 'node:sqlite', 'node:test', 'node:test/reporters']);
function isRoleBuiltin(specifier) {
  const name = specifier.replace(/^node:/u, '');
  return explicitNodeBuiltins.has(specifier) ||
    !builderOnlyBuiltins.has(name) && !name.startsWith('bun:') && isBuiltin(specifier);
}

export function collectResourceClosure(serverDir, ts, basename = 'resource-node') {
  const seen = new Set();
  const references = new Set();
  const assetFiles = new Set();
  const { dependencies: declared } = readJson(original('packages/web/package.json'));
  function visit(filename) {
    if (seen.has(filename)) return;
    seen.add(filename);
    const source = ts.createSourceFile(filename, fs.readFileSync(path.join(serverDir, filename), 'utf8'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function handle(specifier) {
      // A declared bare production import must be included even when the
      // current interpreter happens to bundle an emulation of that package.
      if (!/^[./#]|:/u.test(specifier) && Object.hasOwn(declared, packageName(specifier))) {
        references.add(packageName(specifier));
        return;
      }
      if (isRoleBuiltin(specifier)) return;
      if (specifier.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier));
        if (target === '../package.json') return;
        if (target.startsWith('..') || !fs.existsSync(path.join(serverDir, target))) {
          throw new Error(`Unshippable resource-node import: ${filename} -> ${specifier}`);
        }
        if (/\.[cm]?js$/.test(target)) visit(target);
        else assetFiles.add(target);
      } else if (specifier.startsWith('#') || specifier.startsWith('/') || specifier.includes(':')) {
        throw new Error(`Unsupported resource-node import: ${filename} -> ${specifier}`);
      } else references.add(packageName(specifier));
    }
    const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
    const isCreateRequire = node => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'createRequire';
    const requireNames = new Set(['require']);
    function findRequireBindings(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isCreateRequire(node.initializer)) {
        requireNames.add(node.name.text);
      }
      ts.forEachChild(node, findRequireBindings);
    }
    findRequireBindings(source);
    function walk(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) handle(node.moduleSpecifier.text);
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const resolved = ts.isPropertyAccessExpression(expression) && expression.name.text === 'resolve'
          && ((ts.isIdentifier(expression.expression) && requireNames.has(expression.expression.text))
            || (ts.isMetaProperty(expression.expression) && expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword));
        const imported = expression.kind === ts.SyntaxKind.ImportKeyword || isCreateRequire(expression) || resolved
          || (ts.isIdentifier(expression) && requireNames.has(expression.text));
        if (imported) {
          const specifier = literal(node.arguments[0]);
          if (specifier !== null) handle(specifier);
          // This helper resolves an optional architecture child of the statically
          // declared @vscode/ripgrep package, not an arbitrary external module.
          else if (!(resolved && filename === 'lib/platform/bundled-tools.js'
            && ts.isTemplateExpression(node.arguments[0]) && node.arguments[0].head.text === '@vscode/ripgrep-')) {
            throw new Error(`Non-literal resource-node import in ${filename}; stage its runtime closure explicitly`);
          }
        }
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
        && node.arguments?.[1]?.getText(source) === 'import.meta.url') {
        const relative = literal(node.arguments[0]);
        if (relative?.startsWith('.')) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), relative));
          if (target !== '../package.json') {
            const asset = path.join(serverDir, target);
            // Kernel release assets are staged separately under packages/web/kernel.
            if (target.startsWith('../kernel/')) { /* packaged with the kernel */ }
            else if (basename === 'computer-node' && filename === 'lib/computer/driver-host.js' &&
              (target === 'computer-driver' || target === '../../computer-driver')) { /* target driver staged separately */ }
            else if (target.startsWith('..') || !fs.existsSync(asset)) throw new Error(`Unshippable node asset: ${filename} -> ${relative}`);
            else if (/\.[cm]?js$/.test(target)) visit(target);
            else assetFiles.add(target);
          }
        }
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  visit(`${basename}.js`);
  const dependencies = {};
  for (const name of references) {
    if (!Object.hasOwn(declared, name)) throw new Error(`Resource-node dependency not declared by Web: ${name}`);
    dependencies[name] = declared[name];
  }
  return { files: [...seen, ...assetFiles].sort(), dependencies: sort(dependencies) };
}

function roleManifests(dependencies, basename) {
  const manifest = readJson(original('package.json'));
  const host = readJson(original('packages/web/package.json'));
  const packages = new Map([['web', { name: host.name, version: host.version, type: 'module', private: true, dependencies }]]);
  function visit(deps) {
    for (const name of Object.keys(deps)) {
      if (!name.startsWith('@varin/')) continue;
      const directory = name.slice('@varin/'.length);
      if (packages.has(directory)) continue;
      const workspace = readJson(original(`packages/${directory}/package.json`));
      if (workspace.name !== name) throw new Error(`Unexpected workspace manifest for ${name}`);
      const { devDependencies, scripts, ...production } = workspace;
      packages.set(directory, { ...production, private: true });
      visit(production.dependencies ?? {});
    }
  }
  visit(dependencies);
  return {
    packages,
    rootPackage: {
      name: `varin-${basename}`, private: true, type: 'module', license: manifest.license,
      version: manifest.version, packageManager: manifest.packageManager, engines: manifest.engines,
      workspaces: ['packages/*'], overrides: manifest.overrides, trustedDependencies: [],
      patchedDependencies: Object.fromEntries(['braces@3.0.3', 'picomatch@4.0.7']
        .filter(key => manifest.patchedDependencies[key])
        .map(key => [key, manifest.patchedDependencies[key]])),
    },
  };
}
export function validateResourceNodeLock(output) {
  const runtime = readJson(path.join(output, 'resource-node.json'));
  const lock = readLock(path.join(output, 'bun.lock'));
  const manifest = readJson(path.join(output, 'package.json'));
  const resolutions = new Set(Object.values(lock.packages ?? {}).map(pkg => pkg[0]));
  const applicablePatches = Object.fromEntries(Object.entries(manifest.patchedDependencies ?? {})
    .filter(([packageVersion]) => resolutions.has(packageVersion)));
  if (stableValue(lock.overrides) !== stableValue(manifest.overrides)
      || stableValue(lock.patchedDependencies) !== stableValue(applicablePatches)
      || lock.workspaces?.['']?.name !== manifest.name
      || Object.keys(lock.workspaces).length !== runtime.workspaces.length + 1) {
    throw new Error('Resource-node root lock disagrees with the role manifest');
  }
  for (const directory of runtime.workspaces) {
    const owner = readJson(path.join(output, 'packages', directory, 'package.json'));
    const staged = lock.workspaces?.[`packages/${directory}`];
    if (staged?.version !== owner.version || staged.name !== owner.name ||
        stableValue(staged.dependencies) !== stableValue(owner.dependencies) || Object.keys(staged.devDependencies ?? {}).length) {
      const actual = owner.dependencies ?? {}, locked = staged?.dependencies ?? {};
      const missing = Object.keys(actual).filter(name => !Object.hasOwn(locked, name));
      const extra = Object.keys(locked).filter(name => !Object.hasOwn(actual, name));
      const changed = Object.keys(actual).filter(name => Object.hasOwn(locked, name) && locked[name] !== actual[name]);
      const differences = [['missing from lock', missing], ['only in lock', extra], ['different specifier', changed]]
        .filter(([, names]) => names.length).map(([label, names]) => `${label}: ${names.sort().join(', ')}`);
      throw new Error(`Resource-node lock is stale for ${directory}${differences.length ? ` (${differences.join('; ')})` : ''}`);
    }
  }
  return lock;
}

// Refresh existing role metadata for dependency updates without compiling the Host.
// Changes to the role import graph still need the artifact-driven --update-lock.
export function checkResourceNodeLock({ update = false, role = 'resources' } = {}) {
  const { basename, lockPath } = selectRole(role);
  const canonical = readLock(lockPath);
  const host = readJson(original('packages/web/package.json'));
  const dependencies = {};
  for (const name of Object.keys(canonical.workspaces['packages/web'].dependencies ?? {})) {
    if (!Object.hasOwn(host.dependencies, name)) {
      throw new Error(`Resource-node dependency ${name} was removed; rebuild role and update its lock from the emitted runtime`);
    }
    dependencies[name] = host.dependencies[name];
  }
  const { packages, rootPackage } = roleManifests(sort(dependencies), basename);
  const output = fs.mkdtempSync(path.join(tmpdir(), 'varin-resource-lock-'));
  try {
    writeJson(path.join(output, 'package.json'), rootPackage);
    writeJson(path.join(output, 'resource-node.json'), { workspaces: [...packages.keys()] });
    for (const [directory, manifest] of packages) {
      writeJson(path.join(output, 'packages', directory, 'package.json'), manifest);
      const previous = canonical.workspaces[`packages/${directory}`];
      if (update && previous) previous.version = manifest.version;
    }
    for (const relative of Object.values(rootPackage.patchedDependencies)) {
      const target = path.join(output, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(original(relative), target);
    }
    const candidate = path.join(output, 'bun.lock');
    if (update) {
      writeJson(candidate, canonical);
      run(output, 'bun', ['install', '--lockfile-only', '--ignore-scripts']);
    } else fs.copyFileSync(lockPath, candidate);
    validateResourceNodeLock(output);
    if (update) {
      run(output, 'bun', ['install', '--lockfile-only', '--production', '--frozen-lockfile', '--ignore-scripts']);
      fs.copyFileSync(candidate, lockPath);
    }
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

export async function stageResourceNode({ source, output, update = false, role = 'resources' }) {
  const { basename, entrypoint, lockPath } = selectRole(role);
  const ts = (await import('typescript')).default;
  const closure = collectResourceClosure(path.join(source, 'packages/web/server'), ts, basename);
  const { packages, rootPackage } = roleManifests(closure.dependencies, basename);
  if (fs.existsSync(output)) throw new Error('Resource-node output must be a new directory');
  writeJson(path.join(output, 'package.json'), rootPackage);
  const copy = (src, relative) => {
    const dest = path.join(output, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true, dereference: true });
  };
  for (const patch of Object.values(rootPackage.patchedDependencies)) copy(original(patch), patch);
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'KERNEL_THIRD_PARTY_NOTICES.md']) {
    copy(path.join(source, file), file);
  }
  for (const [directory, manifest] of packages) {
    writeJson(path.join(output, 'packages', directory, 'package.json'), manifest);
    if (directory === 'web') continue;
    for (const file of ['dist', 'broker', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      const relative = `packages/${directory}/${file}`;
      if (file === 'dist' || fs.existsSync(path.join(source, relative))) copy(path.join(source, relative), relative);
    }
  }
  for (const filename of closure.files) {
    const relative = `packages/web/server/${filename}`;
    copy(path.join(source, relative), relative);
  }
  if (role !== 'extensions') copy(path.join(source, 'packages/web/kernel'), 'packages/web/kernel');
  if (role === 'computer') copy(path.join(source, 'packages/web/server/computer-driver'), 'packages/web/server/computer-driver');
  copy(original('scripts/verify-resource-node-install.mjs'), 'verify-resource-node-install.mjs');
  writeJson(path.join(output, 'resource-node.json'), {
    schemaVersion: 1, role, entrypoint,
    workspaces: [...packages.keys()].sort(), dependencies: closure.dependencies,
  });

  const target = path.join(output, 'bun.lock');
  if (update) {
    const previous = readLock(path.join(source, 'bun.lock'));
    previous.workspaces[''].name = rootPackage.name;
    for (const [directory, manifest] of packages) {
      const current = previous.workspaces[`packages/${directory}`];
      if (current) current.version = manifest.version;
    }
    writeJson(target, previous);
    run(output, 'bun', ['install', '--lockfile-only', '--ignore-scripts']);
  } else fs.copyFileSync(lockPath, target);
  validateResourceNodeLock(output);
  run(output, 'bun', ['install', '--lockfile-only', '--production', '--frozen-lockfile', '--ignore-scripts']);
  if (update) fs.copyFileSync(target, lockPath);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const roleIdx = args.indexOf('--role');
  const role = roleIdx === -1 ? 'resources' : args.splice(roleIdx, 2)[1];
  selectRole(role);
  const [source, output, flag, extra] = args;
  if ((source === '--check-lock' || source === '--update-lock-only') && !output) {
    checkResourceNodeLock({ update: source === '--update-lock-only', role });
  } else {
    if (!source || !output || extra || (flag && flag !== '--update-lock')) {
      throw new Error('Usage: build-resource-node.mjs <built cloud runtime> <new output> [--update-lock], --check-lock, or --update-lock-only [--role browser|computer|extensions]');
    }
    await stageResourceNode({ source: path.resolve(source), output: path.resolve(output), update: flag === '--update-lock', role });
  }
}
