import { net, type Session } from 'electron';
import { Readable } from 'node:stream';

const responseHeaders = (raw: Record<string, string | string[]>): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    // A non-ASCII name has no HTTP field semantics.
    if (/[\u0080-\u{10ffff}]/u.test(name)) continue;
    for (const part of Array.isArray(value) ? value : [value]) {
      // Chromium can return decoded Unicode. Fetch represents header values as bytes.
      const bytes = /[\u0100-\u{10ffff}]/u.test(part) ? Buffer.from(part, 'utf8').toString('latin1') : part;
      headers.append(name, bytes);
    }
  }
  return headers;
};

/** One HTTP hop through Chromium's system proxy/PAC stack. Electron's
 * Session.fetch rejects manual redirects; ClientRequest exposes their status
 * and location before following, so the Host can inspect each next URL. */
export const createDesktopNetworkFetch = (networkSession: Session) => (
  url: string,
  init: RequestInit,
): Promise<Response> => new Promise((resolve, reject) => {
  const { signal } = init;
  signal?.throwIfAborted();
  const prepared = new Request(url, init);
  const outbound = net.request({
    url: prepared.url,
    method: prepared.method,
    session: networkSession,
    redirect: 'manual',
    cache: 'no-store',
    useSessionCookies: false,
    bypassCustomProtocolHandlers: true,
  });
  let settled = false;
  let cancelUpload: (() => void) | undefined;
  const dispose = (): void => {
    signal?.removeEventListener('abort', onAbort);
    cancelUpload?.();
  };
  const fail = (error: unknown): void => {
    dispose();
    if (settled) return;
    settled = true;
    reject(error);
  };
  const abort = (error: unknown): void => {
    fail(error);
    outbound.abort();
  };
  const onAbort = (): void => abort(signal?.reason);
  // ClientRequest is a Writable. Its close event marks the end of the
  // upload stream and can fire before Chromium receives response headers.
  outbound.on('error', fail);
  signal?.addEventListener('abort', onAbort, { once: true });

  const respond = (build: () => Response, stopRedirect = false): void => {
    if (settled) return;
    try {
      const response = build();
      settled = true;
      resolve(response);
    } catch (error) {
      abort(error);
      return;
    }
    if (stopRedirect) {
      dispose();
      outbound.abort();
    }
  };
  outbound.on('redirect', (statusCode, _method, redirectUrl, rawHeaders) => respond(() => {
    const headers = responseHeaders(rawHeaders);
    // Chromium has resolved the target, including escaping Unicode in the URL.
    const location = headers.get('location');
    if (!location || /[\u0080-\u{10ffff}]/u.test(location)) headers.set('location', new URL(redirectUrl, prepared.url).href);
    return new Response(null, { status: statusCode, headers });
  }, true));
  outbound.on('response', incoming => respond(() => {
    const status = incoming.statusCode;
    const headers = responseHeaders(incoming.headers);
    const noBody = prepared.method === 'HEAD' || status === 204 || status === 205 || status === 304;
    // Electron exposes a Node Readable at runtime. Preserve its backpressure.
    const stream = incoming as unknown as Readable;
    stream.once('close', dispose);
    if (noBody) {
      stream.once('error', dispose);
      stream.resume();
    }
    const body = noBody ? null : Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    return new Response(body, { status, headers });
  }));
  const send = async (): Promise<void> => {
    for (const [name, value] of prepared.headers) outbound.setHeader(name, value);
    if (!prepared.body) { outbound.end(); return; }
    outbound.chunkedEncoding = true;
    const reader = prepared.body.getReader();
    // A network error or an abort can arrive during a pending upload read.
    let cancelled = false;
    cancelUpload = () => { cancelled = true; void reader.cancel().catch(() => undefined); };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || cancelled) break;
        outbound.write(Buffer.from(value));
      }
      if (!cancelled) outbound.end();
    } finally {
      cancelUpload = undefined;
      reader.releaseLock();
    }
  };
  void send().catch(abort);
});
