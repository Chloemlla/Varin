import React from 'react';
import type { SurfaceActivationContext } from '@varin/extension-surface';
import type { VarinSettingsSection } from '@/components/sections/varin/types';
import {
  BUILTIN_SETTINGS_PAGE_SPECS,
  BUILTIN_SETTINGS_EXTENSION_ID,
  isBuiltinSettingsPageAvailable,
  type BuiltinSettingsPageSpec,
} from '@/lib/settings/builtin-page-metadata';
import type { SettingsPageImplementation } from '@/lib/settings/page-types';

// Register metadata synchronously. Page modules load only when their content mounts.
const GeneralPage = React.lazy(() => import('@/components/sections/preferences/GeneralPage').then(m => ({ default: m.GeneralPage })));
const AppearancePage = React.lazy(() => import('@/components/sections/preferences/AppearancePage').then(m => ({ default: m.AppearancePage })));
const ChatPage = React.lazy(() => import('@/components/sections/preferences/ChatPage').then(m => ({ default: m.ChatPage })));
const EditorPage = React.lazy(() => import('@/components/sections/preferences/EditorTerminalPages').then(m => ({ default: m.EditorPage })));
const TerminalPage = React.lazy(() => import('@/components/sections/preferences/EditorTerminalPages').then(m => ({ default: m.TerminalPage })));
const NotificationsPage = React.lazy(() => import('@/components/sections/preferences/PreferenceWrappers').then(m => ({ default: m.NotificationsPage })));
const ShortcutsPage = React.lazy(() => import('@/components/sections/preferences/PreferenceWrappers').then(m => ({ default: m.ShortcutsPage })));
const VoicePage = React.lazy(() => import('@/components/sections/preferences/PreferenceWrappers').then(m => ({ default: m.VoicePage })));
const DevicesPage = React.lazy(() => import('@/components/sections/devices/DevicesPage').then(m => ({ default: m.DevicesPage })));
const RemoteAccessPage = React.lazy(() => import('@/components/sections/devices/RemoteAccessPage').then(m => ({ default: m.RemoteAccessPage })));
const ProxyPage = React.lazy(() => import('@/components/sections/devices/ProxyPage').then(m => ({ default: m.ProxyPage })));
const WorkspacesPage = React.lazy(() => import('@/components/sections/devices/WorkspacesPage').then(m => ({ default: m.WorkspacesPage })));
const CodeIntelPage = React.lazy(() => import('@/components/sections/language-support/CodeIntelPage').then(m => ({ default: m.CodeIntelPage })));
const BrowserSettingsPage = React.lazy(() => import('@/components/sections/browsers/BrowserSettingsPage').then(m => ({ default: m.BrowserSettingsPage })));
const ExternalAgentsPage = React.lazy(() => import('@/components/sections/external-agents/ExternalAgentsPage').then(m => ({ default: m.ExternalAgentsPage })));
const HistorySettingsPage = React.lazy(() => import('@/components/sections/connections/SettingsUtilityPages').then(m => ({ default: m.HistorySettingsPage })));
const StorageSettingsPage = React.lazy(() => import('@/components/sections/storage/StorageSettingsPage').then(m => ({ default: m.StorageSettingsPage })));
const UsageSettingsPage = React.lazy(() => import('@/components/sections/usage/UsageSettingsPage').then(m => ({ default: m.UsageSettingsPage })));
const AgentMemoryPage = React.lazy(() => import('@/components/sections/assistant/AgentMemoryPage').then(m => ({ default: m.AgentMemoryPage })));
const AgentPromptPage = React.lazy(() => import('@/components/sections/assistant/AgentPromptPage').then(m => ({ default: m.AgentPromptPage })));
const ExtensionsPage = React.lazy(() => import('@/components/sections/extensions/ExtensionsPage').then(m => ({ default: m.ExtensionsPage })));
const GitPage = React.lazy(() => import('@/components/sections/git-identities/GitPage').then(m => ({ default: m.GitPage })));
const VarinSettingsPage = React.lazy(() => import('@/components/sections/varin/VarinSettingsPage').then(m => ({ default: m.VarinSettingsPage })));
const CompanionSettings = React.lazy(() => import('@/components/sections/varin/CompanionSettings').then(m => ({ default: m.CompanionSettings })));
const ProjectsPage = React.lazy(() => import('@/components/sections/projects/ProjectsPage').then(m => ({ default: m.ProjectsPage })));
const ProjectsSidebar = React.lazy(() => import('@/components/sections/projects/ProjectsSidebar').then(m => ({ default: m.ProjectsSidebar })));
const ModelRolesPage = React.lazy(() => import('@/components/sections/harness/ModelRolesPage').then(m => ({ default: m.ModelRolesPage })));
const ModelConnectionsPage = React.lazy(() => import('@/components/sections/providers/ModelConnectionsPage').then(m => ({ default: m.ModelConnectionsPage })));
const McpConnectionsPage = React.lazy(() => import('@/components/sections/mcp/McpConnectionsPage').then(m => ({ default: m.McpConnectionsPage })));
const SkillsPage = React.lazy(() => import('@/components/sections/skills/SkillsPage').then(m => ({ default: m.SkillsPage })));
const BuiltinAboutSettingsPage = React.lazy(() => import('./BuiltinAboutSettingsPage').then(m => ({ default: m.BuiltinAboutSettingsPage })));

const PREFERENCE_PAGES: Partial<Record<VarinSettingsSection, () => React.ReactNode>> = {
  general: () => <GeneralPage />,
  visual: () => <AppearancePage />,
  chat: () => <ChatPage />,
  notifications: () => <NotificationsPage />,
  voice: () => <VoicePage />,
  shortcuts: () => <ShortcutsPage />,
  editor: () => <EditorPage />,
  terminal: () => <TerminalPage />,
};
const varinPage = (section: VarinSettingsSection): SettingsPageImplementation => ({
  renderContent: PREFERENCE_PAGES[section] ?? (() => <VarinSettingsPage section={section} />),
});

const implementationFor = (spec: BuiltinSettingsPageSpec): SettingsPageImplementation => {
  let implementation: SettingsPageImplementation | null = null;
  if (spec.renderer.startsWith('varin:')) {
    implementation = varinPage(spec.renderer.slice('varin:'.length) as VarinSettingsSection);
  } else {
    switch (spec.renderer) {
      case 'companion': implementation = { renderContent: () => <CompanionSettings /> }; break;
      case 'external-agents': implementation = { renderContent: () => <ExternalAgentsPage /> }; break;
      case 'history': implementation = { renderContent: () => <HistorySettingsPage /> }; break;
      case 'storage': implementation = { renderContent: () => <StorageSettingsPage /> }; break;
      case 'usage': implementation = { renderContent: () => <UsageSettingsPage /> }; break;
      case 'devices': implementation = { renderContent: () => <DevicesPage /> }; break;
      case 'remote-access': implementation = { renderContent: () => <RemoteAccessPage /> }; break;
      case 'proxy': implementation = { renderContent: () => <ProxyPage /> }; break;
      case 'workspaces': implementation = { renderContent: () => <WorkspacesPage /> }; break;
      case 'code-intel': implementation = { renderContent: () => <CodeIntelPage /> }; break;
      case 'browsers': implementation = { renderContent: () => <BrowserSettingsPage /> }; break;
      case 'agent-memory': implementation = { renderContent: () => <AgentMemoryPage /> }; break;
      case 'agent-prompt': implementation = { renderContent: () => <AgentPromptPage /> }; break;
      case 'empty': implementation = { renderContent: () => null }; break;
      case 'about': implementation = { renderContent: () => <BuiltinAboutSettingsPage /> }; break;
      case 'extensions': implementation = { renderContent: () => <ExtensionsPage /> }; break;
      case 'git': implementation = { renderContent: () => <GitPage /> }; break;
      case 'projects': implementation = { renderContent: () => <ProjectsPage />, renderSidebar: (options) => <ProjectsSidebar onItemSelect={options.onItemSelect} /> }; break;
      case 'model-roles': implementation = { renderContent: () => <ModelRolesPage /> }; break;
      case 'model-connections': implementation = { renderContent: () => <ModelConnectionsPage /> }; break;
      case 'mcp-connections': implementation = { renderContent: () => <McpConnectionsPage /> }; break;
      case 'skills': implementation = { renderContent: () => <SkillsPage /> }; break;
    }
  }
  if (!implementation) throw new Error(`Unknown built-in Settings renderer: ${spec.renderer}`);
  return spec.availability
    ? { ...implementation, isAvailable: (context) => isBuiltinSettingsPageAvailable(spec, context) }
    : implementation;
};

export const registerBuiltinSettingsContributions = (context: SurfaceActivationContext): void => {
  for (const spec of BUILTIN_SETTINGS_PAGE_SPECS) {
    context.contribute({
      id: `${BUILTIN_SETTINGS_EXTENSION_ID}.page.${spec.meta.slug}`,
      kind: 'settings-page',
      contractVersion: 1,
      supports: ['web', 'desktop', 'mobile'],
      placement: { slot: `settings.nav.${spec.meta.group}`, order: spec.meta.order },
      data: {
        slug: spec.meta.slug,
        title: spec.meta.title,
        titleKey: spec.meta.titleKey,
        group: spec.meta.group,
        kind: spec.meta.kind,
        icon: spec.meta.icon,
        order: spec.meta.order,
        ...(spec.meta.badgeKey ? { badgeKey: spec.meta.badgeKey } : {}),
        keywords: spec.meta.keywords ?? [],
      },
    }, implementationFor(spec));
  }
};
