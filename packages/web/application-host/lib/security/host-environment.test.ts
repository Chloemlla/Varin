import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { createHostEnvironment } from './host-environment.js';

test('child launches inherit user configuration while a replacement Host recovers its own secrets', () => {
  const env = { ...process.env, VARIN_UI_PASSWORD: 'synthetic-password', VARIN_FRP_TOKEN_DEMO: 'synthetic-token',
    VARIN_LOCAL_SUPERVISOR_LAUNCH_ID: 'launch-identity',
    HTTPS_PROXY: 'http://proxy.example', USER_API_KEY: 'personal-setting' };
  const owner = createHostEnvironment(env);
  owner.capture();
  owner.capture();
  owner.importLoginShell({ NGROK_AUTHTOKEN: 'login-token', VARIN_UI_PASSWORD: 'older-login-value' });
  const names = ['VARIN_UI_PASSWORD', 'VARIN_FRP_TOKEN_DEMO', 'VARIN_LOCAL_SUPERVISOR_LAUNCH_ID', 'NGROK_AUTHTOKEN', 'HTTPS_PROXY', 'USER_API_KEY'];
  const values = execFileSync(process.execPath, ['-e',
    'console.log(JSON.stringify(process.argv.slice(1).map(k => process.env[k] ?? null)))', ...names], { env, encoding: 'utf8' });
  expect(JSON.parse(values)).toEqual([null, null, null, null, 'http://proxy.example', 'personal-setting']);
  expect(owner.read('NGROK_AUTHTOKEN')).toBe('login-token');
  expect(owner.read('VARIN_LOCAL_SUPERVISOR_LAUNCH_ID')).toBe('launch-identity');
  expect(owner.read('VARIN_FRP_TOKEN_DEMO')).toBe('synthetic-token');
  expect(owner.forHostRestart().VARIN_UI_PASSWORD).toBe('synthetic-password');
});
