import { defineConfig } from 'vite';

/**
 * 抖音小游戏包的构建配置。
 *
 * 产出单个 IIFE 到 douyin/game.js —— 小游戏运行时没有模块系统，
 * 也不能有任何外部请求，所以必须打成一个自包含的文件。
 */
export default defineConfig({
  build: {
    lib: {
      entry: 'src/render/douyin-entry.ts',
      formats: ['iife'],
      name: 'SheepSort',
      fileName: () => 'game.js',
    },
    outDir: 'douyin',
    emptyOutDir: false,
    target: 'es2017',
    // Vite 8 用 oxc 做压缩；不要写 'esbuild'，那需要额外安装 esbuild
    minify: true,
    reportCompressedSize: true,
  },
});
