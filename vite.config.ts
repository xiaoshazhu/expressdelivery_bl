import { defineConfig } from 'vite';

const backendPort = process.env.VITE_BACKEND_PORT || '8791';
const backend = `http://127.0.0.1:${backendPort}`;

export default defineConfig({
  // 静态资源相对 dist/index.html，兼容平台在任意路径部署边栏插件。
  base: process.env.VITE_BASE || './',
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': backend, '/pay': backend },
  },
});
