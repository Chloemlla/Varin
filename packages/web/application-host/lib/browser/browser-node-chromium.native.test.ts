import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { BrowserResourceBinding } from '@varin/protocol';
import { startBrowserNode } from '../../browser-node.js';
import { createManagedRemoteTargetRegistry } from '../harness/managed-remote-client.js';
import { pairNodeRoleClient } from '../node-role-auth.js';
import { ManagedBrowserPeers } from './browser-managed.js';
import { BrowserResources } from './browser-resources.js';

const executable = process.env.VARIN_TEST_BROWSER_CHROMIUM;
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH;
const liveTimeout = { interval: 100, timeout: 12_000 };

async function localPage() {
  const text = 'Local browser acceptance ' + randomUUID();
  let served = 0;
  const server = http.createServer((request, response) => {
    if (request.url !== '/continuity') { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    response.setHeader('Cache-Control', 'no-store');
    response.once('finish', () => { served++; });
    response.end(`<!doctype html><meta charset="utf-8"><title>Varin continuity fixture</title><p id="fixture">${text}</p>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local page did not bind TCP');
  return {
    url: 'http://127.0.0.1:' + address.port + '/continuity', text, served: () => served,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

async function chromium(binary: string, profile: string, home: string, port = 0) {
  // The fixture owns this profile and process. It never uses an existing user
  // profile, disables Chromium's sandbox, or contacts a remote test site.
  const child = spawn(binary, ['--headless', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    // Chrome uses the literal IPv4 address here, not the localhost alias.
    // Keep all other DNS lookups blocked and never route the fixture via a proxy.
    '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let why = '', didExit = false;
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (line: string) => { why = (why + line).slice(-4096); });
  child.on('error', error => { why = String(error); });
  const exited = new Promise<void>(resolve => child.once('close', () => { didExit = true; resolve(); }));
  let endpoint = '', debuggerUrl = '';
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    if (didExit) return;
    if (debuggerUrl) {
      const socket = new WebSocket(debuggerUrl);
      socket.addEventListener('open', () => { socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })); }, { once: true });
      try { await Promise.race([exited, delay(4000, undefined, { ref: false })]); }
      finally { socket.close(); }
    }
    if (!didExit) {
      child.kill('SIGTERM');
      await Promise.race([exited, delay(3000, undefined, { ref: false })]);
    }
    if (!didExit) child.kill('SIGKILL'); // Only this disposable fixture, never the role or a real user browser.
    await exited;
  })();
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !didExit) {
      const found = port || Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]);
      if (Number.isInteger(found) && found > 0 && found <= 65535) {
        endpoint = 'http://127.0.0.1:' + found;
        const version = await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(500), redirect: 'error' })
          .then(async response => response.ok ? await response.json() as { webSocketDebuggerUrl?: unknown } : null).catch(() => null);
        if (typeof version?.webSocketDebuggerUrl === 'string') {
          const ws = new URL(version.webSocketDebuggerUrl);
          if (ws.protocol !== 'ws:' || ws.hostname !== '127.0.0.1' || Number(ws.port) !== found ||
              !ws.pathname.startsWith('/devtools/browser/') || !child.pid || didExit) throw new Error('Unexpected Chromium CDP identity');
          debuggerUrl = ws.href;
          return { endpoint, port: found, debuggerUrl, pid: child.pid, stop, alive: () => !didExit };
        }
      }
      await delay(100);
    }
    throw new Error('Fixture Chromium did not start: ' + why);
  } catch (error) {
    await stop();
    throw error;
  }
}

it.skipIf(!executable)('preserves Chromium profile and process identity independently of a paired Browser-role restart', async () => {
  if (!path.isAbsolute(executable!) || !kernelPath || !path.isAbsolute(kernelPath)) {
    throw new Error('Set absolute VARIN_TEST_BROWSER_CHROMIUM and VARIN_TEST_KERNEL_PATH for real Chromium acceptance');
  }
  await Promise.all([fs.access(executable!, constants.X_OK), fs.access(kernelPath, constants.X_OK)]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-chromium-acceptance-'));
  const profile = path.join(root, 'profile'), home = path.join(root, 'chrome-home'), dataDir = path.join(root, 'role-state');
  const roleOptions = { dataDir, kernelPath, port: 0 };
  const coordinator = new BrowserResources();
  let page: Awaited<ReturnType<typeof localPage>> | undefined;
  let chrome: Awaited<ReturnType<typeof chromium>> | undefined;
  let node: Awaited<ReturnType<typeof startBrowserNode>> | undefined;
  try {
    await fs.mkdir(profile, { mode: 0o700 });
    await fs.mkdir(home, { mode: 0o700 });
    page = await localPage();
    chrome = await chromium(executable!, profile, home);
    const output = path.join(root, 'coordinator.json');
    await pairNodeRoleClient(dataDir, kernelPath, output, { label: 'Disposable local coordinator', capabilities: ['browser:use'] });
    const { token } = JSON.parse(await fs.readFile(output, 'utf8')) as { token: string };
    const endpoint = chrome.endpoint, chromePort = chrome.port;
    node = await startBrowserNode({ ...roleOptions, endpoint });
    const port = node.port, hostId = node.hostId;
    const targets = createManagedRemoteTargetRegistry({ coordinatorHostId: 'real-chromium-coordinator',
      kernel: {} as never, resources: {} as never, readSettings: async () => ({
        desktopHosts: [{ id: 'same-managed-browser-route', label: 'Local Chromium',
          apiUrl: 'http://127.0.0.1:' + port, clientToken: token }],
      }) });
    let dispatched = 0;
    const tracedFetch: typeof fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith('/browser/call')) dispatched++;
      return fetch(input, init);
    };
    const peers = new ManagedBrowserPeers('real-chromium-coordinator', coordinator, targets, tracedFetch);
    await peers.refresh();
    const [configured] = await coordinator.list();
    expect(configured).toMatchObject({ state: 'disconnected', activation: 'connect' });
    expect(configured?.instanceId).toBeUndefined();
    const browserId = configured!.browserId;
    const acquire = async () => {
      const resource = await coordinator.acquire(browserId);
      expect(resource).toMatchObject({ browserId, state: 'online', instanceId: expect.any(String) });
      return { browserId, instanceId: resource.instanceId! };
    };
    const open = async (browser: BrowserResourceBinding) => {
      const fixture = page!;
      const previousResponses = fixture.served();
      const tab = await coordinator.use(browser, {}, owner => owner.open({ url: fixture.url, retained: true }, {}), { writes: true });
      const binding = { ...browser, pageId: tab.pageId };
      try {
        // Target listing can carry the address-bar fallback title, including on
        // navigation failure. Match actual frame/document text over the owner API.
        await expect.poll(async () => {
          try {
            const observed = await coordinator.use(binding, {}, owner => owner.read({ pageId: tab.pageId, view: 'text' }, AbortSignal.timeout(2_000)));
            return { url: observed.frames.find(frame => !frame.parentId)?.url,
              hasDocument: observed.text?.includes(fixture.text) === true, served: fixture.served() > previousResponses };
          } catch (error) {
            return { observationError: error instanceof Error ? error.message : String(error), served: fixture.served() > previousResponses };
          }
        }, liveTimeout).toMatchObject({ url: fixture.url, hasDocument: true, served: true });
      } catch (error) {
        const tabs = await coordinator.use(browser, {}, owner => owner.list()).catch(() => []);
        const target = tabs.find(item => item.pageId === tab.pageId);
        throw new Error(`Fixture page did not load (local responses: ${fixture.served() - previousResponses}; target URL: ${target?.url}; target title: ${target?.title})`, { cause: error });
      }
      expect(await evaluate(binding, '({url: location.href, title: document.title, body: document.querySelector("#fixture")?.textContent})'))
        .toEqual({ url: fixture.url, title: 'Varin continuity fixture', body: fixture.text });
      return binding;
    };
    const evaluate = async (binding: BrowserResourceBinding, script: string) => (
      await coordinator.use(binding, {}, owner => owner.act(binding.pageId!, { action: 'evaluate', script }), { writes: true })
    ).value;
    const first = await acquire();
    const tab = await open(first);
    const marker = randomUUID();
    const keyExpr = JSON.stringify('varin-disposable-continuity');
    const read = `localStorage.getItem(${keyExpr})`;
    expect(await evaluate(tab, `localStorage.setItem(${keyExpr}, ${JSON.stringify(marker)}); ${read}`)).toBe(marker);
    const oldChrome = chrome;

    // Replace role control only: preserve the same durable grant, route, live
    // Chromium process and tab. A role stop must not close its upstream.
    await node.close(); node = undefined;
    expect(oldChrome.alive()).toBe(true);
    node = await startBrowserNode({ ...roleOptions, port, endpoint });
    expect(node.hostId).toBe(hostId);
    await peers.refresh();
    expect(await acquire()).toEqual(first);
    expect(await evaluate(tab, read)).toBe(marker);
    expect(oldChrome.alive()).toBe(true);
    const upstream = await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(2000) });
    expect(await upstream.json()).toMatchObject({ webSocketDebuggerUrl: oldChrome.debuggerUrl });

    // Restart the independently owned Chromium with the original disk profile.
    // Same role / route, but a distinct debugger identity and stale old binding.
    await oldChrome.stop();
    expect(oldChrome.alive()).toBe(false);
    await expect.poll(async () => {
      await peers.refresh();
      return (await coordinator.list())[0]?.state;
    }, liveTimeout).toBe('interrupted');
    chrome = await chromium(executable!, profile, home, chromePort);
    expect(chrome.debuggerUrl).not.toBe(oldChrome.debuggerUrl);
    const second = await acquire();
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(node.hostId).toBe(hostId);
    const beforeStale = dispatched;
    await expect(evaluate(tab, 'document.title')).rejects.toMatchObject({ effect: 'none' });
    expect(dispatched).toBe(beforeStale);
    const newTab = await open(second);
    expect(await evaluate(newTab, read)).toBe(marker);
  } finally {
    try { await coordinator.dispose(); }
    finally {
      try { await node?.close(); }
      finally {
        try { await chrome?.stop(); }
        finally {
          await page?.close();
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    }
  }
}, 120_000);
