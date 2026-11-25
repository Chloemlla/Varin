import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { fetchComponentFile, stageComponentFile } from './file-transfer.js';

it('does not follow stale staging paths or report encoded response sizes as decoded bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-component-transfer-'));
  try {
    const destination = join(root, 'staging');
    const onProgress = vi.fn();
    const fetcher: typeof fetch = async () => new Response(Uint8Array.of(1, 2, 3), {
      headers: { 'content-length': '99', 'content-encoding': 'gzip' },
    });
    await expect(fetchComponentFile('https://invalid.test', destination, { label: 'fixture', fetcher, onProgress }))
      .resolves.toEqual({ downloadedBytes: 3 });
    expect(await readFile(destination)).toEqual(Buffer.from([1, 2, 3]));
    expect(onProgress).toHaveBeenLastCalledWith(3, undefined);
    await writeFile(destination, 'previous');
    await expect(stageComponentFile((async function* () { yield Uint8Array.of(4); })(), destination)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(destination, 'utf8')).toBe('previous');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('cancels an active stream and prevents a pre-aborted fetch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-component-cancel-'));
  try {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      start(body) { body.enqueue(Uint8Array.of(1, 2)); },
    })));
    await expect(fetchComponentFile('https://invalid.test', join(root, 'partial'), {
      label: 'fixture', fetcher, signal: controller.signal, onProgress: () => controller.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(fetchComponentFile('https://invalid.test', join(root, 'pre-aborted'), {
      label: 'fixture', fetcher, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
