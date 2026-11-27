import type { InboxActor, InboxMethod, InboxReceipt, InboxResult } from './user-inbox-wire.js';

export interface InboxCommand {
  actor: InboxActor;
  method: InboxMethod;
  threadId: string;
  branchId: string;
  key: string;
  url: string;
  body: Uint8Array;
}
export interface InboxEntry extends InboxCommand {
  id: string;
  replayMethod: InboxMethod;
  queueNext: boolean;
  /** Starts when this entry reaches the head of its branch for the first replay. */
  firstAttemptAtMs: number;
}
type Pending<T> = T | Promise<T>;

/** Durable, scope-aware ingress. Replay leaves uncertain receipts in their original lane. */
export interface IngressInbox {
  accept(command: InboxCommand): Pending<InboxReceipt>;
  find(command: InboxCommand): Pending<InboxReceipt | undefined>;
  status(principal: string, id: string): Pending<InboxResult | null | undefined>;
  hasPending(scope?: Pick<InboxCommand, 'actor' | 'threadId' | 'branchId'>): Pending<boolean>;
  replay(receive: (entry: InboxEntry) => Promise<InboxResult>, signal: AbortSignal, settled?: () => void): Promise<void>;
}

export class InboxError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
