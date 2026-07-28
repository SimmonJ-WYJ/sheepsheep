import type {
  BannerAd,
  InterstitialAd,
  LaunchScene,
  PlatformAdapter,
  Recorder,
  RewardedResult,
  RewardedVideoAd,
  Storage,
} from './adapter.ts';

/**
 * 测试 / 本地调试用的假平台。
 *
 * 关键在于它能**模拟广告失败**（无填充、超时、用户中途退出）。
 * 变现代码里最容易出事的就是这些分支，而真机上很难稳定复现，
 * 所以必须能在单测里把它们打出来。
 */

export interface MockBehaviour {
  /** 激励视频看完的概率 */
  endedRate: number;
  /** 播放报错（含无填充）的概率 */
  errorRate: number;
  /** 时钟由外部推进，便于测试冷却和跨天 */
  clock: { t: number };
}

export class MockPlatform implements PlatformAdapter {
  readonly name = 'mock';
  behaviour: MockBehaviour;
  /** 记录每一次 show，断言用 */
  readonly log: Array<{ type: 'rewarded' | 'interstitial'; at: number; result: string }> = [];

  private store = new Map<string, unknown>();
  storage: Storage;

  constructor(behaviour?: Partial<MockBehaviour>) {
    this.behaviour = {
      endedRate: 1,
      errorRate: 0,
      clock: { t: 0 },
      ...behaviour,
    };
    const store = this.store;
    this.storage = {
      get<T>(key: string): T | null {
        return (store.get(key) as T) ?? null;
      },
      set<T>(key: string, value: T): void {
        store.set(key, value);
      },
    };
  }

  advance(ms: number): void {
    this.behaviour.clock.t += ms;
  }

  now(): number {
    return this.behaviour.clock.t;
  }

  createRewardedVideo(): RewardedVideoAd {
    const self = this;
    return {
      show(): Promise<RewardedResult> {
        let r: RewardedResult;
        if (Math.random() < self.behaviour.errorRate) {
          r = { kind: 'error', code: 1004, message: 'no fill' };
        } else if (Math.random() < self.behaviour.endedRate) {
          r = { kind: 'ended' };
        } else {
          r = { kind: 'abandoned' };
        }
        self.log.push({ type: 'rewarded', at: self.now(), result: r.kind });
        return Promise.resolve(r);
      },
      destroy(): void {},
    };
  }

  createInterstitial(): InterstitialAd {
    const self = this;
    return {
      show(): Promise<{ ok: boolean }> {
        const ok = Math.random() >= self.behaviour.errorRate;
        self.log.push({ type: 'interstitial', at: self.now(), result: ok ? 'ok' : 'error' });
        return Promise.resolve({ ok });
      },
      destroy(): void {},
    };
  }

  createBanner(): BannerAd | null {
    return { show(): void {}, hide(): void {}, destroy(): void {} };
  }

  launchScene(): LaunchScene {
    return 'default';
  }
  supportsSidebar(): Promise<boolean> {
    return Promise.resolve(false);
  }
  navigateToSidebar(): Promise<boolean> {
    return Promise.resolve(false);
  }
  share(): Promise<boolean> {
    return Promise.resolve(true);
  }
  recorder(): Recorder | null {
    return null;
  }
  toast(): void {}
}
