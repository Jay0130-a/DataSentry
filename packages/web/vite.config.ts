import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * WebUI 开发服务器。
 *
 * 所有接口都走 `/api` 前缀并代理到后端——这样前端代码里不出现主机名，
 * 生产部署时把 `/api` 指到反向代理即可，不需要改代码。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 容器里要监听 0.0.0.0，本机开发保持默认（只绑 localhost）
    ...(process.env['VITE_HOST'] ? { host: process.env['VITE_HOST'] } : {}),
    proxy: {
      '/api': {
        target: process.env['DATASENTRY_BASE_URL'] ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
