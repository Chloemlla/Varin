import { getRuntimeEndpointGeneration, type ThreadModel } from '@varin/application-client';
import { VARIN_WORKBENCH_BOT_PROFILE_ID } from '@varin/extension-contract';
import { useBotNavigation } from '@/lib/bots';
import { findMarkerComposer } from '@/components/chat/composer/editor/markerComposerRegistry';
import { currentWorkbenchProfileId } from './threadNavigation';
import { setThreadComposerModel } from './threadComposerModel';
import { useThreadStore, selectedComposerKey, threadComposerKey } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { useUIStore } from '@/stores/useUIStore';

function modelShortcutTarget() {
  const navigation = useThreadStore.getState();
  if (currentWorkbenchProfileId() === VARIN_WORKBENCH_BOT_PROFILE_ID) {
    const local = navigation.selectedDraftKey;
    if (local && useThreadDraftStore.getState().drafts[local]?.botId && findMarkerComposer(local)) {
      return { identity: null, draftKey: local };
    }
    const identity = useBotNavigation.getState().entry;
    const key = identity && threadComposerKey(navigation.hostKey, identity);
    return { identity, draftKey: key && findMarkerComposer(key) ? key : null };
  }
  return { identity: navigation.selectedIdentity, draftKey: selectedComposerKey(navigation) };
}

export async function cycleThreadModel(direction?: -1 | 1): Promise<void> {
  const { identity, draftKey } = modelShortcutTarget();
  const api = getRegisteredRuntimeAPIs()?.threads;
  if (!draftKey || !api) return;
  const host = getRuntimeEndpointGeneration();
  const [snapshot, models] = await Promise.all([identity ? api.snapshot(identity) : null, api.listModels()]);
  if (host !== getRuntimeEndpointGeneration() || modelShortcutTarget().draftKey !== draftKey) return;
  const draft = useThreadDraftStore.getState().drafts[draftKey];
  if (draft?.firstSend) return;
  const run = snapshot?.activeRun;
  const config = (snapshot?.modelSelection.desired?.configuration ?? run?.configuration) as { providerId?: string; model?: string; thinkingLevel?: ThreadModel['thinkingLevel']; catalogModelId?: string } | undefined;
  const current = snapshot?.thread.model_preference ?? (run && config?.providerId && config.model ? { providerId: config.providerId, modelId: config.catalogModelId ?? config.model, thinkingLevel: config.thinkingLevel } : draft?.model);
  let model: ThreadModel | undefined;
  if (direction) {
    const favorites = useUIStore.getState().favoriteModels;
    const available = favorites.flatMap(favorite => models.filter(model => model.providerId === favorite.providerID && model.modelId === favorite.modelID));
    if (!available.length) return;
    const index = available.findIndex(model => model.providerId === current?.providerId && model.modelId === current.modelId);
    const base = index === -1 ? (direction > 0 ? -1 : 0) : index;
    const next = available[(base + direction + available.length) % available.length]!;
    const levels = next.thinkingLevels ?? [];
    const thinkingLevel = current?.thinkingLevel && levels.includes(current.thinkingLevel) ? current.thinkingLevel : levels[0] ?? 'off';
    model = { providerId: next.providerId, modelId: next.modelId, thinkingLevel };
  } else {
    if (!current) return;
    const levels = models.find(model => model.providerId === current.providerId && model.modelId === current.modelId)?.thinkingLevels ?? [];
    if (!levels.length) return;
    model = { ...current, thinkingLevel: levels[(levels.indexOf(current.thinkingLevel ?? 'off') + 1) % levels.length] };
  }
  await setThreadComposerModel(api, draftKey, snapshot, model);
}
export async function cancelSelectedThreadRun(): Promise<void> {
  const identity = useThreadStore.getState().selectedIdentity;
  const api = getRegisteredRuntimeAPIs()?.threads;
  if (!identity || !api) return;
  const host = getRuntimeEndpointGeneration();
  const snapshot = await api.snapshot(identity);
  if (host !== getRuntimeEndpointGeneration() || useThreadStore.getState().selectedIdentity !== identity) return;
  if (snapshot.activeRun) await api.cancelRun(snapshot.activeRun.id);
}
