import { defineConfig } from 'vite';

/** Canvas 版的浏览器开发/验证入口 —— 和抖音包跑的是同一套渲染代码。 */
export default defineConfig({
  root: 'src/canvas-dev',
  server: { port: 5174 },
  build: { outDir: '../../dist-canvas', emptyOutDir: true },
});
