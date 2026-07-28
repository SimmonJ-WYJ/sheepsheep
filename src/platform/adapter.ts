/**
 * 平台抽象层。
 *
 * 游戏逻辑和变现逻辑只依赖这个接口，不直接碰 `tt.*`。
 * 好处：
 *   - 在 Node 里跑单测（MockPlatform）
 *   - 在浏览器里调 UI（WebPlatform）
 *   - 以后要上微信小游戏 / 快手小游戏，只加一个 adapter 文件
 */

export type RewardedResult =
  /** 完整看完，应当发奖 */
  | { kind: 'ended' }
  /** 玩家中途关掉 */
  | { kind: 'abandoned' }
  /** 加载失败 / 无填充 / 播放报错 */
  | { kind: 'error'; code?: number; message?: string };

export interface RewardedVideoAd {
  /** 展示。内部负责必要时重新 load。 */
  show(): Promise<RewardedResult>;
  destroy(): void;
}

export interface InterstitialAd {
  show(): Promise<{ ok: boolean; message?: string }>;
  destroy(): void;
}

export interface BannerAd {
  show(): void;
  hide(): void;
  destroy(): void;
}

export interface Storage {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
}

export type LaunchScene = 'default' | 'sidebar' | 'share' | 'unknown';

export interface PlatformAdapter {
  readonly name: string;
  now(): number;
  storage: Storage;

  createRewardedVideo(adUnitId: string): RewardedVideoAd;
  createInterstitial(adUnitId: string): InterstitialAd;
  createBanner(adUnitId: string): BannerAd | null;

  /** 启动场景。抖音的侧边栏复访是一个不花广告成本的高价值召回位。 */
  launchScene(): LaunchScene;
  /** 当前端是否支持跳转侧边栏。 */
  supportsSidebar(): Promise<boolean>;
  navigateToSidebar(): Promise<boolean>;

  /** 分享到聊天/群。 */
  share(payload: { title: string; imageUrl?: string; query?: string }): Promise<boolean>;
  /** 录屏 —— 抖音特有，「通关剪辑一键发布」是最省钱的自然量入口。 */
  recorder(): Recorder | null;

  toast(msg: string): void;
}

export interface Recorder {
  start(maxSec: number): void;
  stop(): Promise<string | null>;
  /** 把录屏拉起发布到抖音。 */
  publish(videoPath: string, hashtags: string[]): Promise<boolean>;
}
