import type { ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import { isVarinExtensionId } from '@varin/extension-contract';
import { brokerFrame, extensionBrokerRoute, extensionIntegrity } from '../deployment/extension-sandbox-protocol.js';
import { createProviderLeaseOwner, type ResourceProvider } from '../deployment/resource-provider.js';
import { waitWithSignal } from '../cancellation.js';
import { holdSandboxReceiver, SANDBOX_RELAY, type SandboxReceiverLease } from './sandbox-receiver-lease.js';
import type { DurableEventInbox } from './event-inbox.js';

type Frame = Record<string, unknown>;
type Held = ReturnType<typeof holdSandboxReceiver>;
interface Peer {
  owner: ChildProcess;
  channel: string;
  socket: WebSocket;
  closed: Promise<void>;
  toSandbox: Map<string, { scope?: string; invocation?: string }>;
  toHost: Set<string>;
  frozen?: string;
  receivers?: Map<string, Held>;
  confirmedExit: boolean;
}
interface Frozen {
  owner: ChildProcess;
  peers: Map<Peer, Map<string, string>>;
}

/** Retains each authenticated broker stream independently of the Host IPC generation. */
export function createSupervisorSandbox(provider: ResourceProvider, journal: Pick<DurableEventInbox, 'accept'>, wake: () => void) {
  const allocations = createProviderLeaseOwner(provider);
  const peers = new Set<Peer>();
  const frozen = new Map<string, Frozen>();
  const send = (child: ChildProcess, message: Frame) => {
    if (child.connected) child.send({ type: SANDBOX_RELAY, ...message }, () => {});
  };
  const tell = (peer: Peer, kind: string, frame?: Frame) => send(peer.owner, { channel: peer.channel, kind, frame });
  const forward = (peer: Peer, frame: Frame) => {
    if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(frame), error => { if (error) peer.socket.terminate(); });
  };
  function receive(peer: Peer, frame: Frame) {
    const id = typeof frame.id === 'string' ? frame.id : undefined;
    if (frame.kind === 'exited') { peer.confirmedExit = true; return; }
    if (frame.kind === 'response' && id) {
      const original = peer.toSandbox.get(id);
      peer.toSandbox.delete(id);
      if (original?.invocation && peer.receivers) { peer.receivers.delete(original.invocation); wake(); }
    }
    if (!peer.receivers) {
      if (frame.kind === 'request' && id) peer.toHost.add(id);
      tell(peer, 'frame', frame);
      return;
    }
    if (frame.kind !== 'request' || !id) return;
    const params = brokerFrame(frame.params) ? frame.params : {};
    const receiver = typeof params.invocationId === 'string' ? peer.receivers.get(params.invocationId) : undefined;
    const result = receiver && frame.method === 'capability.call' ? receiver.call(params)
      : Promise.reject(new Error('event_receiver_capability_unavailable'));
    void result.then(value => forward(peer, { kind: 'response', id, success: true, result: value }),
      error => forward(peer, { kind: 'response', id, success: false, error: error.message }));
  }
  async function open(child: ChildProcess, message: Frame) {
    const { channel, resourceId, hostId, generation, extensionId, integrity } = message;
    if (typeof channel !== 'string' || typeof resourceId !== 'string' || typeof hostId !== 'string'
      || typeof extensionId !== 'string' || !isVarinExtensionId(extensionId) || typeof integrity !== 'string' || !extensionIntegrity.test(integrity)) throw new Error('Invalid supervised sandbox identity');
    const stop = new AbortController();
    const disconnect = () => stop.abort();
    child.once('disconnect', disconnect);
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(20_000)]);
    let release: (() => void) | undefined;
    try {
      const allocation = await allocations.acquire(resourceId, signal, extensionId);
      release = allocation.release;
      const descriptor = (await provider.describe(signal)).find(resource => resource.id === resourceId);
      if (descriptor?.hostId !== hostId || descriptor.role !== 'extensions' ||
          (descriptor.extensionId && descriptor.extensionId !== extensionId) || allocation.lease.generation !== generation)
        throw new Error('Supervised sandbox changed its owner');
      const address = new URL(allocation.lease.endpoint.replace(/\/$/u, '') + extensionBrokerRoute(extensionId, integrity));
      address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(address, { headers: { Authorization: 'Bearer ' + allocation.lease.bearer, 'X-Varin-Managed-Target': hostId }, followRedirects: false });
      let closed!: () => void;
      const peer: Peer = { owner: child, channel, socket, toSandbox: new Map(), toHost: new Set(), confirmedExit: false,
        closed: new Promise<void>(resolve => { closed = resolve; }) };
      peers.add(peer);
      const abortOpen = () => socket.terminate();
      signal.addEventListener('abort', abortOpen, { once: true });
      socket.once('open', () => { signal.removeEventListener('abort', abortOpen); tell(peer, 'open'); });
      socket.on('error', () => socket.terminate());
      socket.on('message', (data, binary) => {
        try {
          const frame: unknown = binary ? null : JSON.parse(data.toString());
          if (!brokerFrame(frame)) throw new Error('Invalid sandbox reply');
          receive(peer, frame);
        } catch { socket.terminate(); }
      });
      const finish = release;
      release = undefined;
      socket.once('close', () => {
        peers.delete(peer);
        signal.removeEventListener('abort', abortOpen);
        if (peer.receivers) wake();
        void Promise.all([...peer.receivers?.values() ?? []].map(value => value.seal())).finally(() => {
          tell(peer, 'closed', { confirmed: peer.confirmedExit });
          finish();
          closed();
        });
      });
    } finally { child.off('disconnect', disconnect); release?.(); }
  }

  function freeze(owner: ChildProcess, token: string, scopes: string[]) {
    const requested = new Set(scopes);
    const selected = new Map<Peer, Map<string, string>>();
    const matched = new Set<string>();
    for (const peer of peers) {
      if (peer.owner !== owner || peer.receivers) continue;
      const invocations = new Map<string, string>();
      for (const entry of peer.toSandbox.values()) {
        if (entry.scope && entry.invocation && requested.has(entry.scope)) invocations.set(entry.scope, entry.invocation);
      }
      if (invocations.size) {
        if (peer.frozen || peer.toHost.size || peer.toSandbox.size !== invocations.size || peer.socket.readyState !== WebSocket.OPEN)
          throw new Error('Extension broker still has live Host work');
        selected.set(peer, invocations);
        for (const scope of invocations.keys()) matched.add(scope);
      }
    }
    if (matched.size !== requested.size || !matched.size) throw new Error('Receiver invocation changed before parking');
    for (const peer of selected.keys()) { peer.frozen = token; peer.socket.pause(); }
    frozen.set(token, { owner, peers: selected });
  }
  function settle(owner: ChildProcess, token: string, leases?: SandboxReceiverLease[]) {
    const held = frozen.get(token);
    if (!held || held.owner !== owner) throw new Error('Receiver handoff does not belong to this Host');
    const byScope = new Map(leases?.map(lease => [lease.scope, lease]));
    if (leases) for (const [peer, scopes] of held.peers) {
      if (!peers.has(peer) || [...scopes.keys()].some(scope => !byScope.has(scope))) throw new Error('Receiver handed off with a different invocation');
    }
    frozen.delete(token);
    for (const [peer, scopes] of held.peers) {
      if (leases) {
        peer.receivers = new Map([...scopes].map(([scope, invocation]) =>
          [invocation, holdSandboxReceiver(byScope.get(scope)!, journal, wake)]));
        tell(peer, 'transferred');
      }
      delete peer.frozen;
      peer.socket.resume();
    }
  }
  async function returnReceivers() {
    // The next Host opens the original receiver from the reconciled Catalog
    // cursor. Settle all pages before it can start to replay.
    await Promise.all([...peers].filter(peer => peer.receivers).map(async peer => {
      await Promise.all([...peer.receivers!.values()].map(receiver => receiver.seal()));
      forward(peer, { kind: 'stop', force: false });
      try { await waitWithSignal(peer.closed, AbortSignal.timeout(7_000)); }
      catch { peer.socket.terminate(); await peer.closed; }
    }));
  }
  return {
    attach(child: ChildProcess) {
      child.on('message', (message: unknown) => {
        if (!brokerFrame(message) || message.type !== SANDBOX_RELAY) return;
        const peer = typeof message.channel === 'string' && [...peers].find(item => item.owner === child && item.channel === message.channel);
        if (message.kind === 'open') {
          void open(child, message).catch(() => send(child, { kind: 'closed', channel: message.channel, frame: { confirmed: true } }));
        } else if (message.kind === 'control' && typeof message.id === 'string') {
          try {
            const token = String(message.token);
            if (message.op === 'freeze') freeze(child, token, message.scopes as string[]);
            else settle(child, token, message.op === 'commit' ? message.leases as SandboxReceiverLease[] : undefined);
            send(child, { kind: 'ack', id: message.id, ok: true });
          } catch { send(child, { kind: 'ack', id: message.id, ok: false }); }
        } else if (peer && brokerFrame(message.frame)) {
          const frame = message.frame;
          if (peer.receivers) return;
          if (peer.frozen && frame.kind === 'request') {
            tell(peer, 'frame', { kind: 'response', id: frame.id, success: false, error: 'Event receiver is parking' });
            return;
          }
          if (frame.kind === 'request' && typeof frame.id === 'string') {
            const params = brokerFrame(frame.params) ? frame.params : {};
            peer.toSandbox.set(frame.id, {
              ...(typeof params.hostScopeId === 'string' && typeof params.invocationId === 'string' &&
                { scope: params.hostScopeId, invocation: params.invocationId }),
            });
            delete params.hostScopeId;
          } else if (frame.kind === 'response' && typeof frame.id === 'string') peer.toHost.delete(frame.id);
          forward(peer, frame);
        }
      });
      child.once('disconnect', () => {
        for (const [token, held] of frozen) if (held.owner === child) settle(child, token);
        for (const peer of peers) if (peer.owner === child && !peer.receivers) peer.socket.terminate();
      });
    },
    returnReceivers,
    async close() {
      await returnReceivers();
      const remaining = [...peers];
      for (const peer of remaining) peer.socket.terminate();
      await Promise.all(remaining.map(peer => peer.closed));
    },
  };
}
