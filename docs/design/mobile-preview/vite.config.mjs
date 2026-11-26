import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import web from '../../../packages/web/vite.config.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(root, '../../..');
export default defineConfig({
  root,
  plugins: [react()],
  resolve: { alias: [
    { find: '@/lib/varinEvents', replacement: resolve(root, 'preview-events.ts') },
    ...web.resolve.alias,
    ...['react', 'react-dom', '@base-ui/react'].map(find => ({ find, replacement: resolve(repo, 'packages/ui/node_modules', find) })),
  ] },
  define: web.define,
  css: { postcss: resolve(repo, 'packages/web') },
  cacheDir: resolve(repo, 'node_modules/.vite/mobile-design'),
  server: { host: '127.0.0.1', port: 5192, strictPort: true, fs: { allow: [repo] } },
});
