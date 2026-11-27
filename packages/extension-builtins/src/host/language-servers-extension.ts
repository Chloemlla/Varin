import { createWorkspaceLanguageClient, defineHostExtension } from "@varin/extension-sdk";
import { bundledLanguageProviders } from '../language-providers.js';

export default defineHostExtension(async (context) => {
  const client = createWorkspaceLanguageClient(context.capabilities);
  const descriptors = bundledLanguageProviders(file => context.assets.path(file));
  const registered: string[] = [];
  context.effect(async () => {
    for (const providerId of registered.reverse()) await client.unregisterProvider(providerId);
  });
  for (const descriptor of descriptors) {
    await client.registerProvider({ ...descriptor, source: 'extension' });
    registered.push(descriptor.providerId);
  }
});
