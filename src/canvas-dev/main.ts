/**
 * 浏览器里跑 Canvas 版 —— **和抖音包完全同一套渲染代码**。
 * 改渲染不用打包上真机，在这里看就行；也让自动化验证成为可能。
 */
import { createBrowserHost } from '../render/host.ts';
import { App } from '../render/app.ts';
import { MockPlatform } from '../platform/mock.ts';
import { DEFAULT_AD_POLICY } from '../monetize/policy.ts';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const host = createBrowserHost(canvas);

const platform = new MockPlatform();
platform.now = () => Date.now();

// 开发时把静默期关掉，否则看不到广告和充值流程
const policy = { ...DEFAULT_AD_POLICY, coldStartQuietMs: 0, newUserQuietLevels: 0 };

const startLevel = Number(new URLSearchParams(location.hash.slice(1)).get('level')) || 1;

const app = new App({ host, platform, policy, startLevel });
// 暴露给自动化测试用
(globalThis as { __app?: unknown }).__app = app;
(globalThis as { __platform?: unknown }).__platform = platform;
