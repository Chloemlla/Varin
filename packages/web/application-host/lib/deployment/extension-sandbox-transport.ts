import { Readable } from 'node:stream';
import { create as archive } from 'tar';
import WebSocket from 'ws';
import { BrokeredHostRpcTransport, BrokeredHostUnavailableError, type BrokeredHostChannel, type BrokeredHostTransportFactory } from '@varin/extension-host';
import { brokerFrame, extensionBrokerRoute, extensionIdentityRoute, extensionSandboxProtocolVersion } from './extension-sandbox-protocol.js';
import { createProviderLeaseOwner, type ResourceProvider } from './resource-provider.js';
import type { SandboxRelayClient } from '../lifecycle/sandbox-relay-client.js';

/** The allocation and bidirectional capability channel belong to one verified extension owner. */
export function extensionSandboxTransport(provider: ResourceProvider, leases = createProviderLeaseOwner(provider),
  relay?: SandboxRelayClient, scope: 'user' | 'extension' = 'user'): BrokeredHostTransportFactory {
  return options => {
    const opening = new AbortController();
    let stream: WebSocket | undefined;
    let ready = false;
    let receivedExit = false;
    let relayed: ReturnType<SandboxRelayClient['open']> | undefined;
    const channel: BrokeredHostChannel = {
      connected: () => ready && (relayed !== undefined || stream?.readyState === WebSocket.OPEN),
      send(message, callback) {
        if (brokerFrame(message) && message.kind === 'request' && brokerFrame(message.params)) {
          const { method, params } = message;
          if (method === 'activate') message = { ...message, params: { storage: params.storage, dependencies: params.dependencies } };
          else if (method === 'migrate') message = { ...message, params: { input: params.input } };
        }
        if (relayed) relayed.send(message, error => callback?.(error ?? null));
        else stream!.send(JSON.stringify(message), error => callback?.(error ?? null));
      },
      stop(force) {
        if (relayed) relayed.send({ kind: 'stop', force });
        else if (channel.connected()) stream!.send(JSON.stringify({ kind: 'stop', force }));
        else if (!ready) opening.abort(new BrokeredHostUnavailableError('Extension sandbox preparation stopped'));
      },
      observe(events) {
        void (async () => {
          const signal = opening.signal;
          let release: (() => void) | undefined;
          let opened = false;
          try {
            const extensionId = options.owner.extensionId;
            const resources = (await provider.describe(signal)).filter(resource =>
              resource.role === 'extensions' && resource.extensionId === (scope === 'extension' ? extensionId : undefined));
            if (resources.length !== 1) throw new BrokeredHostUnavailableError('An isolated execution target is required for this extension');
            const resource = resources[0]!;
            const allocation = await leases.acquire(resource.id, signal, extensionId);
            release = allocation.release;
            const url = (route: string) => allocation.lease.endpoint.replace(/\/$/u, '') + route;
            const headers = { Authorization: 'Bearer ' + allocation.lease.bearer, 'X-Varin-Managed-Target': resource.hostId };
            const identity = await fetch(url(extensionIdentityRoute(extensionId)), { headers, redirect: 'error', signal });
            if (!identity.ok || identity.headers.get('x-varin-managed-host') !== resource.hostId) {
              await identity.body?.cancel();
              throw new BrokeredHostUnavailableError('Extension sandbox identity changed');
            }
            const body: unknown = await identity.json();
            if (!brokerFrame(body) || body.protocolVersion !== extensionSandboxProtocolVersion || body.role !== 'extensions' || body.extensionId !== resource.extensionId) {
              throw new BrokeredHostUnavailableError('Incompatible extension sandbox identity');
            }
            const { root, files } = await options.artifact.open(signal);
            const source = Readable.from(archive({ cwd: root, portable: true, noDirRecurse: true, strict: true }, files));
            const route = extensionBrokerRoute(extensionId, options.artifact.integrity);
            const response = await fetch(url(route), { method: 'PUT', headers, body: Readable.toWeb(source), duplex: 'half',
              redirect: 'error', signal } as RequestInit & { duplex: 'half' }).finally(() => source.destroy());
            await response.body?.cancel();
            if (!response.ok || response.headers.get('x-varin-managed-host') !== resource.hostId) throw new BrokeredHostUnavailableError('Extension sandbox rejected the verified artifact');
            signal.throwIfAborted();
            if (relay) {
              const transferred = await new Promise<boolean>(resolve => {
                relayed = relay.open(resource, allocation.lease.generation, extensionId, options.artifact.integrity, message => {
                  if (message.kind === 'open') { opened = true; ready = true; }
                  if (message.kind === 'frame' && brokerFrame(message.frame)) events.received(message.frame);
                  if (message.kind === 'transferred') resolve(true);
                  if (message.kind === 'closed') { receivedExit = brokerFrame(message.frame) && message.frame.confirmed === true; resolve(false); }
                });
                signal.addEventListener('abort', () => { relayed?.send({ kind: 'stop', force: true }); resolve(false); }, { once: true });
              });
              relayed?.close(); relayed = undefined;
              ready = false;
              if (transferred) events.transferred();
              else events.stopped(new BrokeredHostUnavailableError('Supervised extension sandbox stream closed'), receivedExit || !opened);
              return;
            }
            const address = new URL(url(route));
            address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
            stream = new WebSocket(address, { headers, followRedirects: false, signal });
            await new Promise<void>(resolve => {
              stream!.once('open', () => { opened = true; ready = true; });
              stream!.on('error', error => { if (opened) events.failed(error); });
              stream!.on('message', (data, binary) => {
                try {
                  const message: unknown = binary ? null : JSON.parse(data.toString());
                  if (!brokerFrame(message)) throw new Error('Invalid extension sandbox response');
                  if (message.kind === 'exited') receivedExit = true;
                  else events.received(message);
                } catch (error) { events.failed(error as Error); }
              });
              stream!.once('close', () => resolve());
            });
            events.stopped(new BrokeredHostUnavailableError('Extension sandbox stream closed'), receivedExit || !opened);
          } catch (error) {
            events.stopped(error instanceof Error ? error : new Error(String(error)), !opened || receivedExit);
          } finally {
            release?.();
          }
        })();
      },
    };
    return new BrokeredHostRpcTransport({ channel, onCrash: options.onCrash, requestFromChild: options.requestFromExtension,
      transfersInvocationScopes: Boolean(relay) });
  };
}
