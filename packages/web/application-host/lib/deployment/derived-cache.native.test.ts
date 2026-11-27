import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createKernelClient } from '../kernel/kernel-client.js';
import { McpDirectory } from '../mcp/directory.js';
import { CHANNEL_DIRECTORY_URL } from '../models/channel-directory.js';
import { ModelsService } from '../models/service.js';
import { acquireTokenCounter } from '../models/token-count.js';
import { deploymentCacheRoot, relocateModelCaches } from './derived-cache.js';

const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel', 'target', 'release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const available = await fs.stat(kernelPath).then(() => true, () => false);
if (!available && process.env.VARIN_REQUIRE_RELEASE_KERNEL === '1') throw new Error('Cache relocation requires a release kernel');

it.skipIf(!available)('moves rebuildable caches and reopens a previously captured tokenizer in a new kernel', async () => {
  const temp = await fs.mkdtemp(path.join(tmpdir(), 'varin-managed-cache-'));
  const data = path.join(temp, 'data');
  const hostId = 'cache-test';
  const root = deploymentCacheRoot(path.join(temp, 'external'), hostId)!;
  const buildVersion = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')).version as string;
  const kernel = createKernelClient({ hostId, kernelPath, buildVersion, allowCargoDevRunner: false,
    storageRoot: path.join(data, 'kernel', hostId), env: { VARIN_KERNEL_TOKENIZER_CACHE_DIR: path.join(root, 'tokenizers') } });
  try {
    await fs.mkdir(data);
    const directory = path.join(data, 'model-directory.json');
    await fs.writeFile(directory, JSON.stringify({ version: 1, sources: { [CHANNEL_DIRECTORY_URL]: {
      checkedAt: 42, body: { version: 1, channels: [{ id: 'cache-fixture', name: 'Offline cache test',
        kind: 'model-vendor', protocol: 'openai-completions', baseUrl: 'https://cache.invalid/v1' }] },
    } } }));
    const source = { kind: 'file' as const, path: path.join(data, 'tokenizer.json') };
    await fs.writeFile(source.path, JSON.stringify({ version: '1.0', model: { type: 'WordLevel', vocab: { '[UNK]': 0, '中文 🎉': 1 }, unk_token: '[UNK]' } }));
    const personal = new ModelsService(data, { projectTrusted: () => false });
    const original = await personal.tokenizers.prepare(source);
    if (original?.kind !== 'file') throw new Error('Expected a cached tokenizer fixture');
    await kernel.start();
    await relocateModelCaches(data, root);
    await relocateModelCaches(data, root);
    const reopened = new ModelsService(data, { projectTrusted: () => false, cacheRoot: root });
    expect((await reopened.read()).types.some(type => type.id === 'cache-fixture')).toBe(true);
    const restored = await reopened.cachedTokenizer(source);
    expect(restored).toMatchObject({ kind: 'file', sha256: original.sha256,
      path: path.join(root, 'tokenizers', original.sha256 + '.json.gz') });
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(original.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const counter = await acquireTokenCounter(kernel, { model: 'offline-cache', tokenizer: original });
    try { expect(await counter.count(['中文 🎉'])).toEqual({ counts: [1], tokenizer: 'configured tokenizer.json' }); }
    finally { await counter.release(); }

    const cache = { tools: [], resources: [], resourceTemplates: [], prompts: [], updatedAt: 'fixture' };
    const mcp = path.join(data, 'mcp-directory.json');
    const dest = path.join(root, 'mcp', 'directory.json');
    await fs.writeFile(mcp, JSON.stringify({ version: 1, entries: { retained: cache } }));
    const errors: unknown[] = [];
    const mcpDirectory = new McpDirectory(dest, error => errors.push(error), mcp);
    expect(await mcpDirectory.get('retained')).toEqual(cache);
    await expect(fs.stat(mcp)).rejects.toMatchObject({ code: 'ENOENT' });
    await mcpDirectory.close();
    expect(errors).toEqual([]);
  } finally {
    await kernel.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
}, 30_000);
