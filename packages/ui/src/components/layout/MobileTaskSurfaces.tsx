import React from 'react';
import type { BotGroupSummary } from '@varin/application-client';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useUIStore } from '@/stores/useUIStore';

const Schedule = lazyWithChunkRecovery(() => import('@/components/session/ScheduledTasksDialog').then(m => ({ default: m.ScheduledTasksDialog })));
const Archive = lazyWithChunkRecovery(() => import('@/components/views/ArchiveView').then(m => ({ default: m.ArchiveView })));
const Worktrees = lazyWithChunkRecovery(() => import('@/components/views/WorktreesView').then(m => ({ default: m.WorktreesView })));
const MultiRun = lazyWithChunkRecovery(() => import('@/components/multirun').then(m => ({ default: m.MultiRunLauncher })));

export function MobileTaskSurfaces({ group }: { group?: BotGroupSummary }) {
  const schedule = useUIStore(s => s.isScheduledTasksDialogOpen);
  const archive = useUIStore(s => s.isArchivePageOpen);
  const worktrees = useUIStore(s => s.worktreesPageProjectId);
  const multi = useUIStore(s => s.isMultiRunLauncherOpen);
  const prompt = useUIStore(s => s.multiRunLauncherPrefillPrompt);
  if (!schedule && !archive && !worktrees && !multi) return null;
  const close = () => useUIStore.getState().setMultiRunLauncherOpen(false);
  return <div className="absolute inset-0 z-10 flex flex-col bg-background"><React.Suspense fallback={null}>
    {schedule && <Schedule activeGroup={group} />}{archive && <Archive />}{worktrees && <Worktrees />}
    {multi && <MultiRun initialPrompt={prompt} onCreated={close} onCancel={close} />}
  </React.Suspense></div>;
}
