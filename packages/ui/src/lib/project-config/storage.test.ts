import { describe, expect, test, vi } from 'vitest';
import { createVarinProjectConfigStore } from './storage';
import type { VarinProjectConfig } from './types';

const fetchPreferences = vi.hoisted(() => vi.fn());
vi.mock('@varin/application-client', async original => ({
  ...await original<typeof import('@varin/application-client')>(), runtimeFetch: fetchPreferences,
}));

describe('project preferences', () => {
  test('patches the registered project on its Host even without a browsable home', async () => {
    const store = createVarinProjectConfigStore(() => null);
    const project = { id: 'qa', path: '/workspace' };
    let saved: VarinProjectConfig = {};
    fetchPreferences.mockImplementation(async (url, init) => {
      expect(url).toBe('/api/projects/qa/preferences');
      if (init?.body) {
        const { expected, patch } = JSON.parse(init.body);
        if (expected) expect(expected).toEqual(saved);
        saved = { ...saved, ...patch };
      }
      return Response.json({ preferences: saved });
    });
    await store.update(project, { projectNotes: 'persisted' });
    const append = (id: string) => store.mutate(project, current => ({
      projectPlanFiles: [...current.projectPlanFiles ?? [], { id, path: id, createdAt: 1 }],
    }));
    await Promise.all([append('a'), append('b')]);
    const reloaded = await createVarinProjectConfigStore(() => null).read({ ...project, path: '/relocated' });
    expect(reloaded.projectNotes).toBe('persisted');
    expect(reloaded.projectPlanFiles?.map(plan => plan.id)).toEqual(['a','b']);
  });
});
