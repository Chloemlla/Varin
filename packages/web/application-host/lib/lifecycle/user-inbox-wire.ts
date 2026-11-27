export const INBOX_STATUS_PATH = '/api/threads/inbox/status';
export const INBOX_RECONCILE_PATH = '/api/threads/inbox/reconcile';
export const INBOX_REPLAY_HEADER = 'x-varin-supervisor-replay';
export const INBOX_ACTOR_HEADER = 'x-varin-supervisor-actor';
export const INBOX_REQUEST_BYTES = 50 * 1024 * 1024;
const methods = ['submit', 'enqueue', 'attachments/upload', 'materials/upload'] as const;
export type InboxMethod = typeof methods[number];
export const inboxMethod = (pathname: string): InboxMethod | undefined =>
  methods.find(method => pathname === '/api/threads/' + method);
export interface InboxActor { principalId: string; clientId: string }
export interface InboxResult { status: number; body: unknown }
export interface InboxReceipt { kind: 'inbox_accepted'; inboxId: string; key: string }
