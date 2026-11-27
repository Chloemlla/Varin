import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createDrainingAdmission } from '../draining-admission.js';
import { HOST_ACTIVITY_PATH, projectHostActivity, registerHostActivityRoute } from './host-activity.js';

it('serves authenticated, content-free owner activity even while shutting down', async () => {
  const app = express();
  app.use(createDrainingAdmission(() => true));
  const admission = vi.fn(async () => ({ localComputeActive: 3, queued: 2, nextWakeAtMs: 8_000, privateBody: 'do not publish' }));
  const calendar = vi.fn(async () => ({
    nextWakeAtMs: 12_000, activeOccurrences: 4, pendingDelivery: 1, pendingPreparation: 1,
    unresolvedSchedules: 0, watchingAssets: true, privatePrompt: 'do not publish',
  }));
  registerHostActivityRoute(
    app,
    (req, res, next) => { if (!req.get('authorization')) res.sendStatus(401); else next(); },
    async req => req.get('authorization') === 'Bearer owner',
    signal => projectHostActivity({
      draining: () => true, kernelEpoch: () => 'same', observationStreams: () => 2, threadWrites: () => 1, httpRequests: () => 0,
      externalIngressActive: () => true, admission, calendar,
      browser: () => ({preparing:1,activePageWrites:0,waitingPageWrites:0,outstandingStopConfirmations:0,privatePage:'do not publish'}),
      computerOperations: () => 1,
      dictation: () => ({state:'retiring',pendingRequests:0,sessions:0,warm:false,privateTranscript:'do not publish'}),
      execution: async () => ({authorities:3,activeProcess:true,activeFileOperations:false,activeComputation:false,privatePath:'do not publish'}),
      provider: () => ({preparing:0,active:0,releasing:1,privateEndpoint:'do not publish'}),
      terminal: () => ({ sessions:1, preparing:0, stopping:0 }),
      externalAgents: () => ({ sessions:0, opening:1, running:0, stopping:0, installations:0 }),
      mcp: () => ({ preparations:0, requests:0, retainedHolders:0, closing:0, tasks:1, subscriptions:0 }),
      eventSources: () => ({ receivers:1, reconciling:false, retries:0, privateCursor:'do not publish' }),
      eventTransport: () => ({ connections:0, reconciling:false, retries:1 }),
      language: () => ({ sourceViews:1, workspaceHolders:0, starting:0, stopping:0 }),
      preview: () => ({ requests:0, sockets:1 }),
      relay: () => ({ running:true, reconciling:false }),
      knowledgeRequests: () => 1,
      installingComponent: () => true,
    }, signal),
  );
  const unauthorized = await request(app).get(HOST_ACTIVITY_PATH).expect(401);
  expect(unauthorized.get('Cache-Control')).toBe('no-store');
  await request(app).get(HOST_ACTIVITY_PATH).set('Authorization', 'Bearer guest').expect(403);
  expect(admission).not.toHaveBeenCalled();
  expect(calendar).not.toHaveBeenCalled();
  const result = await request(app).get(HOST_ACTIVITY_PATH).set('Authorization', 'Bearer owner').expect(200);
  expect(result.get('Cache-Control')).toBe('no-store');
  expect(result.body).toEqual({
    version: 1, lifecycle: 'draining', catalog: { active: 3, queued: 2, nextWakeAtMs: 8_000 },
    calendar: { nextWakeAtMs: 12_000, activeOccurrences: 4, pendingDelivery: 1, pendingPreparation: 1, unresolvedSchedules: 0, watchingAssets: true },
    retention: {
      observationStreams: 2, threadWrites: 1, externalIngressActive: true,
      reasons: ['host-draining', 'catalog-local-compute', 'catalog-queued-work', 'catalog-wake-not-transferred', 'calendar-active-occurrence',
        'calendar-pending-delivery', 'calendar-reconciliation', 'calendar-asset-watch',
        'http-observation-streams', 'http-thread-writes', 'external-ingress-active', 'browser-owner-activity', 'computer-owner-activity', 'dictation-owner-activity',
        'execution-owner-activity', 'provider-execution-leases', 'terminal-owner-activity', 'external-agent-owner-activity', 'mcp-owner-activity',
        'event-receivers-not-transferred', 'event-transport-active', 'language-owner-activity', 'preview-owner-activity',
        'relay-owner-activity', 'knowledge-owner-activity', 'local-component-installing',
        'durable-supervisor-handoff-unavailable'],
    },
    owners: {browser:{preparing:1,activePageWrites:0,waitingPageWrites:0,outstandingStopConfirmations:0},
      computerOperations:1,dictation:{state:'retiring',pendingRequests:0,sessions:0,warm:false},
      execution:{authorities:3,activeProcess:true,activeFileOperations:false,activeComputation:false},
      provider:{preparing:0,active:0,releasing:1},
      terminal:{sessions:1,preparing:0,stopping:0},
      externalAgents:{sessions:0,opening:1,running:0,stopping:0,installations:0},
      mcp:{preparations:0,requests:0,retainedHolders:0,closing:0,tasks:1,subscriptions:0},
      eventSources:{receivers:1,reconciling:false,retries:0},eventTransport:{connections:0,reconciling:false,retries:1},
      language:{sourceViews:1,workspaceHolders:0,starting:0,stopping:0},preview:{requests:0,sockets:1},
      relay:{running:true,reconciling:false},knowledgeRequests:1,installingComponent:true},
    parking: { supported: false, eligible: false },
  });
});

it('keeps missing owner facts distinct from zero and never advertises parking', async () => {
  const admission = vi.fn(async () => { throw new Error('secret content'); });
  const calendar = vi.fn(async () => ({
    nextWakeAtMs: null, activeOccurrences: 0, pendingDelivery: 0, pendingPreparation: 0,
    unresolvedSchedules: 0, watchingAssets: false,
  }));
  const owners = {
    draining: () => false, kernelEpoch: () => 'same', observationStreams: () => 0, externalIngressActive: () => false,
    admission, calendar,
  };
  const result = await projectHostActivity(owners, new AbortController().signal);
  expect(result.catalog).toBeNull();
  expect(result.calendar?.activeOccurrences).toBe(0);
  expect(Object.values(result.owners).every(value => value === null)).toBe(true);
  expect(result.retention.reasons).toContain('catalog-admission-unavailable');
  expect(result.parking).toEqual({ supported: false, eligible: false });
  const requested = await projectHostActivity({ ...owners, parkingSupported: true }, new AbortController().signal);
  expect(requested.retention.reasons).toContain('owner-coverage-incomplete');
  expect(requested.parking.eligible).toBe(false);
  expect(JSON.stringify(result)).not.toContain('secret content');
  const unavailable = await projectHostActivity({ ...owners, kernelEpoch: () => null }, new AbortController().signal);
  expect(unavailable.calendar).toBeNull();
  expect(unavailable.retention.reasons).toContain('calendar-unavailable');
  expect(calendar).toHaveBeenCalledTimes(2);
});

it('does not combine Catalog and Calendar facts from different kernel epochs', async () => {
  let epoch = 'initial';
  const result = await projectHostActivity({
    kernelEpoch: () => epoch, draining: () => false, observationStreams: () => 0,
    externalIngressActive: () => false,
    admission: async () => ({ localComputeActive: 1, queued: 0 }),
    calendar: async () => {
      epoch = 'replacement';
      return { nextWakeAtMs: null, activeOccurrences: 0, pendingDelivery: 0, pendingPreparation: 0,
        unresolvedSchedules: 0, watchingAssets: false };
    },
  }, new AbortController().signal);
  expect(result.catalog).toBeNull();
  expect(result.calendar).toBeNull();
});
