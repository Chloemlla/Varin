import { defineLanguageProvider } from "@varin/extension-sdk";
import { bundledTypescriptProvider } from '../language-providers.js';

export default defineLanguageProvider(context => bundledTypescriptProvider(file => context.assets.path(file)));
