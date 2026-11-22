/** A pre-dispatch rejection is safe to record as no effect; an entered transport is uncertain. */
export class McpAuthorityError extends Error {
  constructor(readonly code: string, readonly dispatched = false,
    readonly settlement: 'unknown' | 'session_expired' | 'rpc_response' = 'unknown', readonly protocolError?: Record<string, unknown>, readonly interactionProblem?: string) { super(code); this.name = 'McpAuthorityError'; }
}
/** Only these owner-produced fields travel to logs and tool receipts. */
export type McpPreparationDetails = {
  server: string;
  stage: 'connect' | 'tools/list';
  httpStatus?: number;
  network?: import('../harness/egress.js').EgressErrorKind;
};
export class McpPreparationError extends McpAuthorityError {
  constructor(readonly details: McpPreparationDetails, needsAuth = details.httpStatus === 401 || details.httpStatus === 403) {
    super(needsAuth ? 'mcp-server-needs-auth' : details.stage === 'connect' ? 'mcp-connection-unavailable' : 'mcp-tools-list-failed');
    const action = details.stage === 'connect' ? 'connect' : 'list tools';
    const status = details.httpStatus === undefined ? details.network : `HTTP ${details.httpStatus}`;
    const reason = needsAuth ? `requires sign-in to ${action}` : `could not ${action}`;
    this.message = `MCP ${JSON.stringify(details.server)} ${reason}${status ? ` (${status})` : ''}.${needsAuth ? ' Check authorization in MCP settings.' : ''}`;
  }
}

export class McpTaskRequestError extends McpAuthorityError {
  constructor(code:string, dispatched:boolean, readonly kind:'protocol'|'transport'|'unsupported'|'owner',
    readonly rpcCode?:number, override readonly protocolError?:Record<string,unknown>, settlement:'unknown'|'session_expired'|'rpc_response'='unknown', interactionProblem?:string) { super(code,dispatched,settlement,protocolError,interactionProblem); }
}

/** Reviewed sampling rejection. The SDK edge maps this domain fact to its RPC error. */
export class McpSamplingRejectedError extends Error {
  constructor() { super('User rejected sampling request'); this.name = 'McpSamplingRejectedError'; }
}
