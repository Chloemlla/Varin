import { randomUUID } from 'node:crypto';
import { brokerFrame } from '../deployment/extension-sandbox-protocol.js';
import { waitWithSignal } from '../cancellation.js';
import { SANDBOX_RELAY, type SandboxReceiverLease } from './sandbox-receiver-lease.js';

type Frame = Record<string, unknown>;
type Observer = (message: Frame) => void;

export class SandboxRelayClient {
  private readonly channels = new Map<string, Observer>();
  private readonly pending = new Map<string, Observer>();

  constructor() {
    process.on('message', this.receive);
    process.once('disconnect', this.disconnect);
  }

  private receive = (message: unknown) => {
    if (!brokerFrame(message) || message.type !== SANDBOX_RELAY) return;
    if (typeof message.id === 'string') this.pending.get(message.id)?.(message);
    if (typeof message.channel === 'string') this.channels.get(message.channel)?.(message);
  };
  private disconnect = () => {
    process.off('message', this.receive);
    for (const observer of this.channels.values()) observer({ kind: 'closed' });
    this.channels.clear();
    for (const observer of this.pending.values()) observer({ ok: false });
    this.pending.clear();
  };
  private send(message: Frame, callback: (error?: Error | null) => void) {
    if (process.send && process.connected) process.send({ type: SANDBOX_RELAY, ...message }, callback);
    else callback(new Error('Sandbox supervisor disconnected'));
  }

  open(resource: { id: string; hostId: string }, generation: string, extensionId: string, integrity: string, observer: Observer) {
    const id = randomUUID();
    this.channels.set(id, observer);
    const retire = () => this.channels.delete(id);
    this.send({ kind: 'open', channel: id, resourceId: resource.id, hostId: resource.hostId, generation, extensionId, integrity },
      error => { if (error) { retire(); observer({ kind: 'closed' }); } });
    return {
      send: (frame: unknown, callback?: (error?: Error | null) => void) => this.send({ kind: 'frame', channel: id, frame }, callback ?? (() => {})),
      close: retire,
    };
  }

  private async control(op: string, fields: Frame) {
    const id = randomUUID();
    const result = new Promise<void>((resolve, reject) => {
      this.pending.set(id, message => message.ok === true ? resolve() : reject(new Error('Event receiver handoff did not settle')));
      this.send({ kind: 'control', id, op, ...fields }, error => { if (error) reject(error); });
    });
    try { return await waitWithSignal(result, AbortSignal.timeout(5_000)); }
    finally { this.pending.delete(id); }
  }

  async freeze(scopes: string[]) {
    const token = randomUUID();
    try { await this.control('freeze', { token, scopes }); }
    catch (error) {
      await this.control('rollback', { token }).catch(() => undefined);
      throw error;
    }
    return {
      commit: (leases: SandboxReceiverLease[]) => this.control('commit', { token, leases }),
      rollback: () => this.control('rollback', { token }),
    };
  }
}
