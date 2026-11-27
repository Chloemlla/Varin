import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Express, Request, Response } from 'express';
import { attachDesktopMedia } from './desktop-media.js';
import { registerComputerRoutes } from './computer-routes.js';
import type { ComputerService } from './computer-service.js';

export const COMPUTER_NODE_OBSERVE = 'computer:observe';
export const COMPUTER_NODE_CONTROL = 'computer:control';
export const COMPUTER_NODE_SYSTEM = 'computer:system';
export interface ComputerNodeCredential { clientId: string; capabilities: readonly string[] }
type Access = 'observe' | 'control' | 'system';
const target = /^\/desktops\/[^/]+\/(.+)$/u;
const isReadApplication = (verb: string, body: Request['body']) => verb === 'browser'
  ? ['status', 'tabs', 'snapshot'].includes(body?.op) || body?.op === 'act' && body?.act?.kind === 'screenshot'
  : ['status', 'docs'].includes(body?.op) || body?.op === 'act' && body?.act?.kind === 'read';

function requiredAccess(method: string, path: string, body: Request['body']): Access | undefined {
  if (method === 'GET' && (path === '/' || path === '') || method === 'POST' && path === '/refresh') return 'observe';
  if (method === 'POST' && ['/desktops/prepare-target', '/desktops/prepare'].includes(path)) return 'system';
  const op = target.exec(path)?.[1];
  if (!op) return;
  if (method === 'GET') return ['control', 'stream', 'apps', 'artifacts/read'].includes(op) ? 'observe' : undefined;
  if (method !== 'POST') return;
  if (op === 'assignment') {
    if (body?.access === 'observe') return 'observe';
    if (body?.access === 'control') return 'control';
    return;
  }
  if (['observe', 'query', 'await', 'probe', 'evidence', 'artifacts/inspect'].includes(op)) return 'observe';
  if (op === 'browser' || op === 'office') {
    // Executable/profile selection is configuration of the owning device, not generic input.
    if (body?.binary !== undefined || body?.profile !== undefined) return 'system';
    return isReadApplication(op, body) ? 'observe' : 'control';
  }
  if (op === 'open') {
    if (body?.command !== undefined || body?.path !== undefined || body?.args !== undefined) return 'system';
    return typeof body?.url === 'string' && /^https?:\/\//iu.test(body.url) ? 'control' : 'system';
  }
  if (['act', 'cancel', 'release', 'takeover', 'handback', 'input', 'stop'].includes(op)) return 'control';
  if (['prepare', 'lifecycle', 'software', 'artifacts/write'].includes(op)) return 'system';
  // Keep VM administration, default configuration writes and general Host APIs absent.
}

export function mountComputerNodeRole(options: {
  app: Express; server: Server; computers: ComputerService; hostId: string;
  authenticate(request: IncomingMessage): Promise<ComputerNodeCredential | undefined>;
  isDraining(): boolean;
}) {
  const { app, server, computers, hostId, authenticate, isDraining } = options;
  const admitted = new WeakMap<Request, ComputerNodeCredential>();
  const observers = new Set<Response>();
  const processing = new Set<Response>();
  const bootLeaseKey = randomBytes(32);
  const namespace = (request: Request) => {
    const principal = admitted.get(request);
    if (!principal) throw new Error('Unadmitted Computer peer');
    return 'computer-peer:' + createHash('sha256').update(principal.clientId).digest('base64url') + ':';
  };
  const signature = (clientId: string, token: string) => createHmac('sha256', bootLeaseKey)
    .update(JSON.stringify([clientId, token])).digest();
  const requirePeer = async (req: Request, res: Response, proceed: () => void) => {
    if (admitted.has(req)) { proceed(); return; }
    if (isDraining()) { res.status(503).json({ code: 'host-draining' }); return; }
    const principal = await authenticate(req);
    if (!principal?.capabilities.includes(COMPUTER_NODE_OBSERVE)) {
      res.status(principal ? 403 : 401).json({ code: 'computer-peer-required' }); return;
    }
    res.setHeader('X-Varin-Computer-Host', hostId);
    if (isDraining()) { res.status(503).json({ code: 'host-draining' }); return; }
    const access = requiredAccess(req.method, req.path, req.body);
    if (!access) { res.status(404).json({ code: 'computer-node-operation-unavailable' }); return; }
    if (access !== 'observe' && !principal.capabilities.includes(COMPUTER_NODE_CONTROL) ||
        access === 'system' && !principal.capabilities.includes(COMPUTER_NODE_SYSTEM)) {
      res.status(403).json({ code: 'computer-peer-scope', error: 'The Computer peer was not granted this operation',
        computerExecution: { inputWriterStopped: true, receipt: { effect: 'none' } } }); return;
    }
    admitted.set(req, principal);
    res.setHeader('Cache-Control', 'no-store');
    const rawHeader = req.get('X-Varin-Computer-Lease');
    if (rawHeader) {
      const i = rawHeader.lastIndexOf('.');
      const raw = rawHeader.slice(0, i), bytes = Buffer.from(rawHeader.slice(i + 1), 'base64url');
      const wanted = signature(principal.clientId, raw);
      if (i < 1 || bytes.length !== wanted.length || !timingSafeEqual(bytes, wanted)) {
        // This is a pre-dispatch denial; preserve the original owning-Host
        // identity rather than allowing the coordinator to infer unknown input.
        res.setHeader('X-Varin-Computer-Host', hostId);
        res.status(409).json({ code: 'forbidden', error: 'Computer assignment belongs to another peer or node process',
          computerExecution: { inputWriterStopped: true, receipt: { effect: 'none' } } });
        return;
      }
      req.headers['x-varin-computer-lease'] = raw;
    }
    const op = target.exec(req.path)?.[1];
    if (op && ['takeover', 'handback', 'input'].includes(op) &&
        (typeof req.body?.holderId !== 'string' || !req.body.holderId.trim() || req.body.holderId.length > 256)) {
      res.status(400).json({ code: 'invalid-params', error: 'A Computer viewer identity is required' }); return;
    }
    if (op === 'assignment' && typeof req.body?.origin === 'string') {
      if (!req.body.origin.trim() || req.body.origin.length > 256) {
        res.status(400).json({ code: 'invalid-params' }); return;
      }
      req.body = { ...req.body, origin: namespace(req) + req.body.origin };
      if (req.body.op === 'claim') {
        const json = res.json.bind(res);
        res.json = (body?: unknown) => {
          const token = body && typeof body === 'object' && 'token' in body ? body.token : undefined;
          return json(typeof token === 'string' ? { token: token + '.' + signature(principal.clientId, token).toString('base64url') } : body);
        };
      }
    }
    if (op === 'lifecycle' || op === 'prepare' || req.path === '/desktops/prepare') {
      const json = res.json.bind(res);
      res.json = (body?: unknown) => {
        if (!body || typeof body !== 'object' || !('endedAssignments' in body) ||
            !body.endedAssignments || typeof body.endedAssignments !== 'object') return json(body);
        const { endedAssignments, ...publicResult } = body;
        const prefix = namespace(req);
        // The normal coordinator matches this receipt to the same origin it
        // sent when taking the assignment. Other peers' origins stay private.
        if ('origin' in endedAssignments && typeof endedAssignments.origin === 'string' && endedAssignments.origin.startsWith(prefix)) {
          return json({ ...publicResult, endedAssignments: { ...endedAssignments, origin: endedAssignments.origin.slice(prefix.length) } });
        }
        return json(publicResult);
      };
    }
    if (op === 'stream') { observers.add(res); res.once('close', () => observers.delete(res)); }
    processing.add(res);
    res.once('close', () => processing.delete(res));
    proceed();
  };
  app.use('/api/computers', (req, res, next) => { void requirePeer(req, res, next).catch(next); });
  // Only admitted requests arrive at the original routes below.
  registerComputerRoutes(app, { computers, hostId, requireAuth: (req, res, next) => {
    if (admitted.has(req)) next(); else res.status(403).json({ code: 'computer-peer-required' });
  }, viewerIdentity: {
    admit: (req, viewer) => namespace(req) + viewer,
    project: (req, control) => {
      if (!control.holderId) return control;
      const prefix = namespace(req);
      if (control.holderId.startsWith(prefix)) return { ...control, holderId: control.holderId.slice(prefix.length) };
      const { holderId: _other, ...publicControl } = control;
      return publicControl;
    },
  } });
  const media = attachDesktopMedia({ server, computers, hostId, isDraining,
    authenticate: async req => !!(await authenticate(req))?.capabilities.includes(COMPUTER_NODE_OBSERVE),
    // A deployed role is an authenticated Host-to-Host media target, not a cookie login origin.
    originAllowed: req => !req.headers.origin,
  });
  let closed = false;
  return {
    async canRetire() { return !processing.size && !media.busy() && await computers.canRetire() && !processing.size && !media.busy(); },
    closeObservers() { if (closed) return; closed = true; for (const res of observers) res.destroy(); observers.clear(); media.stop(); },
  };
}
