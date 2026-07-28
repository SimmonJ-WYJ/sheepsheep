import type {
  BannerAd,
  InterstitialAd,
  LaunchScene,
  PaymentAvailability,
  PlatformAdapter,
  Recorder,
  RewardedResult,
  RewardedVideoAd,
  Storage,
} from './adapter.ts';

/**
 * 抖音小游戏（字节小游戏）适配层，基于全局 `tt` 对象。
 *
 * 注意：`tt` 的 API 会随基础库版本变化，接入前请对照当天的官方文档
 * （https://developer.open-douyin.com/docs/resource/zh-CN/mini-game/develop/api/）
 * 核对一遍下面用到的几个方法。这里做了 feature detection，
 * 缺失的能力一律降级而不是抛错。
 */

// 只声明我们实际用到的部分，避免引入整包类型定义。
interface TTRewardedVideoAd {
  load(): Promise<void>;
  show(): Promise<void>;
  onClose(cb: (res: { isEnded: boolean }) => void): void;
  offClose(cb: (res: { isEnded: boolean }) => void): void;
  onError(cb: (err: { errCode?: number; errMsg?: string }) => void): void;
  offError(cb: (err: { errCode?: number; errMsg?: string }) => void): void;
  destroy?(): void;
}

interface TTInterstitialAd {
  load?(): Promise<void>;
  show(): Promise<void>;
  onClose(cb: () => void): void;
  offClose(cb: () => void): void;
  onError(cb: (err: { errCode?: number; errMsg?: string }) => void): void;
  offError(cb: (err: { errCode?: number; errMsg?: string }) => void): void;
  destroy?(): void;
}

interface TTBannerAd {
  show(): Promise<void>;
  hide(): void;
  destroy(): void;
}

interface TTRecorder {
  start(opts: { duration: number }): void;
  stop(): void;
  onStop(cb: (res: { videoPath: string }) => void): void;
}

interface TTGlobal {
  createRewardedVideoAd(opts: { adUnitId: string }): TTRewardedVideoAd;
  createInterstitialAd(opts: { adUnitId: string }): TTInterstitialAd;
  createBannerAd?(opts: {
    adUnitId: string;
    style: { left: number; top: number; width: number };
  }): TTBannerAd;
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  getLaunchOptionsSync(): { scene?: string | number };
  checkScene?(opts: {
    scene: string;
    success?: (res: { isExist: boolean }) => void;
    fail?: () => void;
  }): void;
  navigateToScene?(opts: {
    scene: string;
    success?: () => void;
    fail?: () => void;
  }): void;
  shareAppMessage(opts: Record<string, unknown>): void;
  getGameRecorderManager?(): TTRecorder;
  createGameRecorderManager?(): TTRecorder;
  showToast(opts: { title: string; icon?: string; duration?: number }): void;
  getSystemInfoSync(): { windowWidth: number; windowHeight: number; platform?: string };
  /** 虚拟支付。iOS 上历来不存在，所以声明成可选。 */
  requestGamePayment?(opts: Record<string, unknown>): void;
}

declare const tt: TTGlobal | undefined;

function ttOrThrow(): TTGlobal {
  if (typeof tt === 'undefined') throw new Error('不在抖音小游戏环境中');
  return tt;
}

export function isDouyin(): boolean {
  return typeof tt !== 'undefined' && typeof tt.createRewardedVideoAd === 'function';
}

/** 激励视频等待上限。超过就当失败处理，交给上层的 grantOnFailure 兜底。 */
const REWARDED_TIMEOUT_MS = 12_000;

/**
 * iOS 上是否开放了虚拟支付。
 *
 * 默认 false（历来如此），但**故意做成一个可写的开关**：
 * 政策放开时用远端配置把它打开就行，不需要重新发包送审。
 * 千万不要把「iOS 不能付」写死在判断里。
 */
let iosPaymentEnabled = false;

export function setIosPaymentEnabled(on: boolean): void {
  iosPaymentEnabled = on;
}

class DouyinRewardedVideo implements RewardedVideoAd {
  private ad: TTRewardedVideoAd;
  private busy = false;

  constructor(adUnitId: string) {
    this.ad = ttOrThrow().createRewardedVideoAd({ adUnitId });
    // 提前预加载，show 的时候才不会白等。
    this.ad.load().catch(() => undefined);
  }

  show(): Promise<RewardedResult> {
    // 防连点：上一支还在播就直接拒绝，不要叠两层广告。
    if (this.busy) return Promise.resolve({ kind: 'error', message: 'busy' });
    this.busy = true;

    return new Promise<RewardedResult>((resolve) => {
      let settled = false;
      const finish = (r: RewardedResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ad.offClose(onClose);
        this.ad.offError(onError);
        this.busy = false;
        // 播完立刻预热下一支
        this.ad.load().catch(() => undefined);
        resolve(r);
      };

      const onClose = (res: { isEnded: boolean }): void => {
        finish(res && res.isEnded ? { kind: 'ended' } : { kind: 'abandoned' });
      };
      const onError = (err: { errCode?: number; errMsg?: string }): void => {
        finish({ kind: 'error', code: err?.errCode, message: err?.errMsg });
      };

      const timer = setTimeout(
        () => finish({ kind: 'error', message: 'timeout' }),
        REWARDED_TIMEOUT_MS,
      );

      this.ad.onClose(onClose);
      this.ad.onError(onError);

      this.ad.show().catch(() => {
        // show 失败通常是还没 load 好，补一次 load 再 show。
        this.ad
          .load()
          .then(() => this.ad.show())
          .catch((e: unknown) => finish({ kind: 'error', message: String(e) }));
      });
    });
  }

  destroy(): void {
    this.ad.destroy?.();
  }
}

class DouyinInterstitial implements InterstitialAd {
  private ad: TTInterstitialAd;

  constructor(adUnitId: string) {
    this.ad = ttOrThrow().createInterstitialAd({ adUnitId });
  }

  show(): Promise<{ ok: boolean; message?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: { ok: boolean; message?: string }): void => {
        if (settled) return;
        settled = true;
        this.ad.offClose(onClose);
        this.ad.offError(onError);
        resolve(r);
      };
      const onClose = (): void => finish({ ok: true });
      const onError = (err: { errMsg?: string }): void =>
        finish({ ok: false, message: err?.errMsg });

      this.ad.onClose(onClose);
      this.ad.onError(onError);
      this.ad.show().catch((e: unknown) => finish({ ok: false, message: String(e) }));
    });
  }

  destroy(): void {
    this.ad.destroy?.();
  }
}

class DouyinBanner implements BannerAd {
  private ad: TTBannerAd | null;

  constructor(adUnitId: string) {
    const t = ttOrThrow();
    if (!t.createBannerAd) {
      this.ad = null;
      return;
    }
    const info = t.getSystemInfoSync();
    const width = Math.min(info.windowWidth, 375);
    this.ad = t.createBannerAd({
      adUnitId,
      style: { left: (info.windowWidth - width) / 2, top: info.windowHeight - 100, width },
    });
  }

  show(): void {
    this.ad?.show().catch(() => undefined);
  }
  hide(): void {
    this.ad?.hide();
  }
  destroy(): void {
    this.ad?.destroy();
  }
}

class DouyinRecorder implements Recorder {
  private rec: TTRecorder;
  private pending: ((p: string | null) => void) | null = null;

  constructor(rec: TTRecorder) {
    this.rec = rec;
    this.rec.onStop((res) => {
      this.pending?.(res?.videoPath ?? null);
      this.pending = null;
    });
  }

  start(maxSec: number): void {
    this.rec.start({ duration: Math.max(3, Math.min(300, maxSec)) });
  }

  stop(): Promise<string | null> {
    return new Promise((resolve) => {
      this.pending = resolve;
      this.rec.stop();
      // 录屏 stop 偶发不回调，兜个底避免 Promise 悬着。
      setTimeout(() => {
        if (this.pending) {
          this.pending(null);
          this.pending = null;
        }
      }, 5000);
    });
  }

  publish(videoPath: string, hashtags: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        ttOrThrow().shareAppMessage({
          channel: 'video',
          title: '我在羊群大整理通关了',
          extra: { videoPath, hashtag_list: hashtags, videoTopType: 1 },
          success: () => resolve(true),
          fail: () => resolve(false),
        });
      } catch {
        resolve(false);
      }
    });
  }
}

const douyinStorage: Storage = {
  get<T>(key: string): T | null {
    try {
      const raw = ttOrThrow().getStorageSync(key);
      return (raw as T) ?? null;
    } catch {
      return null;
    }
  },
  set<T>(key: string, value: T): void {
    try {
      ttOrThrow().setStorageSync(key, value);
    } catch {
      /* 存储写失败不该影响游戏进行 */
    }
  },
};

export class DouyinPlatform implements PlatformAdapter {
  readonly name = 'douyin';
  storage = douyinStorage;

  now(): number {
    return Date.now();
  }

  createRewardedVideo(adUnitId: string): RewardedVideoAd {
    return new DouyinRewardedVideo(adUnitId);
  }

  createInterstitial(adUnitId: string): InterstitialAd {
    return new DouyinInterstitial(adUnitId);
  }

  createBanner(adUnitId: string): BannerAd | null {
    return new DouyinBanner(adUnitId);
  }

  /**
   * 运行时探测能不能充值。
   *
   * 注意这和「能不能玩」无关 —— Android 和 iOS 都能正常玩、正常看广告。
   * 探测顺序：有没有 tt → 有没有支付 API → 是不是 iOS 且未开放。
   */
  paymentAvailability(): PaymentAvailability {
    const t = typeof tt !== 'undefined' ? tt : undefined;
    if (!t) return 'unavailable';
    if (typeof t.requestGamePayment !== 'function') return 'unsupported-platform';
    try {
      const plat = (t.getSystemInfoSync()?.platform ?? '').toLowerCase();
      if (plat.includes('ios') && !iosPaymentEnabled) return 'unsupported-platform';
    } catch {
      return 'unavailable';
    }
    return 'available';
  }

  launchScene(): LaunchScene {
    try {
      const scene = String(ttOrThrow().getLaunchOptionsSync()?.scene ?? '');
      if (scene.includes('sidebar')) return 'sidebar';
      if (scene.includes('share')) return 'share';
      return 'default';
    } catch {
      return 'unknown';
    }
  }

  supportsSidebar(): Promise<boolean> {
    return new Promise((resolve) => {
      const t = typeof tt !== 'undefined' ? tt : undefined;
      if (!t?.checkScene) return resolve(false);
      t.checkScene({
        scene: 'sidebar',
        success: (res) => resolve(!!res?.isExist),
        fail: () => resolve(false),
      });
    });
  }

  navigateToSidebar(): Promise<boolean> {
    return new Promise((resolve) => {
      const t = typeof tt !== 'undefined' ? tt : undefined;
      if (!t?.navigateToScene) return resolve(false);
      t.navigateToScene({
        scene: 'sidebar',
        success: () => resolve(true),
        fail: () => resolve(false),
      });
    });
  }

  share(payload: { title: string; imageUrl?: string; query?: string }): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        ttOrThrow().shareAppMessage({
          title: payload.title,
          imageUrl: payload.imageUrl,
          query: payload.query,
          success: () => resolve(true),
          fail: () => resolve(false),
        });
      } catch {
        resolve(false);
      }
    });
  }

  recorder(): Recorder | null {
    try {
      const t = ttOrThrow();
      const rec = t.getGameRecorderManager?.() ?? t.createGameRecorderManager?.();
      return rec ? new DouyinRecorder(rec) : null;
    } catch {
      return null;
    }
  }

  toast(msg: string): void {
    try {
      ttOrThrow().showToast({ title: msg, icon: 'none', duration: 1500 });
    } catch {
      /* noop */
    }
  }
}
