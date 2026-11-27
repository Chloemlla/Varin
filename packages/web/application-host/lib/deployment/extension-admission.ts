import type { ExtensionArtifactAdmission } from '@varin/extension-host';
import { DeploymentPolicyDeniedError, type ExtensionDeploymentPolicy } from './policy.js';

export function createExtensionAdmission(policy: ExtensionDeploymentPolicy): ExtensionArtifactAdmission {
  const deny = (reason: string): never => { throw new DeploymentPolicyDeniedError('extensions', 'Deployment policy extensions ' + reason); };
  const source: ExtensionArtifactAdmission['source'] = (kind) => {
    if (kind === 'builtin') return;
    if (kind === 'source_view' && policy.agentStaging === false) deny('disables Agent-staged packages');
    if (policy.sources && !policy.sources.includes(kind)) deny('disallows the ' + kind + ' source');
  };
  return {
    source,
    artifact({ source: selected, manifest, integrity }) {
      source(selected.kind);
      if (selected.kind === 'builtin') return;
      if (policy.artifactIntegrities && !policy.artifactIntegrities.includes(integrity)) deny('does not admit this artifact integrity');
      const host = manifest.entrypoints?.host;
      if (policy.brokeredTransport === 'sandbox' && host?.mode === 'native') deny('requires third-party Host code to use the brokered realm');
      if (policy.realms && host && !policy.realms.includes(host.mode)) deny('disallows the ' + host.mode + ' realm');
      if (policy.realms && manifest.entrypoints?.surfaces?.length && !policy.realms.includes('surface')) deny('disallows the surface realm');
    },
  };
}
