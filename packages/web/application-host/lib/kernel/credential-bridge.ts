import { waitWithSignal } from '../cancellation.js';
import { isDeepStrictEqual } from 'node:util';
import type { ChildModelBinding, SourceMcpChildBinding, McpBinding, ExtensionToolBinding } from './protocol.generated.js';
import { modelCredentialBindingIdentity } from './model-binding-lifetime.js';
/** Private Host/kernel rendezvous. Secret replies bypass public RPC, event buses and histories. */
import { ExistingHostCredentialOwner, CredentialOwnerError, sameCredentialScope, type CredentialScope, type CredentialDispatch } from './credential-owner.js';
export interface PrivateCredentialResponse {
  v: 1; kind: 'credential-response'; id: string; kernelEpoch: string; ok: boolean;
  result?: { scope: CredentialScope; headers: { name: string; value: string }[] };
  error?: { code: string; message: string };
}
interface Request { v: 1; kind: 'credential-request'; id: string; kernelEpoch: string; runId: string; bindingId?: string | null; scope: CredentialScope; dispatch?: CredentialDispatch | null }
export type ChildModelHandoffSelection = { mcp: McpBinding | null; extensions: ExtensionToolBinding[] };
export type CredentialLifetime = { kind: 'run' } | { kind: 'operation'; operationId: string; assertLive?: () => Promise<void> }
  | { kind: 'child-operation'; binding: SourceMcpChildBinding; selection: ChildModelHandoffSelection };
interface OwnerEntry { claims?: { pending: number; accepted: boolean }; lifetime: CredentialLifetime; runId: string; owner: ExistingHostCredentialOwner; scope: CredentialScope; epoch: string; release: () => void; abort: AbortController; active: Set<string> }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const scopeValid = (value: unknown): value is CredentialScope => record(value)
  && ['reference', 'authority', 'account'].every(key => typeof value[key] === 'string' && Boolean(value[key]))
  && Number.isSafeInteger(value.generation) && Number(value.generation) >= 0;
const ownerKey = (runId: string, bindingId?: string | null) => JSON.stringify([runId, bindingId ?? null]);
export class CredentialBridge {
  readonly #owners = new Map<string, OwnerEntry>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivateCredentialResponse) => Promise<void>,
    private readonly transportFailed: () => void) {}
  async register(runId: string, owner: ExistingHostCredentialOwner, signal?: AbortSignal, bindingId?: string, lifetime: CredentialLifetime = { kind: 'run' }): Promise<CredentialScope> {
    const key = ownerKey(runId, bindingId);
    const epoch = this.currentEpoch();
    if (!epoch || !runId || bindingId === '' || (lifetime.kind === 'operation' && (!lifetime.operationId || !bindingId))
      || (lifetime.kind === 'child-operation' && (!bindingId || !lifetime.binding.operationId || lifetime.binding.parentRunId !== runId))
      || this.#owners.has(key)) throw new CredentialOwnerError('credential-owner-registration-invalid');
    const release = owner.retain();
    try {
      const scope = await waitWithSignal(owner.scope(), signal);
      signal?.throwIfAborted();
      if (this.currentEpoch() !== epoch || this.#owners.has(key)) throw new CredentialOwnerError('credential-owner-registration-stale');
      this.#owners.set(key, { lifetime, runId, owner, scope, epoch, release, abort: new AbortController(), active: new Set() });
      return { ...scope };
    } catch (error) { release(); throw error; }
  }
  /** Selection and start share a run binding. A failed caller rolls back only
   * when no other caller is using the lease or has committed it to the run. */
  async withModelBinding<T>(runId: string, bindingId: string | undefined, owner: ExistingHostCredentialOwner,
    signal: AbortSignal | undefined, invoke: (scope: CredentialScope) => Promise<T>): Promise<T> {
    const epoch = this.currentEpoch();
    const scope = await waitWithSignal(owner.scope(), signal);
    signal?.throwIfAborted();
    if (!epoch || epoch !== this.currentEpoch()) throw new CredentialOwnerError('credential-owner-registration-stale');
    const key = ownerKey(runId, bindingId);
    let entry = this.#owners.get(key);
    if (entry) {
      if (entry.epoch !== epoch || entry.lifetime.kind !== 'run' || !sameCredentialScope(entry.scope, scope)
        || (entry.owner !== owner && (!owner.bindingIdentity || entry.owner.bindingIdentity !== owner.bindingIdentity))) {
        throw new CredentialOwnerError('credential-scope-changed');
      }
    } else {
      entry = { runId, owner, scope, epoch, lifetime: { kind: 'run' }, release: owner.retain(),
        abort: new AbortController(), active: new Set(), claims: { pending: 0, accepted: false } };
      this.#owners.set(key, entry);
    }
    const claims = entry.claims;
    if (claims) claims.pending++;
    try {
      const result = await invoke({ ...scope });
      if (claims) claims.accepted = true;
      return result;
    } finally {
      if (claims && --claims.pending === 0 && !claims.accepted && this.#owners.get(key) === entry) {
        this.unregister(runId, bindingId ?? null);
      }
    }
  }
  findOwner(identity: string, scope: CredentialScope, runId?: string): ExistingHostCredentialOwner | undefined {
    for (const entry of this.#owners.values()) {
      if (entry.epoch !== this.currentEpoch() || (runId !== undefined && entry.runId !== runId)) continue;
      if (entry.owner.bindingIdentity === identity && sameCredentialScope(entry.scope, scope)) return entry.owner.fork();
      const dependency = entry.owner.findRetained(identity, scope);
      if (dependency) {
        // Child admission inherits the complete frozen dispatch catalog. Retain its
        // original selection graph as well as the chosen preset for nested dispatch.
        if (runId !== undefined) dependency.retainDependency(entry.owner);
        return dependency;
      }
    }
    return undefined;
  }
  /** ACK-before-admission handoff; the parent's terminal release cannot retire this child duty. */
  async retainChildModel(binding: SourceMcpChildBinding, model: ChildModelBinding, selection: ChildModelHandoffSelection): Promise<boolean> {
    if (!model.credential_scope) return true;
    if (!scopeValid(model.credential_scope)) return false;
    const identity = modelCredentialBindingIdentity(model.configuration);
    const bindingId = `child:model:${binding.operationId}`;
    const key = ownerKey(binding.parentRunId, bindingId);
    const matches = () => {
      const entry = this.#owners.get(key);
      return Boolean(entry && entry.epoch === this.currentEpoch() && entry.lifetime.kind === 'child-operation'
        && isDeepStrictEqual(entry.lifetime.binding, binding) && isDeepStrictEqual(entry.lifetime.selection, selection)
        && entry.owner.bindingIdentity === identity
        && sameCredentialScope(entry.scope, model.credential_scope!));
    };
    if (this.#owners.has(key)) return matches();
    const owner = this.findOwner(identity, model.credential_scope, binding.parentRunId);
    if (!owner) return false;
    try {
      await this.register(binding.parentRunId, owner, undefined, bindingId,
        { kind: 'child-operation', binding: structuredClone(binding), selection: structuredClone(selection) });
      return true;
    } catch (error) { if (matches()) return true; throw error; }
    finally { owner.release(); }
  }
  /** The selected model is retained by the original delegated duty, not the parent Run. */
  async retainSelectedChildModel(binding: SourceMcpChildBinding, owner: ExistingHostCredentialOwner,
    selection: ChildModelHandoffSelection, signal?: AbortSignal): Promise<CredentialScope> {
    if (!owner.bindingIdentity) throw new CredentialOwnerError('credential-model-identity-unavailable');
    const bindingId = `child:selected-model:${binding.operationId}`;
    const key = ownerKey(binding.parentRunId, bindingId);
    const scope = await waitWithSignal(owner.scope(), signal);
    signal?.throwIfAborted();
    const matchingScope = (): CredentialScope | undefined => {
      const entry = this.#owners.get(key);
      return entry && entry.epoch === this.currentEpoch() && entry.lifetime.kind === 'child-operation'
        && isDeepStrictEqual(entry.lifetime.binding, binding) && isDeepStrictEqual(entry.lifetime.selection, selection)
        && entry.owner.bindingIdentity === owner.bindingIdentity && sameCredentialScope(entry.scope, scope) ? { ...entry.scope } : undefined;
    };
    const retained = matchingScope();
    if (retained) return retained;
    try { return await this.register(binding.parentRunId, owner, signal, bindingId,
      { kind: 'child-operation', binding: structuredClone(binding), selection: structuredClone(selection) }); }
    catch (error) { const retained = matchingScope(); if (retained) return retained; throw error; }
  }
  releaseChildModel(parentRunId: string, operationId: string): void {
    for (const bindingId of [`child:model:${operationId}`, `child:selected-model:${operationId}`]) {
      if (this.#owners.get(ownerKey(parentRunId, bindingId))?.lifetime.kind === 'child-operation') this.unregister(parentRunId, bindingId);
    }
  }
  reconcileChildModels(children: readonly { operation_id: string; report: unknown }[]): void {
    const facts = new Map(children.map(child => [child.operation_id, child]));
    for (const entry of this.#owners.values()) {
      if (entry.lifetime.kind !== 'child-operation') continue;
      const binding = entry.lifetime.binding, child = facts.get(binding.operationId);
      if (child?.report || (!child && entry.epoch !== this.currentEpoch())) this.releaseChildModel(binding.parentRunId, binding.operationId);
    }
  }
  retainedChildOperationIds(): string[] {
    return [...this.#owners.values()].flatMap(entry => entry.lifetime.kind === 'child-operation' ? [entry.lifetime.binding.operationId] : []);
  }
  async retainQueuedModel(runId: string, owner: ExistingHostCredentialOwner): Promise<void> {
    const identity = owner.bindingIdentity;
    if (!identity) throw new CredentialOwnerError('credential-model-identity-unavailable');
    const bindingId = `admission:model:${identity}`;
    await this.withModelBinding(runId, bindingId, owner, undefined, async () => {});
  }
  releaseQueuedModel(runId: string, owner: ExistingHostCredentialOwner): void {
    if (owner.bindingIdentity) this.unregister(runId, `admission:model:${owner.bindingIdentity}`);
  }
  unregister(runId: string, bindingId?: string | null): void {
    for (const [key, entry] of this.#owners) {
      if (entry.runId === runId && (bindingId === undefined ? entry.lifetime.kind === 'run' : key === ownerKey(runId, bindingId))) {
        this.#owners.delete(key); entry.abort.abort(); entry.release();
      }
    }
  }
  close(): void { for (const entry of this.#owners.values()) { entry.abort.abort(); entry.release(); } this.#owners.clear(); }
  /** True for this private kind, even if invalid: never pass it to public protocol consumers. */
  consume(value: unknown): boolean {
    if (!record(value) || value.kind !== 'credential-request') return false;
    if (value.v !== 1 || typeof value.id !== 'string' || !value.id
      || typeof value.kernelEpoch !== 'string' || value.kernelEpoch !== this.currentEpoch()
      || typeof value.runId !== 'string' || !value.runId || !scopeValid(value.scope)
      || (value.bindingId !== undefined && value.bindingId !== null && (typeof value.bindingId !== 'string' || !value.bindingId))
      || Object.keys(value).some(key => !['v', 'kind', 'id', 'kernelEpoch', 'runId', 'bindingId', 'scope', 'dispatch'].includes(key))) return true;
    if (value.dispatch !== undefined && value.dispatch !== null && (!record(value.dispatch)
      || value.dispatch.method !== 'POST' || typeof value.dispatch.endpoint !== 'string'
      || typeof value.dispatch.payloadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.dispatch.payloadSha256)
      || Object.keys(value.dispatch).some(key => !['method', 'endpoint', 'payloadSha256'].includes(key)))) return true;
    const request = value as unknown as Request;
    const entry = this.#owners.get(ownerKey(request.runId, request.bindingId));
    if (!entry || entry.epoch !== request.kernelEpoch || !sameCredentialScope(entry.scope, request.scope)) {
      void this.#reject(request, 'credential-owner-unavailable');
      return true;
    }
    if (entry.active.has(request.id)) return true;
    entry.active.add(request.id);
    void this.#resolve(request, entry);
    return true;
  }
  async #reject(request: Request, code: string): Promise<void> {
    if (request.kernelEpoch !== this.currentEpoch()) return;
    try { await this.send({ v: 1, kind: 'credential-response', id: request.id, kernelEpoch: request.kernelEpoch,
      ok: false, error: { code, message: code } }); }
    catch { this.transportFailed(); }
  }
  async #resolve(request: Request, entry: OwnerEntry): Promise<void> {
    try {
      if(entry.lifetime.kind === 'operation')await entry.lifetime.assertLive?.();
      const result = await entry.owner.resolve(entry.scope, entry.abort.signal, request.dispatch ?? undefined);
      if(entry.lifetime.kind === 'operation')await entry.lifetime.assertLive?.();
      if (this.currentEpoch() !== request.kernelEpoch || this.#owners.get(ownerKey(request.runId, request.bindingId)) !== entry || entry.abort.signal.aborted) return;
      if (!sameCredentialScope(result.scope, entry.scope)) { await this.#reject(request, 'credential-scope-changed'); return; }
      await this.send({ v: 1, kind: 'credential-response', id: request.id, kernelEpoch: request.kernelEpoch, ok: true,
        result: { scope: result.scope, headers: Object.entries(result.headers).map(([name, value]) => ({ name, value })) } });
    } catch {
      if (this.currentEpoch() === request.kernelEpoch && this.#owners.get(ownerKey(request.runId, request.bindingId)) === entry && !entry.abort.signal.aborted) {
        await this.#reject(request, 'credential-resolution-failed');
      }
    } finally { entry.active.delete(request.id); }
  }
}
