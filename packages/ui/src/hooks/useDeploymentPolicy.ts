import { useEffect, useState, useSyncExternalStore } from 'react';
import { getRuntimeEndpointGeneration, runtimeFetch, subscribeRuntimeEndpointChanged } from '@varin/application-client';

interface DeploymentControls {
  ingress?: { mode: 'gateway' };
  connections?: { staticHosts: boolean; ssh: boolean };
  localInference?: { embedding?: boolean; componentDownloads?: boolean };
}

let request: { generation: number; result: Promise<DeploymentControls | null> } | undefined;

function readPolicy(generation: number) {
  if (request?.generation === generation) return request.result;
  const result = runtimeFetch('/api/system/deployment-policy')
    .then(async response => {
      if (response.status === 404) return null; // Earlier Hosts have no policy endpoint.
      if (!response.ok) throw new Error('Deployment policy unavailable');
      return await response.json() as DeploymentControls | null;
    })
    .finally(() => {
      if (request?.result === result) request = undefined;
    });
  request = { generation, result };
  return result;
}

export function useDeploymentPolicy() {
  const generation = useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [loaded, setLoaded] = useState<{ generation: number; policy: DeploymentControls | null }>();
  useEffect(() => {
    let active = true;
    void readPolicy(generation).then(policy => { if (active) setLoaded({ generation, policy }); }, () => {});
    return () => { active = false; };
  }, [generation]);
  return loaded?.generation === generation ? loaded.policy : undefined;
}
