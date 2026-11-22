import React from 'react';

import { ProjectNotesTodoPanel } from '@/components/session/ProjectNotesTodoPanel';
import { useGitStore } from '@/stores/useGitStore';
import { useSelectedThreadWorkspace } from '@/hooks/useSelectedThreadWorkspace';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { formatDirectoryName } from '@/lib/utils';

export const ProjectContextPanel: React.FC = () => {
  const { project: activeProject } = useSelectedThreadWorkspace();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const gitDirectories = useGitStore((state) => state.directories);

  const projectRef = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }
    return {
      id: activeProject.id,
      path: activeProject.path,
      source: activeProject.source,
      resourceOwner: activeProject.source?.resourceOwner,
      versionedWorkspace: activeProject.versionedWorkspace,
    };
  }, [activeProject]);

  const projectLabel = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }
    return activeProject.label?.trim()
      || formatDirectoryName(activeProject.path, homeDirectory)
      || activeProject.path;
  }, [activeProject, homeDirectory]);

  const canCreateWorktree = React.useMemo(() => {
    if (!activeProject) {
      return false;
    }
    return gitDirectories.get(activeProject.path)?.isGitRepo === true;
  }, [activeProject, gitDirectories]);

  return (
    <div className="h-full min-h-0 overflow-auto bg-background">
      <ProjectNotesTodoPanel
        projectRef={projectRef}
        projectLabel={projectLabel}
        canCreateWorktree={canCreateWorktree}
      />
    </div>
  );
};
