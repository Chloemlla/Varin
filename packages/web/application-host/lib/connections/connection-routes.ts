import type { Express, RequestHandler } from 'express';
import { hasHostConnectionAccess, type ConnectionAccess } from './access.js';
import { HostSshManager } from './ssh-manager.js';
import { DeploymentPolicyDeniedError } from '../deployment/policy.js';
import { EgressError, type EgressFetch } from '../harness/egress.js';
import { readHostConnections, writeHostConnections } from './hosts.js';

export function registerConnectionRoutes(app: Express, ssh: HostSshManager, requireAuth: RequestHandler,
  options: { staticHosts: boolean; ssh: boolean; fetch: EgressFetch }): void {
  const route = (method: 'get' | 'post' | 'put' | 'delete', path: string, handle: (request: import('express').Request) => unknown | Promise<unknown>, access: ConnectionAccess = 'configuration') => {
    app[method](`/api/connections${path}`, requireAuth, async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      if (!hasHostConnectionAccess(request.varinAuth, access)) {
        response.status(403).json({ code: 'connection-permission-denied', error: 'Host-wide connection management permission is required' });
        return;
      }
      try {
        const enabled = path.startsWith('/ssh') ? options.ssh : options.staticHosts;
        if (!enabled) {
          if (method === 'get') {
            response.json(path === '/hosts' ? { hosts: [], defaultHostId: null, initialHostChoiceCompleted: true } : path === '/ssh' ? { instances: [] } : []);
            return;
          }
          throw new DeploymentPolicyDeniedError('connections', 'This connection type is disabled by the deployment policy');
        }
        response.json(await handle(request) ?? { ok: true });
      } catch (error) {
        if (error instanceof DeploymentPolicyDeniedError || error instanceof EgressError && error.kind === 'deployment-policy-denied') {
          response.status(403).json({ code: 'deployment-policy-denied', section: error instanceof DeploymentPolicyDeniedError ? error.section : 'egress', error: error.message });
        } else response.status(400).json({ error: error instanceof Error ? error.message : 'Connection operation failed' });
      }
    });
  };
  route('get', '/hosts', () => readHostConnections(ssh.settingsStore));
  route('put', '/hosts', (request) => writeHostConnections(ssh.settingsStore, request.body));
  route('get', '/ssh', () => ssh.readInstances());
  route('put', '/ssh', (request) => ssh.setInstances(request.body), 'execution');
  route('get', '/ssh/import', () => ssh.importHosts());
  route('get', '/ssh/status', (request) => ssh.statusesWithDefaults(typeof request.query.id === 'string' ? request.query.id : undefined));
  route('post', '/ssh/:id/connect', (request) => ssh.connect(request.params.id), 'execution');
  route('post', '/ssh/:id/disconnect', (request) => ssh.disconnect(request.params.id), 'execution');
  route('get', '/ssh/:id/logs', (request) => ssh.logsForInstance(String(request.params.id), request.query.limit ? Number(request.query.limit) : undefined));
  route('delete', '/ssh/:id/logs', (request) => ssh.clearLogsForInstance(String(request.params.id)));
  route('post', '/hosts/probe', async (request) => {
    const url = new URL(String(request.body?.url));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('An HTTP Host URL is required');
    const started = Date.now();
    try {
      const health = await options.fetch(new URL('health', `${url.href.replace(/\/$/u, '')}/`).href, { redirect: 'error' });
      if (!health.ok) {
        await health.body?.cancel();
        return { status: 'wrong-service', latencyMs: Date.now() - started };
      }
      const identity = await health.json() as { serverId?: string; varinVersion?: string; status?: string };
      if (identity.status !== 'ok' || typeof identity.varinVersion !== 'string') return { status: 'wrong-service', latencyMs: Date.now() - started };
      if (request.body.expectedServerId && identity.serverId !== request.body.expectedServerId) return { status: 'wrong-service', latencyMs: Date.now() - started };
      const headers = new Headers(request.body.requestHeaders ?? {});
      if (request.body.clientToken) headers.set('Authorization', `Bearer ${request.body.clientToken}`);
      const response = await options.fetch(new URL('auth/session', `${url.href.replace(/\/$/u, '')}/`).href, { headers, redirect: 'error' });
      await response.body?.cancel();
      return { status: response.ok ? 'ok' : response.status === 401 || response.status === 403 ? 'auth' : 'unreachable', latencyMs: Date.now() - started };
    } catch (error) {
      if (error instanceof EgressError && error.kind === 'deployment-policy-denied') throw error;
      return { status: 'unreachable', latencyMs: Date.now() - started };
    }
  });
}
