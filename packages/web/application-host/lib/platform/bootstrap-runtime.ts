import type { Express } from 'express';
import type expressModule from 'express';

import type { registerMobileRoutes } from '../mobile/routes.js';
import type { registerNotificationRoutes } from '../notifications/routes.js';
import type { registerTtsRoutes } from '../tts/routes.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';
import type {
  AuthAccessDependencies,
  CommonRequestMiddlewareDependencies,
  ServerStatusDependencies,
} from './core-routes.js';
import type { registerVarinRoutes } from './varin-routes.js';

type UiAuthOptions = NonNullable<Parameters<typeof createUiAuth>[0]>;
type UiAuthController = ReturnType<typeof createUiAuth>;
type NotificationDependencies = Parameters<typeof registerNotificationRoutes>[1];
type MobileDependencies = Parameters<typeof registerMobileRoutes>[1];
type TtsDependencies = Parameters<typeof registerTtsRoutes>[1];
type VarinDependencies = Parameters<typeof registerVarinRoutes>[1];

export type ServerBootstrapOptions =
  Omit<ServerStatusDependencies, 'express' | 'uiAuthController'>
  & Omit<AuthAccessDependencies, 'express' | 'uiAuthController'>
  & TtsDependencies
  & Omit<NotificationDependencies, 'uiAuthController'>
  & VarinDependencies
  & {
    clientPairingRuntime: AuthAccessDependencies['clientPairingRuntime'];
    mobileDeviceStore: MobileDependencies['deviceStore'];
    mobilePairingRuntime: MobileDependencies['pairingRuntime'];
    mobilePushRuntime: MobileDependencies['mobilePushRuntime'];
    uiPassword: UiAuthOptions['password'];
    gatewayOnly?: boolean;
    authenticateInboxReplay?: UiAuthOptions['authenticateInboxReplay'];
    updatesEnabled?: boolean;
    verboseRequestLogs?: CommonRequestMiddlewareDependencies['verboseRequestLogs'];
  };

export interface ServerBootstrapDependencies {
  createUiAuth(options: UiAuthOptions): UiAuthController;
  express: typeof expressModule;
  registerAuthAndAccessRoutes(app: Express, dependencies: AuthAccessDependencies): void;
  registerCommonRequestMiddleware(app: Express, dependencies: CommonRequestMiddlewareDependencies): void;
  registerMobileRoutes?: typeof registerMobileRoutes;
  registerNotificationRoutes: typeof registerNotificationRoutes;
  registerVarinRoutes: typeof registerVarinRoutes;
  registerServerStatusRoutes(app: Express, dependencies: ServerStatusDependencies): void;
  registerTtsRoutes: typeof registerTtsRoutes;
}

export const createServerBootstrapRuntime = (dependencies: ServerBootstrapDependencies) => {
  const {
    createUiAuth,
    registerServerStatusRoutes,
    registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes,
    registerTtsRoutes,
    registerNotificationRoutes,
    registerMobileRoutes,
    registerVarinRoutes,
    express,
  } = dependencies;

  const setupBaseRoutes = (app: Express, options: ServerBootstrapOptions): {
    uiAuthController: UiAuthController;
  } => {
    const {
      process,
      varinVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      verboseRequestLogs,
      uiPassword,
      tunnelAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      getRelayPairingCandidate,
      reconcileRelay,
      getPairingTransports,
      getDirectCandidateUrls,
      getExternalAccessOrigin,
      getServerId,
      getServerPort = () => null,
      getTunnelUrl = () => null,
      getServerLabel,
      readSettingsFromDisk,
      normalizeTunnelSessionTtlMs,
      sayTTSCapability,
      ensurePushInitialized,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      updateSettingsOnDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      updateUiVisibility,
      clearPendingPushBadge,
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      setPushInitialized,
      fs,
      path,
      server,
      __dirname,
      varinDataDir,
      mobileDeviceStore,
      mobilePairingRuntime,
      mobilePushRuntime,
    } = options;

    const uiAuthController = createUiAuth({
      password: uiPassword,
      issuedClientsOnly: options.gatewayOnly === true,
      ...(options.authenticateInboxReplay && { authenticateInboxReplay: options.authenticateInboxReplay }),
      readSettingsFromDisk,
      clientAuthController: remoteClientAuthRuntime,
      ...(getServerId ? { getServerId } : {}),
    });
    if (uiAuthController.enabled) {
      console.log('UI password protection enabled for browser sessions');
    }

    if (options.gatewayOnly) {
      app.use(async (req, res, next) => {
        if (req.method === 'GET' && (req.path === '/health' || req.path === '/live')) return next();
        const context = await uiAuthController.resolveRequestAuth(req);
        if (context?.type !== 'client' || !context.client || !context.clientId || !context.principalId) {
          res.status(401).json({ code: 'gateway-credential-required' });
          return;
        }
        req.varinAuth = { type: 'client', client: context.client, clientId: context.clientId, principalId: context.principalId };
        return uiAuthController.requirePrincipalAccess(req, res, next);
      });
    }

    registerServerStatusRoutes(app, {
      express,
      process,
      varinVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      tunnelAuthController,
      uiAuthController,
      ...(getServerId ? { getServerId } : {}),
      getServerPort,
      getTunnelUrl,
    });

    registerCommonRequestMiddleware(app, {
      express,
      ...(verboseRequestLogs !== undefined ? { verboseRequestLogs } : {}),
    });

    if (options.gatewayOnly) {
      app.get('/auth/session', uiAuthController.handleSessionStatus);
      app.post('/auth/url-token', uiAuthController.handleUrlAuthToken);
      app.use([
        '/auth', '/api/client-auth', '/api/mobile/pair', '/mobile-login', '/pair', '/connect',
        '/api/passkeys', '/api/auth/reset', '/api/varin/tunnel', '/api/varin/relay', '/api/varin/external-access',
      ], (_req, res) => {
        res.status(403).json({ code: 'deployment-policy-denied', section: 'ingress' });
      });
    } else registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController,
      uiAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      readSettingsFromDisk,
      normalizeTunnelSessionTtlMs,
      ...(getRelayPairingCandidate ? { getRelayPairingCandidate } : {}),
      ...(reconcileRelay ? { reconcileRelay } : {}),
      ...(getPairingTransports ? { getPairingTransports } : {}),
      ...(getDirectCandidateUrls ? { getDirectCandidateUrls } : {}),
      ...(getExternalAccessOrigin ? { getExternalAccessOrigin } : {}),
      ...(getServerId ? { getServerId } : {}),
      ...(getServerLabel ? { getServerLabel } : {}),
    });

    registerTtsRoutes(app, { sayTTSCapability, allowLocalSpeech: options.allowLocalSpeech !== false });

    registerNotificationRoutes(app, {
      uiAuthController,
      ensurePushInitialized,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      readSettingsFromDisk,
      updateSettingsOnDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      updateUiVisibility,
      ...(clearPendingPushBadge ? { clearPendingPushBadge } : {}),
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      setPushInitialized,
    });

    if (typeof registerMobileRoutes === 'function') {
      registerMobileRoutes(app, {
        uiAuthController,
        deviceStore: mobileDeviceStore,
        pairingRuntime: mobilePairingRuntime,
        mobilePushRuntime,
      });
    }

    if (options.updatesEnabled === false) app.use(['/api/varin/update-check', '/api/varin/update-install'], (_req, res) => {
      res.status(403).json({ code: 'deployment-policy-denied', section: 'background' });
    });
    else registerVarinRoutes(app, {
      fs,
      path,
      process,
      server,
      __dirname,
      varinDataDir,
    });

    return {
      uiAuthController,
    };
  };

  return {
    setupBaseRoutes,
  };
};
