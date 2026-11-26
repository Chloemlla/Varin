import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createDrainingAdmission } from '../draining-admission.js';
import { HOST_ACTIVITY_PATH, projectHostActivity, registerHostActivityRoute } from './host-activity.js';

it('serves authenticated, content-free owner activity even while shutting down', async () => {
  const app = express();
  app.use(createDrainingAdmission(() => true));
  const admission = vi.fn(async () => ({ localComputeActive: 3, queued: 2, privateBody: 'do not publish' }));
  const calendar = vi.fn(async () => ({
    nextWakeAtMs: 12_000, activeOccurrences: 4, pendingDelivery: 1, pendingPreparation: 1,
    unresolvedSchedules: 0, watchingAssets: true, privatePrompt: 'do not publish',
  }));
  registerHostActivityRoute(
    app,
    (req, res, next) => { if (!req.get('authorization')) res.sendStatus(401); else next(); },
    async req => req.get('authorization') === 'Bearer owner',
    signal => projectHostActivity({
      draining: () => true, kernelEpoch: () => 'same', observationStreams: () => 2, threadWrites: () => 1,
      externalIngressActive: () => true, admission, calendar,
      browser: () => ({preparing:1,activePageWrites:0,waitingPageWrites:0,outstandingStopConfirmations:0,privatePage:'do not publish'}),
      computerOperations: () => 1,
      dictation: () => ({state:'retiring',pendingRequests:0,sessions:0,warm:false,privateTranscript:'do not publish'}),
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
    version: 1, lifecycle: 'draining', catalog: { active: 3, queued: 2 },
    calendar: { nextWakeAtMs: 12_000, activeOccurrences: 4, pendingDelivery: 1, pendingPreparation: 1, unresolvedSchedules: 0, watchingAssets: true },
    retention: {
      observationStreams: 2, threadWrites: 1, externalIngressActive: true,
      reasons: ['host-draining', 'catalog-local-compute', 'catalog-queued-work', 'calendar-active-occurrence',
        'calendar-pending-delivery', 'calendar-reconciliation', 'calendar-asset-watch', 'calendar-wake-not-transferred',
        'http-observation-streams', 'http-thread-writes', 'external-ingress-active', 'browser-owner-activity', 'computer-owner-activity', 'dictation-owner-activity',
        'owner-coverage-incomplete', 'durable-supervisor-handoff-unavailable'],
    },
    owners: {browser:{preparing:1,activePageWrites:0,waitingPageWrites:0,outstandingStopConfirmations:0},
      computerOperations:1,dictation:{state:'retiring',pendingRequests:0,sessions:0,warm:false}},
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
  expect(result.owners).toEqual({browser:null,computerOperations:null,dictation:null});
  expect(result.retention.reasons).toContain('catalog-admission-unavailable');
  expect(result.parking).toEqual({ supported: false, eligible: false });
  expect(JSON.stringify(result)).not.toContain('secret content');
  const unavailable = await projectHostActivity({ ...owners, kernelEpoch: () => null }, new AbortController().signal);
  expect(unavailable.calendar).toBeNull();
  expect(unavailable.retention.reasons).toContain('calendar-unavailable');
  expect(calendar).toHaveBeenCalledTimes(1);
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
