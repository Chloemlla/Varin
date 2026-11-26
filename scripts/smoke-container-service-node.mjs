import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const [role, image, releaseId, platform = 'linux/amd64'] = process.argv.slice(2);
if (!['browser', 'computer'].includes(role) ||
    !/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image ?? '') ||
    !/^image-[a-f0-9]{40}$/.test(releaseId ?? '') || !['linux/amd64', 'linux/arm64'].includes(platform)) {
  throw new Error('Use a dedicated role, immutable image digest and exact release identity');
}
const name = 'varin-service-check-' + randomUUID();
const state = name + '-state', privateVolume = name + '-pair';
const mounts = ['--mount', `type=volume,src=${state},dst=/home/varin/.config/varin`];
const ephemeral = ['run', '--rm', '--platform', platform, ...mounts,
  '--mount', `type=volume,src=${privateVolume},dst=/home/varin/.ssh`];
const docker = (args, capture = false) => execFileSync('docker', args,
  { encoding: 'utf8', stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'], timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
const managed = '/api/harness/managed-execution/v1';
const privateOutput = '/home/varin/.ssh/client.json';
try {
  docker(['pull', '--platform', platform, image]);
  docker(['volume', 'create', state]);
  docker(['volume', 'create', privateVolume]);
  docker([...ephemeral, image, 'pair', '--output', privateOutput]);
  let token, clientId;
  try { ({ token, clientId } = JSON.parse(docker([...ephemeral, '--entrypoint', 'cat', image, privateOutput], true))); }
  catch { throw new Error('Could not read the private fixture pairing output'); }
  if (typeof token !== 'string' || typeof clientId !== 'string') throw new Error('Missing private fixture credential');
  const start = async () => {
    docker(['run', '--detach', '--name', name, '--platform', platform, ...mounts,
      ...(role === 'browser' ? ['--env', 'VARIN_BROWSER_CDP_ENDPOINT=http://127.0.0.1:1'] : []),
      '--publish', '127.0.0.1::3000', image]);
    const port = /^127\.0\.0\.1:(\d+)$/u.exec(docker(['port', name, '3000/tcp'], true).trim())?.[1];
    if (!port) throw new Error('Could not determine the loopback fixture port');
    const base = 'http://127.0.0.1:' + port;
    for (let attempt = 0; attempt < (platform === 'linux/arm64' ? 120 : 60); attempt++) {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(2_000) }).catch(() => null);
      if (response?.ok) {
        const body = await response.json();
        assert.equal(body.role, role);
        assert.equal(body.control, 'ready');
        assert.equal(body.releaseId, releaseId);
        return base;
      }
      if (docker(['inspect', '--format', '{{.State.Running}}', name], true).trim() !== 'true') throw new Error(role + ' node stopped before ready');
      await delay(1000);
    }
    throw new Error(role + ' node did not become ready');
  };
  const request = (base, resource, { paired = true, target, body } = {}) => fetch(base + resource, {
    headers: { ...(paired ? { Authorization: 'Bearer ' + token } : {}),
      ...(target === undefined ? {} : { 'X-Varin-Managed-Target': target }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const identity = async (base, expected) => {
    const receipt = await request(base, managed + '/identity', { target: expected });
    assert.equal(receipt.status, 200);
    const body = await receipt.json();
    assert.equal(body.role, role);
    assert.deepEqual(body.capabilities, [role]);
    assert.equal(body.requestHostIdentity, true);
    assert.equal(body.protocolVersion, 1);
    assert.equal(typeof body.hostId, 'string');
    assert.equal(receipt.headers.get('x-varin-managed-host'), body.hostId);
    if (expected !== undefined) assert.equal(body.hostId, expected);
    return body.hostId;
  };
  let base = await start();
  const hostId = await identity(base);
  const unauthenticated = await request(base, managed + '/identity', { paired: false });
  assert([401, 403].includes(unauthenticated.status));
  assert.equal((await request(base, managed + '/identity', { target: 'other' })).status, 409);
  assert.equal((await request(base, '/api/threads')).status, 404);
  assert.equal((await request(base, managed + '/sources/resolve', { body: {} })).status, 404);
  if (role === 'browser') {
    const listed = await request(base, managed + '/browser/resources');
    assert.equal(listed.status, 200);
    const [resource] = (await listed.json()).resources;
    assert.equal(resource.browserId, 'configured-cdp');
    assert.equal(resource.state, 'disconnected');
    assert(!resource.instanceId);
    assert.equal((await request(base, managed + '/browser/probe', { body: {} })).status, 404);
  } else {
    const listed = await request(base, '/api/computers');
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get('x-varin-computer-host'), hostId);
    assert.equal((await request(base, '/api/computers/desktops/prepare', { body: {} })).status, 403);
    // Run the shipped driver imports as the exact image's ordinary user,
    // without relying on the runner's Gi/AT-SPI/GDK packages.
    docker(['exec', name, 'python3', '-c', [
      'import sys',
      'sys.path.insert(0, "packages/web/server/computer-driver/linux")',
      'from runtime import Atspi, Gdk',
      'assert Atspi is not None and Gdk is not None, "Computer image lacks AT-SPI or GDK"',
    ].join('\n')]);
  }
  docker(['exec', name, 'node', 'verify-resource-node-install.mjs']);
  docker(['stop', name]);
  docker(['rm', name]);
  base = await start();
  await identity(base, hostId);
  docker(['stop', name]);
  docker(['rm', name]);
  docker([...ephemeral, image, 'revoke', clientId]);
  base = await start();
  assert([401, 403].includes((await request(base, managed + '/identity')).status));
  console.log(role + ' node paired, admitted only its role, restarted under the original identity, and revoked the original grant');
} finally {
  for (const args of [['rm', '--force', name], ['volume', 'rm', privateVolume], ['volume', 'rm', state], ['image', 'rm', image]]) {
    try { docker(args, true); } catch { /* A partially created fixture has nothing to remove. */ }
  }
}
