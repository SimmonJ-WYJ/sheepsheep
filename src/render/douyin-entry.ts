/**
 * 抖音小游戏入口。
 *
 * 打包成 `douyin/game.js`（IIFE，无 import），和 `game.json` 放一起就是一个完整的包。
 *
 * 上线前必须改的两处：
 *   1. `douyin/project.config.json` 的 appid
 *   2. 下面的 AD_UNITS —— 换成开放平台申请到的真实广告位 id
 */
import { createDouyinHost } from './host.ts';
import { App } from './app.ts';
import { DouyinPlatform } from '../platform/douyin.ts';
import type { AdUnitIds } from '../monetize/policy.ts';

const AD_UNITS: AdUnitIds = {
  rewardedVideo: 'REPLACE_ME_REWARDED_VIDEO_ID',
  interstitial: 'REPLACE_ME_INTERSTITIAL_ID',
  banner: 'REPLACE_ME_BANNER_ID',
};

/**
 * 没有版号时置为 true —— 内购入口整体消失，游戏依然完整可玩
 * （钻石靠 economy.ts 的免费通路获取）。见 docs/06。
 */
const NO_LICENSE_YET = true;

try {
  const host = createDouyinHost();
  const platform = new DouyinPlatform();
  new App({
    host,
    platform,
    adUnits: AD_UNITS,
    startLevel: 1,
    forcePaymentUnavailable: NO_LICENSE_YET,
  });
} catch (e) {
  // 小游戏里没有控制台可看，出错至少弹个 toast 出来
  const tt = (globalThis as { tt?: { showToast?(o: { title: string; icon?: string }): void } }).tt;
  tt?.showToast?.({ title: '启动失败：' + String(e), icon: 'none' });
}
