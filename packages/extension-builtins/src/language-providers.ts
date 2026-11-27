/** Descriptors shared by the desktop extensions and the Resource Node. */
export function bundledTypescriptProvider(asset: (relative: string) => string) {
  return {
    providerId: 'varin.typescript-language',
    command: process.execPath,
    args: [asset('runtime/typescript-language-server.mjs'), '--stdio'],
    languageIds: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'],
    initializationOptions: {
      tsserver: { fallbackPath: asset('runtime/typescript/lib/tsserver.js') },
    },
  };
}

export function bundledLanguageProviders(asset: (relative: string) => string) {
  const provider = (name: string, languageIds: string[], entry: string, arg = '--stdio') => ({
    providerId: 'varin.' + name + '-language',
    command: process.execPath,
    languageIds,
    args: [asset('runtime/' + entry), arg],
  });
  return [
    provider('python', ['python'], 'pyright-langserver.cjs'),
    provider('html', ['html'], 'html-language-server.cjs'),
    provider('css', ['css', 'scss', 'less'], 'css-language-server.cjs'),
    provider('json', ['json', 'jsonc'], 'json-language-server.cjs'),
    { ...provider('yaml', ['yaml'], 'yaml-language-server.cjs'), initializationOptions: { l10nPath: asset('l10n') } },
    provider('bash', ['shellscript'], 'bash-language-server.cjs', 'start'),
  ];
}
