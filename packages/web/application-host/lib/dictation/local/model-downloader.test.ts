import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { getLocalSttModelSpec } from './model-catalog.js';
import { ensureLocalSttModel, isLocalSttModelInstalled } from './model-downloader.js';

it('publishes a real staged speech model, recovers from an interrupted transfer, and reuses the installed model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-speech-component-'));
  try {
    const modelId = 'sense-voice-small-int8';
    const spec = getLocalSttModelSpec(modelId);
    const source = join(root, 'source');
    await mkdir(join(source, spec.extractedDir), { recursive: true });
    for (const file of spec.requiredFiles) await writeFile(join(source, spec.extractedDir, file), 'fixture');
    const archive = join(root, 'fixture.tar.bz2');
    const bundled = spawnSync('tar', ['cjf', '../fixture.tar.bz2', spec.extractedDir], { cwd: source, encoding: 'utf8' });
    expect(bundled.error ?? bundled.status, bundled.stderr).toBe(0);
    const bytes = await readFile(archive);
    const fetcher = vi.fn()
      .mockImplementationOnce(async () => new Response(new ReadableStream({
        pull(controller) { controller.error(new Error('network interrupted')); },
      }) as ReadableStream<Uint8Array>))
      .mockImplementationOnce(async () => new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } }));
    const modelsDir = join(root, 'models');
    await expect(ensureLocalSttModel({ modelsDir, modelId, fetcher })).rejects.toThrow('network interrupted');
    expect(await isLocalSttModelInstalled(modelsDir, modelId)).toBe(false);
    expect(await readdir(join(modelsDir, '.downloads'))).toEqual([]);
    const onProgress = vi.fn();
    const installed = await ensureLocalSttModel({ modelsDir, modelId, onProgress, fetcher });
    expect(installed).toBe(join(modelsDir, spec.extractedDir));
    expect(await isLocalSttModelInstalled(modelsDir, modelId)).toBe(true);
    expect(onProgress).toHaveBeenLastCalledWith(bytes.length, bytes.length);
    await ensureLocalSttModel({ modelsDir, modelId, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
