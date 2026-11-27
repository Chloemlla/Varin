import type { Express, Request, RequestHandler } from 'express';
import type { AdmissionSummary } from '@varin/protocol';

export interface CalendarActivity {
  nextWakeAtMs: number | null;
  activeOccurrences: number;
  pendingDelivery: number;
  pendingPreparation: number;
  unresolvedSchedules: number;
  watchingAssets: boolean;
}

interface ActivityOwners {
  kernelEpoch(): string | null;
  draining(): boolean;
  observationStreams(): number;
  threadWrites?(): number;
  httpRequests?(): number;
  parkingSupported?: boolean;
  externalIngressActive(): boolean;
  admission(signal: AbortSignal): Promise<Pick<AdmissionSummary, 'localComputeActive' | 'queued'> & { nextWakeAtMs?: number | null }>;
  calendar(signal: AbortSignal): Promise<CalendarActivity>;
  browser?(): {preparing:number;activePageWrites:number;waitingPageWrites:number;outstandingStopConfirmations:number};
  computerOperations?(): number;
  dictation?(): {state:'cold'|'live'|'retiring';pendingRequests:number;sessions:number;warm:boolean} | null;
  execution?(signal: AbortSignal): Promise<{authorities:number;activeProcess:boolean;activeFileOperations:boolean;activeComputation:boolean}>;
  provider?(): {preparing:number;active:number;releasing:number} | null;
  terminal?(): {sessions:number;preparing:number;stopping:number} | null;
  externalAgents?(): {sessions:number;opening:number;running:number;stopping:number;installations:number};
  mcp?(): {preparations:number;requests:number;retainedHolders:number;closing:number;tasks:number;subscriptions:number};
  eventSources?(): {receivers:number;untransferred?:number;reconciling:boolean;retries:number};
  eventTransport?(): {connections:number;reconciling:boolean;retries:number};
  language?(): {sourceViews:number;workspaceHolders:number;starting:number;stopping:number};
  preview?(): {requests:number;sockets:number};
  relay?(): {running:boolean;reconciling:boolean} | null;
  knowledgeRequests?(): number;
  installingComponent?(): boolean;
}

export const HOST_ACTIVITY_PATH = '/api/system/lifecycle';

/** Incomplete coverage must never be mistaken for permission to stop. */
export const projectHostActivity = async (owners: ActivityOwners, signal: AbortSignal) => {
  const epoch = owners.kernelEpoch();
  const [admissionResult, calendarResult, executionResult] = epoch !== null
    ? await Promise.allSettled([
        Promise.resolve().then(() => owners.admission(signal)),
        Promise.resolve().then(() => owners.calendar(signal)),
        Promise.resolve().then(() => owners.execution?.(signal)),
      ])
    : [null, null, null] as const;
  const sameEpoch = epoch !== null && owners.kernelEpoch() === epoch;
  const admission = sameEpoch && admissionResult?.status === 'fulfilled'
    ? { active: admissionResult.value.localComputeActive, queued: admissionResult.value.queued,
        ...(admissionResult.value.nextWakeAtMs !== undefined ? { nextWakeAtMs: admissionResult.value.nextWakeAtMs } : {}) }
    : null;
  const calendar = sameEpoch && calendarResult?.status === 'fulfilled' ? calendarResult.value : null;
  const execution = sameEpoch && executionResult?.status === 'fulfilled' ? executionResult.value : undefined;
  const observations = owners.observationStreams();
  const threadWrites = owners.threadWrites?.() ?? null;
  const httpRequests = owners.httpRequests?.() ?? 0;
  const parkingSupported = owners.parkingSupported === true;
  const coverage = [
    owners.threadWrites, owners.httpRequests, owners.browser, owners.computerOperations, owners.dictation,
    owners.execution, owners.provider, owners.terminal, owners.externalAgents, owners.mcp, owners.eventSources,
    owners.eventTransport, owners.language, owners.preview, owners.relay, owners.knowledgeRequests,
    owners.installingComponent,
  ].every(owner => typeof owner === 'function');
  const ingress = owners.externalIngressActive();
  const draining = owners.draining();
  const browser = owners.browser?.() ?? null;
  const computerOperations = owners.computerOperations?.() ?? null;
  const dictation = owners.dictation?.() ?? null;
  const terminal = owners.terminal?.() ?? null;
  const provider = owners.provider?.() ?? null;
  const externalAgents = owners.externalAgents?.() ?? null;
  const mcp = owners.mcp?.() ?? null;
  const eventSources = owners.eventSources?.() ?? null;
  const eventTransport = owners.eventTransport?.() ?? null;
  const language = owners.language?.() ?? null;
  const preview = owners.preview?.() ?? null;
  const relay = owners.relay?.() ?? null;
  const knowledgeRequests = owners.knowledgeRequests?.() ?? null;
  const installingComponent = owners.installingComponent?.() ?? null;
  const retentionReasons = [
    ...(draining ? ['host-draining'] : []),
    ...(!admission ? ['catalog-admission-unavailable'] : []),
    ...(admission?.active ? ['catalog-local-compute'] : []),
    ...(admission?.queued ? ['catalog-queued-work'] : []),
    ...(!parkingSupported && admission?.nextWakeAtMs != null ? ['catalog-wake-not-transferred'] : []),
    ...(!calendar ? ['calendar-unavailable'] : []),
    ...(calendar?.activeOccurrences ? ['calendar-active-occurrence'] : []),
    ...(calendar?.pendingDelivery ? ['calendar-pending-delivery'] : []),
    ...(calendar?.pendingPreparation || calendar?.unresolvedSchedules ? ['calendar-reconciliation'] : []),
    ...(calendar?.watchingAssets ? ['calendar-asset-watch'] : []),
    ...(!parkingSupported && admission?.nextWakeAtMs === undefined && calendar?.nextWakeAtMs != null ? ['calendar-wake-not-transferred'] : []),
    ...(observations ? ['http-observation-streams'] : []),
    ...(threadWrites ? ['http-thread-writes'] : []),
    ...(httpRequests ? ['http-requests'] : []),
    ...(ingress ? ['external-ingress-active'] : []),
    ...(browser && (browser.preparing || browser.activePageWrites || browser.waitingPageWrites || browser.outstandingStopConfirmations)
      ? ['browser-owner-activity'] : []),
    ...(computerOperations ? ['computer-owner-activity'] : []),
    ...(dictation && (dictation.state === 'retiring' || dictation.pendingRequests || dictation.sessions)
      ? ['dictation-owner-activity'] : []),
    ...(owners.execution && !execution ? ['execution-owner-unavailable'] : []),
    ...(execution && (execution.authorities || execution.activeProcess || execution.activeFileOperations || execution.activeComputation)
      ? ['execution-owner-activity'] : []),
    ...(provider && (provider.preparing || provider.active || provider.releasing) ? ['provider-execution-leases'] : []),
    ...(terminal && (terminal.sessions || terminal.preparing || terminal.stopping) ? ['terminal-owner-activity'] : []),
    ...(externalAgents && (externalAgents.sessions || externalAgents.opening || externalAgents.running || externalAgents.stopping || externalAgents.installations)
      ? ['external-agent-owner-activity'] : []),
    ...(mcp && (mcp.preparations || mcp.requests || mcp.retainedHolders || mcp.closing || mcp.tasks || mcp.subscriptions)
      ? ['mcp-owner-activity'] : []),
    ...(eventSources && ((eventSources.untransferred ?? eventSources.receivers) || eventSources.reconciling || eventSources.retries) ? ['event-receivers-not-transferred'] : []),
    ...(eventTransport && (eventTransport.connections || eventTransport.reconciling || eventTransport.retries) ? ['event-transport-active'] : []),
    ...(language && (language.sourceViews || language.workspaceHolders || language.starting || language.stopping) ? ['language-owner-activity'] : []),
    ...(preview && (preview.requests || preview.sockets) ? ['preview-owner-activity'] : []),
    ...(relay && (relay.running || relay.reconciling) ? ['relay-owner-activity'] : []),
    ...(knowledgeRequests ? ['knowledge-owner-activity'] : []),
    ...(installingComponent ? ['local-component-installing'] : []),
    ...(!coverage ? ['owner-coverage-incomplete'] : []),
    ...(!parkingSupported ? ['durable-supervisor-handoff-unavailable'] : []),
  ];
  return {
    version: 1,
    lifecycle: draining ? 'draining' : 'running',
    catalog: admission,
    // Project every owner response explicitly; raw records may contain user content.
    calendar: calendar && {
      nextWakeAtMs: calendar.nextWakeAtMs,
      activeOccurrences: calendar.activeOccurrences,
      pendingDelivery: calendar.pendingDelivery,
      pendingPreparation: calendar.pendingPreparation,
      unresolvedSchedules: calendar.unresolvedSchedules,
      watchingAssets: calendar.watchingAssets,
    },
    retention: { observationStreams: observations, threadWrites, externalIngressActive: ingress, reasons: retentionReasons },
    owners: {
      browser: browser && {preparing:browser.preparing,activePageWrites:browser.activePageWrites,
        waitingPageWrites:browser.waitingPageWrites,outstandingStopConfirmations:browser.outstandingStopConfirmations},
      computerOperations,
      dictation: dictation && {state:dictation.state,pendingRequests:dictation.pendingRequests,sessions:dictation.sessions,warm:dictation.warm},
      execution: execution ? {authorities:execution.authorities,activeProcess:execution.activeProcess,
        activeFileOperations:execution.activeFileOperations,activeComputation:execution.activeComputation} : null,
      provider: provider && {preparing:provider.preparing,active:provider.active,releasing:provider.releasing},
      terminal: terminal && {sessions:terminal.sessions,preparing:terminal.preparing,stopping:terminal.stopping},
      externalAgents: externalAgents && {sessions:externalAgents.sessions,opening:externalAgents.opening,running:externalAgents.running,
        stopping:externalAgents.stopping,installations:externalAgents.installations},
      mcp: mcp && {preparations:mcp.preparations,requests:mcp.requests,retainedHolders:mcp.retainedHolders,
        closing:mcp.closing,tasks:mcp.tasks,subscriptions:mcp.subscriptions},
      eventSources: eventSources && {receivers:eventSources.receivers,reconciling:eventSources.reconciling,retries:eventSources.retries},
      eventTransport: eventTransport && {connections:eventTransport.connections,reconciling:eventTransport.reconciling,retries:eventTransport.retries},
      language: language && {sourceViews:language.sourceViews,workspaceHolders:language.workspaceHolders,
        starting:language.starting,stopping:language.stopping},
      preview: preview && {requests:preview.requests,sockets:preview.sockets},
      relay: relay && {running:relay.running,reconciling:relay.reconciling},
      knowledgeRequests, installingComponent,
    },
    parking: { supported: parkingSupported && coverage, eligible: parkingSupported && retentionReasons.length === 0 },
  } as const;
};

export type HostActivity = Awaited<ReturnType<typeof projectHostActivity>>;

export const registerHostActivityRoute = (
  app: Express,
  requireAuth: RequestHandler,
  authorize: (request: Request) => Promise<boolean>,
  activity: (signal: AbortSignal) => Promise<HostActivity>,
): void => {
  app.get(HOST_ACTIVITY_PATH, (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  }, requireAuth, async (request, response) => {
    try {
      if (!await authorize(request)) {
        response.status(403).json({ code: 'host-owner-required' });
        return;
      }
      response.json(await activity(AbortSignal.timeout(2000)));
    } catch {
      response.status(503).json({ code: 'host-activity-unavailable' });
    }
  });
};
