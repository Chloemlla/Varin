import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Session } from 'electron';
import { expect, it, vi } from 'vitest';
import { createDesktopNetworkFetch } from './harness-network-fetch.js';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('electron', () => ({ net: { request } }));

function pending(init: RequestInit = {}) {
  const outbound = Object.assign(new EventEmitter(), { end: vi.fn(), setHeader: vi.fn(), abort: vi.fn((): void => { outbound.emit('close'); }) });
  request.mockReturnValueOnce(outbound);
  const response = createDesktopNetworkFetch({} as Session)('https://example.test/a', init);
  return { outbound, response };
}

it('returns the status, byte-valued headers and streaming body of a Chromium response', async () => {
  const { outbound, response } = pending();
  outbound.emit('close'); // Electron finishes the writable before headers can arrive.
  const incoming = Object.assign(new PassThrough(), { statusCode: 401, headers: {
    'x-model': '\u6a21\u578b', 'x-label': 'caf\xe9', 'www-authenticate': 'Bearer realm="mcp"',
    '\u6a21': 'ignored', 'set-cookie': ['one=1', 'two=2'],
  } });
  outbound.emit('response', incoming);
  const result = await response;
  expect(result.status).toBe(401);
  expect(Buffer.from(result.headers.get('x-model')!, 'latin1').toString('utf8')).toBe('\u6a21\u578b');
  expect(result.headers.get('x-label')).toBe('caf\xe9');
  expect(result.headers.get('www-authenticate')).toBe('Bearer realm="mcp"');
  expect(result.headers.getSetCookie()).toEqual(['one=1', 'two=2']);
  incoming.end('sign in');
  expect(await result.text()).toBe('sign in');
});

it('returns the Chromium redirect destination and stops before the next hop', async () => {
  const { outbound, response } = pending();
  outbound.emit('redirect', 302, 'GET', 'https://other.test/\u6a21', { location: '/\u6a21', 'x-label': '\u6a21' });
  const result = await response;
  expect(result.status).toBe(302);
  expect(result.headers.get('location')).toBe('https://other.test/%E6%A8%A1');
  expect(outbound.abort).toHaveBeenCalledOnce();
});

it.each(['response', 'redirect'])('rejects and closes when the %s cannot be constructed', async event => {
  const { outbound, response } = pending();
  const invalid = { 'invalid header name': 'value' };
  if (event === 'response') outbound.emit(event, { statusCode: 204, headers: invalid });
  else outbound.emit(event, 302, 'GET', 'https://other.test/', invalid);
  await expect(response).rejects.toThrow();
  expect(outbound.abort).toHaveBeenCalledOnce();
});

it("propagates a Chromium error after upload and keeps the caller's abort reason", async () => {
  const first = pending();
  const disconnected = new Error('net::ERR_CONNECTION_RESET');
  first.outbound.emit('close');
  first.outbound.emit('error', disconnected);
  await expect(first.response).rejects.toBe(disconnected);
  const controller = new AbortController();
  const second = pending({ signal: controller.signal });
  second.outbound.emit('close');
  const reason = new Error('cancelled');
  controller.abort(reason);
  await expect(second.response).rejects.toBe(reason);
});
