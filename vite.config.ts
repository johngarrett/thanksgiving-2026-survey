import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  root: mode === 'admin' ? 'admin' : 'public-site',
  base: mode === 'admin' ? '/admin/' : (process.env.PUBLIC_BASE_PATH || './'),
  envDir: process.cwd(),
  build: { outDir: `../dist/${mode === 'admin' ? 'admin' : 'public'}`, emptyOutDir: true },
  server: {
    port: Number(mode === 'admin' ? (process.env.ADMIN_PORT || 5174) : (process.env.PUBLIC_PORT || 5173)),
    strictPort: true,
    proxy: { '/api': {
      target: process.env.DEV_API_TARGET || `http://127.0.0.1:${process.env.PORT || 3000}`,
      headers: { Origin: mode === 'admin'
        ? (process.env.ADMIN_ORIGIN || `http://127.0.0.1:${process.env.ADMIN_PORT || 5174}`)
        : (process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${process.env.PUBLIC_PORT || 5173}`) },
    } },
  },
}));
