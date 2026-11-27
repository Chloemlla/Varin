// Consume service secrets before starting workers. This also covers indirect
// children such as Git hooks, SDK subprocesses and shell commands.
const serviceVariables = new Set([
  'VARIN_LOCAL_SUPERVISOR_LAUNCH_ID',
  'VARIN_UI_PASSWORD', 'VARIN_JWT_SECRET', 'VARIN_TUNNEL_TOKEN', 'NGROK_AUTHTOKEN',
  'VARIN_APNS_P8', 'VARIN_APNS_P8_PATH', 'VARIN_EXPO_ACCESS_TOKEN', 'EXPO_ACCESS_TOKEN',
]);

export function isHostPrivateVariable(name: string): boolean {
  const key = process.platform === 'win32' ? name.toUpperCase() : name;
  return serviceVariables.has(key) || /^VARIN_FRP_TOKEN(?:_[A-Z0-9_]+)?$/u.test(key);
}

export function createHostEnvironment(env: NodeJS.ProcessEnv) {
  const privateValues = new Map<string, string>();
  return {
    capture() {
      for (const [key, value] of Object.entries(env)) {
        const name = process.platform === 'win32' ? key.toUpperCase() : key;
        if (value === undefined || !isHostPrivateVariable(name)) continue;
        privateValues.set(name, value);
        delete env[key];
      }
    },
    importLoginShell(snapshot: NodeJS.ProcessEnv) {
      for (const [key, value] of Object.entries(snapshot)) {
        if (value !== undefined && isHostPrivateVariable(key) && key !== 'VARIN_LOCAL_SUPERVISOR_LAUNCH_ID' && !privateValues.has(key))
          privateValues.set(key, value);
      }
    },
    read(name: string) { return env[name] ?? privateValues.get(name); },
    // Only a replacement Application Host receives the service environment.
    forHostRestart(): NodeJS.ProcessEnv { return { ...Object.fromEntries(privateValues), ...env }; },
  };
}

export const hostEnvironment = createHostEnvironment(process.env);
