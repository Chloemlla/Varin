import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { classifyEgressError, EgressError, type EgressRuntime } from '../harness/egress.js';
import type { Dispatcher } from 'undici';

export type CdpEgress = Pick<EgressRuntime, 'fetch' | 'resolve'>;

interface CdpSocket {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  send(text: string, failed: () => void): void;
  listen(message: (data: string) => void, disconnected: () => void): void;
}

async function openCdpSocket(url: URL, headers?: Record<string, string>, egress?: CdpEgress): Promise<CdpSocket> {
  if (!egress) {
    const socket = new WebSocket(url, { headers, handshakeTimeout: 15_000, followRedirects: false });
    return await new Promise<CdpSocket>((resolve, reject) => {
      const fail = () => { socket.off('open', open); reject(new Error('The configured browser WebSocket could not be connected')); };
      const open = () => {
        socket.off('error', fail);
        resolve({
          get readyState() { return socket.readyState; },
          close: (code, reason) => socket.close(code, reason),
          send: (data, failed) => socket.send(data, error => { if (error) failed(); }),
          listen(message, disconnected) {
            socket.on('message', data => message(data.toString()));
            socket.on('close', disconnected);
            socket.on('error', disconnected);
          },
        });
      };
      socket.once('open', open);
      socket.once('error', fail);
    });
  }
  const target = new URL(url);
  target.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  const { dispatcher, failure, policy } = egress.resolve(target.href);
  if (failure) throw failure;
  if (!dispatcher) throw new EgressError('connect', 'Browser endpoint egress is unavailable');
  const { DecoratorHandler, WebSocket: ManagedWebSocket } = await import('undici');
  // Undici's WebSocket error event does not retain the HTTP connector's cause.
  // Capture it on this handshake's dispatcher so DNS denials keep their code.
  let handshakeError: Error | undefined;
  const handshake = dispatcher.compose(dispatch => (options, handler) => {
    const wrapped: Dispatcher.DispatchHandler = new DecoratorHandler(handler);
    wrapped.onResponseError = (controller, error) => {
      handshakeError = error;
      handler.onResponseError?.(controller, error);
    };
    return dispatch(options, wrapped);
  });
  const socket = new ManagedWebSocket(url, { dispatcher: handshake, ...(headers && { headers }) });
  socket.binaryType = 'arraybuffer';
  return await new Promise<CdpSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new EgressError('timeout', 'The configured browser WebSocket timed out'));
      socket.close();
    }, 15_000);
    const fail = (event: { error: unknown }) => {
      clearTimeout(timer);
      reject(classifyEgressError(handshakeError ?? event.error, policy.mode === 'proxy' ? 'proxy' : 'direct'));
    };
    socket.addEventListener('error', fail, { once: true });
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      socket.removeEventListener('error', fail);
      resolve({
        get readyState() { return socket.readyState; },
        close: (code, reason) => socket.close(code === 1002 ? 4002 : code, reason),
        send(data, failed) { try { socket.send(data); } catch { failed(); } },
        listen(message, disconnected) {
          socket.addEventListener('message', event => message(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString()));
          socket.addEventListener('close', disconnected);
          socket.addEventListener('error', disconnected);
        },
      });
    }, { once: true });
  });
}

/** A lost CDP response is not evidence that execution stopped. Never replay it. */
export class CdpDisconnectedError extends Error {
  constructor() { super('The browser connection was interrupted; inspect the original page before repeating an action.'); }
}
export interface CdpEvent { method: string; params: CdpResult; sessionId?: string }
// CDP is a negotiated, extensible domain protocol. Validate its envelope here;
// each operation checks the result fields it consumes rather than casting a
// single fixed Chromium version's generated schema over every provider.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CdpResult = Record<string, any>;

/** Owner-configured transport, never a model-supplied egress or credential path. */
export class CdpTransport {
  readonly instanceId: string;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: CdpResult): void; reject(error: Error): void }>();
  private listeners = new Set<(event: CdpEvent) => void>();
  private closeListeners = new Set<() => void>();
  private closed = false;
  private constructor(private readonly socket: CdpSocket, endpoint: URL) {
    // CDP's browser token identifies the process/session, not a port or profile path.
    this.instanceId = /\/devtools\/browser\/[^/]+$/.test(endpoint.pathname)
      ? `cdp:${createHash('sha256').update(endpoint.origin + endpoint.pathname).digest('hex')}`
      : `cdp:${randomUUID()}`; // A generic gateway URL does not prove process continuity.
    socket.listen(data => {
      let message: CdpEvent & { id?: number; result?: CdpResult; error?: { message?: string } };
      try { message = JSON.parse(data); } catch { socket.close(1002, 'Invalid CDP message'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.close(1002, 'Invalid CDP envelope'); return; }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`Browser command failed: ${message.error.message ?? 'protocol error'}`));
        else pending.resolve(message.result ?? {});
      } else if (typeof message.method === 'string') {
        if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)) { socket.close(1002, 'Invalid CDP event'); return; }
        for (const listener of this.listeners) listener(message);
      }
    }, () => this.disconnected());
  }
  static async connect(endpoint: string, headers?: Record<string, string>, egress?: CdpEgress): Promise<CdpTransport> {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error('CDP endpoint must be an HTTP(S) or WebSocket URL'); }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.hash) throw new Error('CDP endpoint must be an HTTP(S) or WebSocket URL without a fragment');
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const versionUrl = new URL(url); versionUrl.pathname = `${versionUrl.pathname.replace(/\/$/, '')}/json/version`;
      const response = await (egress?.fetch ?? fetch)(versionUrl.href, { ...(headers ? { headers } : {}), redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`The configured CDP endpoint returned HTTP ${response.status}`);
      const version = await response.json() as { webSocketDebuggerUrl?: unknown };
      if (typeof version.webSocketDebuggerUrl !== 'string') throw new Error('The endpoint did not identify a browser WebSocket');
      const websocket = new URL(version.webSocketDebuggerUrl);
      // Discovery must not redirect privileged access to a different service.
      if (websocket.hostname !== url.hostname || (websocket.port || (websocket.protocol === 'wss:' ? '443' : '80')) !== (url.port || (url.protocol === 'https:' ? '443' : '80')) ||
          websocket.protocol !== (url.protocol === 'https:' ? 'wss:' : 'ws:')) throw new Error('The CDP discovery response changed its configured endpoint origin; configure the intended WebSocket URL explicitly');
      url = websocket;
    }
    return new CdpTransport(await openCdpSocket(url, headers, egress), url);
  }
  onEvent(listener: (event: CdpEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onClose(listener: () => void) { this.closeListeners.add(listener); return () => { this.closeListeners.delete(listener); }; }
  command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpResult> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new CdpDisconnectedError());
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), () => {
        this.pending.delete(id);
        reject(new CdpDisconnectedError());
      });
    });
  }
  private disconnected() {
    if (this.closed) return; this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new CdpDisconnectedError());
    this.pending.clear(); for (const listener of this.closeListeners) listener();
    this.listeners.clear(); this.closeListeners.clear();
  }
  close() { this.disconnected(); this.socket.close(); }
}
