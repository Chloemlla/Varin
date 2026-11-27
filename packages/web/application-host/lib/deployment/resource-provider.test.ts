import { expect, it, vi } from 'vitest';
import { createProviderLeaseOwner, type ProviderLease, type ResourceProvider } from './resource-provider.js';

it('shares a pending allocation and releases a late lease after every waiter cancels', async () => {
  let ready!: (value: ProviderLease) => void;
  const pending = new Promise<ProviderLease>(resolve => { ready = resolve; });
  const provider: ResourceProvider = {
    id: 'test',
    acquire: vi.fn(() => pending),
    release: vi.fn(async () => {}),
    describe: vi.fn(), renew: vi.fn(), status: vi.fn(), retire: vi.fn(),
  };
  const { acquire, activity } = createProviderLeaseOwner(provider);
  const one = new AbortController(), two = new AbortController();
  const first = acquire('workspace', one.signal), second = acquire('workspace', two.signal);
  expect(activity()).toEqual({ preparing: 1, active: 0, releasing: 0 });
  one.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  expect(provider.acquire).toHaveBeenCalledTimes(1);
  expect(provider.release).not.toHaveBeenCalled();
  two.abort();
  await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  expect(activity()).toEqual({ preparing: 0, active: 0, releasing: 1 });
  const identity = { resourceId: 'workspace', leaseId: vi.mocked(provider.acquire).mock.calls[0]![0].leaseId, generation: 'one' };
  ready({ ...identity, bearer: 'token', expiresAt: Date.now() + 60_000, endpoint: 'http://127.0.0.1' });
  await expect.poll(() => vi.mocked(provider.release).mock.calls).toEqual([[identity]]);
  await expect.poll(activity).toEqual({ preparing: 0, active: 0, releasing: 0 });
});

it('retries renewal and lets new holders acquire after an expired lease while earlier holders unwind', async () => {
  vi.useFakeTimers();
  const initial = { endpoint: 'http://127.0.0.1', bearer: 'test', generation: 'generation-1' };
  const acquireProvider = vi.fn<ResourceProvider['acquire']>(async identity => ({ ...identity, ...initial, expiresAt: Date.now() + 1000 }));
  const renew = vi.fn<ResourceProvider['renew']>().mockRejectedValue(new Error('temporary failure'))
    .mockImplementationOnce(async () => { throw new Error('temporary failure'); })
    .mockImplementationOnce(async identity => ({ ...initial, ...identity, expiresAt: Date.now() + 500 }));
  const provider: ResourceProvider = { id: 'fixture', acquire: acquireProvider, renew, release: vi.fn(async () => {}),
    describe: vi.fn(), status: vi.fn(), retire: vi.fn() };
  const { acquire } = createProviderLeaseOwner(provider);
  try {
    const first = await acquire('workspace');
    await vi.advanceTimersByTimeAsync(750);
    expect(renew).toHaveBeenCalledTimes(2);
    const during = await acquire('workspace');
    expect(during.lease.leaseId).toBe(first.lease.leaseId);
    during.release();
    await vi.advanceTimersByTimeAsync(600);
    const later = await acquire('workspace');
    expect(later.lease.leaseId).not.toBe(first.lease.leaseId);
    first.release();
    later.release();
  } finally { vi.useRealTimers(); }
});
