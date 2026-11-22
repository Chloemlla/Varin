import type { ModelSessionConfiguration, RunModelSelections } from './protocol.generated.js';
import { waitWithSignal } from '../cancellation.js';

/** Cancel only the observer; a capture that arrives later still has its original owner. */
export async function waitForModelBinding<T>(pending: Promise<T>, release: (value: T) => void, signal?: AbortSignal): Promise<T> {
  let accepted = false;
  try {
    const value = await waitWithSignal(pending, signal);
    signal?.throwIfAborted();
    accepted = true;
    return value;
  } finally {
    if (!accepted) void pending.then(release, () => undefined);
  }
}

/** Mirrors native run assembly: an open request and its tool results keep the active model. */
export function launchModelSelection(selections: RunModelSelections) {
  return selections.exchange_closed && selections.desired ? selections.desired : selections.active;
}

/** Nonsecret execution identity used only to recover the same live captured owner. */
export function modelCredentialBindingIdentity(configuration: ModelSessionConfiguration): string {
  return JSON.stringify([configuration.providerId, configuration.providerFamily, configuration.model,
    configuration.configurationGeneration, configuration.endpoint, configuration.adapterBindingId]);
}
