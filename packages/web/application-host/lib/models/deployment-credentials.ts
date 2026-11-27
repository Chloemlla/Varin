import type { ModelCredentialPolicy, ModelCredentialSource } from '../deployment/policy.js';
import { ModelConfigurationError } from './configuration.js';

export function credentialAllowed(policy: ModelCredentialPolicy, source: ModelCredentialSource, issuer?: string): boolean {
  return policy.sources.includes(source) && (source !== 'oauth' || (issuer !== undefined && policy.oauthIssuers.includes(issuer)));
}

export function admitModelCredential(policy: ModelCredentialPolicy | undefined, source: ModelCredentialSource, issuer?: string): void {
  if (policy && !credentialAllowed(policy, source, issuer)) {
    throw new ModelConfigurationError('deployment-policy-denied', 'Deployment policy modelCredentials disallows ' + source +
      (issuer ? ' (' + issuer + ')' : ''), 403);
  }
}
