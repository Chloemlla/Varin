import { EventEmitter } from 'node:events';
import express from 'express';
import type { Request, Response as ExpressResponse } from 'express';

/** Exercise Express's actual route/middleware stack without opening a listener. */
export function routerTransport(router: ReturnType<typeof express.Router>) {
  const exchanges: Array<{ request: EventEmitter; response: EventEmitter; replied: boolean }> = [];
  const fetch = (target: URL, init: RequestInit): Promise<Response> => new Promise((resolve, reject) => {
    if (init.signal?.aborted) { reject(init.signal.reason); return; }
    const headers = new Headers();
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: false,
      destroyed: false,
      setHeader(name: string, value: string) { headers.set(name, value); },
      status(code: number) { this.statusCode = code; return this; },
      json(payload: unknown) {
        exchange.replied = true;
        this.writableEnded = true;
        init.signal?.removeEventListener('abort', abort);
        resolve(Response.json(payload, { status: this.statusCode, headers }));
        response.emit('finish');
        return this;
      },
    });
    const requestHeaders = new Headers(init.headers);
    const incomingHeaders = Object.fromEntries(requestHeaders);
    // JSON is already decoded below. Let Express match the content type without
    // making its body parser wait for a network stream on the in-memory request.
    const matchingHeaders = init.body != null && !requestHeaders.has('content-length') && !requestHeaders.has('transfer-encoding')
      ? { ...incomingHeaders, 'transfer-encoding': 'chunked' } : incomingHeaders;
    const is: Request['is'] = types => express.request.is.call({ headers: matchingHeaders }, types);
    const binary = is('application/octet-stream') === 'application/octet-stream';
    const request = Object.assign(new EventEmitter(), {
      method: init.method ?? 'GET',
      url: target.pathname + target.search,
      headers: incomingHeaders,
      header: (name: string) => requestHeaders.get(name) ?? undefined,
      is,
      body: init.body && !binary ? JSON.parse(String(init.body)) : undefined,
      async *[Symbol.asyncIterator]() {
        if (binary && init.body && typeof (init.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function')
          yield* init.body as unknown as AsyncIterable<Uint8Array>;
        else if (binary && init.body instanceof Uint8Array) yield init.body;
      },
      aborted: false,
    });
    const exchange = { request, response, replied: false };
    exchanges.push(exchange);
    response.once('close', () => {
      response.destroyed = true;
      reject(init.signal?.aborted ? init.signal.reason : new Error('Application host connection closed'));
    });
    const abort = () => {
      request.aborted = true;
      response.destroyed = true;
      request.emit('aborted');
      response.emit('close');
      reject(init.signal?.reason);
    };
    init.signal?.addEventListener('abort', abort, { once: true });
    router(request as Request, response as unknown as ExpressResponse, (error?: unknown) => {
      init.signal?.removeEventListener('abort', abort);
      reject(error ?? new Error('Contract route did not respond'));
    });
  });
  return Object.assign(fetch, { exchanges });
}

