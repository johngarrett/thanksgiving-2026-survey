import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  root: mode === 'admin' ? 'admin' : 'public-site',
  base: mode === 'admin' ? '/admin/' : (process.env.PUBLIC_BASE_PATH || './'),
  envDir: process.cwd(),
  build: { outDir: `../dist/${mode === 'admin' ? 'admin' : 'public'}`, emptyOutDir: true },
  server: {
    port: mode === 'admin' ? 5174 : 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
}));
