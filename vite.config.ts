import { defineConfig } from 'vite';

// Demo 站点的根目录就是 src/web，核心逻辑通过相对路径引入。
export default defineConfig({
  root: 'src/web',
  server: { port: 5173, open: true },
  build: { outDir: '../../dist-web', emptyOutDir: true },
});
