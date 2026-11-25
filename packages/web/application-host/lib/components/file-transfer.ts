import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type ComponentFetch = (url: string, init?: Omit<RequestInit, 'dispatcher'>) => Promise<Response>;

type TransferProgress = (downloadedBytes: number, totalBytes?: number) => void;

/** Copy into a fresh owner-provided staging path, never an installed path. */
export async function stageComponentFile(
  source: AsyncIterable<Uint8Array>,
  destination: string,
  { signal, totalBytes, onProgress }: {
    signal?: AbortSignal | undefined;
    totalBytes?: number | undefined;
    onProgress?: TransferProgress | undefined;
  } = {},
): Promise<number> {
  signal?.throwIfAborted();
  let downloadedBytes = 0;
  if (totalBytes !== undefined) onProgress?.(0, totalBytes);
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedBytes += chunk.byteLength;
      try {
        onProgress?.(downloadedBytes, totalBytes);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  await pipeline(Readable.from(source), progress, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), signal ? { signal } : {});
  return downloadedBytes;
}

export async function fetchComponentFile(
  url: string,
  destination: string,
  { signal, onProgress, fetcher = fetch, label }: {
    signal?: AbortSignal | undefined;
    onProgress?: TransferProgress | undefined;
    fetcher?: ComponentFetch;
    label: string;
  },
): Promise<{ downloadedBytes: number; totalBytes?: number }> {
  signal?.throwIfAborted();
  const response = await fetcher(url, signal ? { signal } : undefined);
  if (signal?.aborted) {
    void response.body?.cancel().catch(() => undefined);
    signal.throwIfAborted();
  }
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    const diagnostic = response.ok ? 'missing response body' : `${response.status} ${response.statusText}`.trim();
    throw new Error(`${label} download failed: ${diagnostic}`);
  }

  // A compressed HTTP response's Content-Length is not the size of its decoded stream.
  const header = response.headers.get('content-length');
  const advertisedBytes = header && /^\d+$/.test(header) && !response.headers.get('content-encoding') ? Number(header) : undefined;
  const totalBytes = advertisedBytes !== undefined && Number.isSafeInteger(advertisedBytes) ? advertisedBytes : undefined;
  const downloadedBytes = await stageComponentFile(
    Readable.fromWeb(response.body as never), destination, { signal, totalBytes, onProgress },
  );
  return { downloadedBytes, ...(totalBytes === undefined ? {} : { totalBytes }) };
}
