import type { ConversationOrganizationContainer as Container, ConversationOrganizationSnapshot as Snapshot } from '@varin/application-client';
import { organizationContainerPath } from '@/components/conversation/organizationProjection';
import { initialRooms, type Room } from './sample';

export function container(id: string, kind: Container['kind'], name: string, parentId: string | null, order: number): Container {
  return { id, kind, name, parentId, projectId: kind === 'project' ? id : null, icon: null, color: null, revision: 1, childrenRevision: 1, order };
}
export const initialContainers = [
  container('demo', 'project', '演示项目', null, 0),
  container('rehearsal', 'group', '现场彩排', 'demo', 0),
  container('followup', 'group', '合作跟进', null, 1),
];

// Preserve drafts and explicit placements when opening an earlier revision of the preview.
export function withSampleLocations(saved: Room[]): Room[] {
  const ids = new Set(saved.map(r => r.id));
  return [...saved.map(r => ({ ...initialRooms.find(sample => sample.id === r.id), ...r })), ...initialRooms.filter(r => !ids.has(r.id))];
}

export function workSnapshot(rooms: Room[], containers: Container[]): Snapshot {
  const work = rooms.filter(r => r.mode === 'work');
  const byId = new Map(work.map(r => [r.id, r]));
  const snapshot: Snapshot = { containers, conversations: [], initialized: true, revision: 1, rootRevision: 1, cursor: 0, nextCursor: null };
  const ref = (id: string) => ({ kind: 'native' as const, id });
  function placement(r: Room): string | null {
    if (r.containerId !== undefined) return r.containerId;
    const parent = r.parent && byId.get(r.parent);
    return parent ? placement(parent) : null;
  }
  snapshot.conversations = work.map((r, index) => {
    const conversation = ref(r.id), parent = r.parent ? ref(r.parent) : null;
    const containerId = placement(r);
    const order = r.pinned ? index : work.length + index;
    return { conversation, title: r.title, pinned: !!r.pinned, archived: false, revision: 1,
      path: organizationContainerPath(snapshot, containerId).map(c => c.id),
      position: { conversation, order, containerId, revision: 1, explicit: r.containerId !== undefined, inheritedFrom: r.containerId === undefined ? parent : null },
      origin: { botId: null, directBotId: null, conversation: parent } };
  });
  return snapshot;
}
