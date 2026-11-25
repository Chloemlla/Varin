import { describe, expect, it } from 'vitest';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsFileStore } from '@varin/settings-store';
import { createEgressRuntime } from './egress.js';
import {
  bindEgressHostConfiguration, encodeOutboundProxyAuth, normalizeOutboundNetwork, OUTBOUND_PROXY_CREDENTIAL_REF, projectEgressSettings,
  readEgressHostConfiguration, readOutboundProxyAuth,
} from './egress-settings.js';

describe('Host outbound settings and credential binding', () => {
  it('rejects credential-bearing proxy URLs and unsupported schemes before persistence', () => {
    expect(() => normalizeOutboundNetwork({ mode: 'proxy', proxyUrl: 'http://user:secret@proxy.test:8080' })).toThrow();
    expect(() => normalizeOutboundNetwork({ mode: 'proxy', proxyUrl: 'socks5://proxy.test:1080' })).toThrow();
  });

  it('keeps a credential bound to the exact endpoint and setting generation', async () => {
    const key = encodeOutboundProxyAuth('generation-a', 'http://proxy-a.test:8080', 'user', 'secret');
    const auth = { [OUTBOUND_PROXY_CREDENTIAL_REF]: { type: 'api_key', key } };
    const a = { outboundNetwork: { mode: 'proxy', proxyUrl: 'http://proxy-a.test:8080', credentialRef: 'generation-a' } };
    const b = { outboundNetwork: { mode: 'proxy', proxyUrl: 'http://proxy-b.test:8080', credentialRef: 'generation-b' } };
    const returned = { outboundNetwork: { mode: 'proxy', proxyUrl: 'http://proxy-a.test:8080', credentialRef: 'generation-c' } };
    expect(readEgressHostConfiguration(a, auth)?.proxyAuth).toEqual({ username: 'user', password: 'secret' });
    expect(readEgressHostConfiguration(b, auth)?.proxyAuth).toBeUndefined();
    expect(readEgressHostConfiguration(returned, auth)?.proxyAuth).toBeUndefined();
    expect(readOutboundProxyAuth(auth, 'generation-b', 'http://proxy-b.test:8080')).toBeUndefined();
    const rt = createEgressRuntime({ env: {}, getHostConfiguration: async () => readEgressHostConfiguration(b, auth) });
    const diagnosis = await rt.diagnose('http://public.example/');
    expect(JSON.stringify(diagnosis)).not.toContain('secret');
    expect(JSON.stringify(diagnosis)).not.toContain(key);
    await rt.close();
  });
  it('reuses projected policy during requests but immediately observes external replacement and secret rotation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'varin-egress-projection-'));
    const filePath = join(root, 'settings.json');
    const store = createSettingsFileStore({ filePath });
    let validations = 0;
    let authReads = 0;
    let auth: Record<string, unknown> = {};
    const projection = store.createProjection(document => { validations++; return projectEgressSettings(document); });
    const egress = createEgressRuntime({
      env: {},
      getHostConfiguration: bindEgressHostConfiguration(projection, () => { authReads++; return auth; }),
    });
    const target = 'https://public.example/request';
    const setExternal = async (outboundNetwork: unknown) => {
      await writeFile(`${filePath}.external`, JSON.stringify({ outboundNetwork }));
      await rename(`${filePath}.external`, filePath);
    };
    try {
      await store.replace({ outboundNetwork: { mode: 'direct' }, unrelated: 'ignored' });
      const requests = await Promise.all(Array.from({ length: 12 }, () => egress.prepare(target)));
      expect(requests.every(request => request.policy.mode === 'direct')).toBe(true);
      expect(validations).toBe(1);
      expect(authReads).toBe(0);

      await setExternal({ mode: 'proxy', proxyUrl: 'http://proxy.test:8080', credentialRef: 'route-one' });
      const first = (await egress.prepare(target)).policy;
      expect(first).toMatchObject({ mode: 'proxy', proxyOrigin: 'http://proxy.test:8080' });
      expect(first.proxyAuth).toBeUndefined();
      auth = { [OUTBOUND_PROXY_CREDENTIAL_REF]: {
        type: 'api_key', key: encodeOutboundProxyAuth('route-one', 'http://proxy.test:8080', 'user', 'new-password'),
      } };
      const second = (await egress.prepare(target)).policy;
      expect(second.proxyAuth).toBe('basic');
      expect(second.fingerprint).not.toBe(first.fingerprint);
      expect(validations).toBe(2);
      expect(authReads).toBe(2);

      await setExternal({ mode: 'proxy', proxyUrl: 'invalid' });
      await expect(egress.fetch(target)).rejects.toThrow(/valid proxy URL/i);
      expect(validations).toBe(3);
      expect(authReads).toBe(2);
      await setExternal({ mode: 'direct' });
      expect((await egress.prepare(target)).policy.mode).toBe('direct');
      expect(validations).toBe(4);
    } finally {
      await egress.close();
      await rm(root, { recursive: true, force: true });
    }
  });

});
