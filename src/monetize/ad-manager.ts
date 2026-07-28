import type { AdPlacement, AdPolicy, AdUnitIds } from './policy.ts';
import { DEFAULT_AD_POLICY } from './policy.ts';
import type {
  BannerAd,
  InterstitialAd,
  PlatformAdapter,
  RewardedVideoAd,
} from '../platform/adapter.ts';

/**
 * 广告闸门。所有广告都必须走 `request()`，任何地方都不要直接调平台 API。
 *
 * 它做四件事：
 *   1. 频控（全局间隔 / 单位冷却 / 单关上限 / 单日上限 / 冷启动静默 / 新手关豁免）
 *   2. 播放，并把平台层五花八门的回调收敛成一个 AdOutcome
 *   3. 失败兜底 —— 无填充照样发奖（见 policy.ts 原则 2）
 *   4. 埋点，输出可以直接对账的漏斗数据
 */

export type AdOutcome =
  /** 该发奖了。注意：`fallback` 为 true 时是兜底发的，不要计入广告收入。 */
  | { granted: true; fallback: boolean; reason: 'ended' | 'ad-failed' | 'ad-abandoned' }
  /** 不发奖。 */
  | { granted: false; reason: BlockReason | 'abandoned' | 'failed' };

export type BlockReason =
  | 'cold-start-quiet'
  | 'newbie-levels'
  | 'global-interval'
  | 'placement-cooldown'
  | 'daily-cap'
  | 'format-daily-cap'
  | 'level-cap'
  | 'disabled';

export interface AdEvent {
  placement: AdPlacement;
  at: number;
  /** request 被频控拦下 */
  blocked?: BlockReason;
  outcome?: AdOutcome;
}

interface DayState {
  day: string;
  perPlacement: Record<string, number>;
  rewardedTotal: number;
  interstitialTotal: number;
}

const STORAGE_KEY = 'ad_day_state_v1';

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export interface AdManagerOptions {
  platform: PlatformAdapter;
  adUnits: AdUnitIds;
  policy?: AdPolicy;
  /** 应用冷启动时间戳；不传就取当前时间。 */
  bootAt?: number;
  onEvent?: (e: AdEvent) => void;
}

export class AdManager {
  private platform: PlatformAdapter;
  private adUnits: AdUnitIds;
  private policy: AdPolicy;
  private bootAt: number;
  private onEvent?: (e: AdEvent) => void;

  private day: DayState;
  private lastAnyAdAt = -Infinity;
  private lastAtPlacement = new Map<AdPlacement, number>();
  private perLevel = new Map<AdPlacement, number>();
  private currentLevelId = 0;

  private rewardedAd: RewardedVideoAd | null = null;
  private interstitialAd: InterstitialAd | null = null;
  private bannerAd: BannerAd | null = null;

  constructor(opts: AdManagerOptions) {
    this.platform = opts.platform;
    this.adUnits = opts.adUnits;
    this.policy = opts.policy ?? DEFAULT_AD_POLICY;
    this.bootAt = opts.bootAt ?? this.platform.now();
    this.onEvent = opts.onEvent;
    this.day = this.loadDay();
  }

  /** 每关开始时调用，重置单关计数。 */
  startLevel(levelId: number): void {
    this.currentLevelId = levelId;
    this.perLevel.clear();
  }

  // ------------------------------------------------------------- 频控

  /** 只查不播。UI 用它决定「看广告」按钮要不要显示、要不要置灰。 */
  check(placement: AdPlacement): { allowed: true } | { allowed: false; reason: BlockReason } {
    const rule = this.policy.placements[placement];
    const now = this.platform.now();
    this.rolloverIfNeeded(now);

    if (rule.dailyCap === 0) return { allowed: false, reason: 'disabled' };

    // banner 不参与频控，它是常驻的
    if (rule.format === 'banner') return { allowed: true };

    if (now - this.bootAt < this.policy.coldStartQuietMs) {
      return { allowed: false, reason: 'cold-start-quiet' };
    }
    if (this.currentLevelId > 0 && this.currentLevelId <= this.policy.newUserQuietLevels) {
      return { allowed: false, reason: 'newbie-levels' };
    }

    const used = this.day.perPlacement[placement] ?? 0;
    if (used >= rule.dailyCap) return { allowed: false, reason: 'daily-cap' };

    if (rule.format === 'rewarded' && this.day.rewardedTotal >= this.policy.rewardedDailyCap) {
      return { allowed: false, reason: 'format-daily-cap' };
    }
    if (
      rule.format === 'interstitial' &&
      this.day.interstitialTotal >= this.policy.interstitialDailyCap
    ) {
      return { allowed: false, reason: 'format-daily-cap' };
    }

    if ((this.perLevel.get(placement) ?? 0) >= rule.perLevelCap) {
      return { allowed: false, reason: 'level-cap' };
    }

    const lastHere = this.lastAtPlacement.get(placement) ?? -Infinity;
    if (now - lastHere < rule.cooldownMs) {
      return { allowed: false, reason: 'placement-cooldown' };
    }

    // 复活位豁免全局间隔：玩家刚输，这一刻的意愿最高，卡他没有道理。
    if (placement !== 'revive' && now - this.lastAnyAdAt < this.policy.globalMinIntervalMs) {
      return { allowed: false, reason: 'global-interval' };
    }

    return { allowed: true };
  }

  // ------------------------------------------------------------- 播放

  /** 请求一次广告。返回的 AdOutcome 就是「该不该发奖」的唯一依据。 */
  async request(placement: AdPlacement): Promise<AdOutcome> {
    const gate = this.check(placement);
    if (!gate.allowed) {
      this.emit({ placement, at: this.platform.now(), blocked: gate.reason });
      return { granted: false, reason: gate.reason };
    }

    const rule = this.policy.placements[placement];
    const now = this.platform.now();

    // 先记账再播。哪怕播放过程中出异常，频控也不会失效。
    this.day.perPlacement[placement] = (this.day.perPlacement[placement] ?? 0) + 1;
    if (rule.format === 'rewarded') this.day.rewardedTotal++;
    if (rule.format === 'interstitial') this.day.interstitialTotal++;
    this.perLevel.set(placement, (this.perLevel.get(placement) ?? 0) + 1);
    this.lastAtPlacement.set(placement, now);
    this.lastAnyAdAt = now;
    this.saveDay();

    let outcome: AdOutcome;

    if (rule.format === 'interstitial') {
      const r = await this.getInterstitial().show();
      outcome = r.ok
        ? { granted: true, fallback: false, reason: 'ended' }
        : { granted: false, reason: 'failed' };
    } else {
      const r = await this.getRewarded().show();
      if (r.kind === 'ended') {
        outcome = { granted: true, fallback: false, reason: 'ended' };
      } else if (r.kind === 'error') {
        // 无填充 / 超时 / 报错 —— 不是玩家的错，按策略兜底发奖。
        outcome = rule.grantOnFailure
          ? { granted: true, fallback: true, reason: 'ad-failed' }
          : { granted: false, reason: 'failed' };
      } else {
        outcome = rule.grantOnAbandon
          ? { granted: true, fallback: true, reason: 'ad-abandoned' }
          : { granted: false, reason: 'abandoned' };
      }
    }

    this.emit({ placement, at: now, outcome });
    return outcome;
  }

  showBanner(): void {
    if (!this.bannerAd) this.bannerAd = this.platform.createBanner(this.adUnits.banner);
    this.bannerAd?.show();
  }

  hideBanner(): void {
    this.bannerAd?.hide();
  }

  /** 当日各广告位的曝光次数，用于自测和上报。 */
  stats(): { day: string; perPlacement: Record<string, number>; rewardedTotal: number } {
    return {
      day: this.day.day,
      perPlacement: { ...this.day.perPlacement },
      rewardedTotal: this.day.rewardedTotal,
    };
  }

  dispose(): void {
    this.rewardedAd?.destroy();
    this.interstitialAd?.destroy();
    this.bannerAd?.destroy();
    this.rewardedAd = null;
    this.interstitialAd = null;
    this.bannerAd = null;
  }

  // ------------------------------------------------------------- 内部

  private getRewarded(): RewardedVideoAd {
    if (!this.rewardedAd) {
      this.rewardedAd = this.platform.createRewardedVideo(this.adUnits.rewardedVideo);
    }
    return this.rewardedAd;
  }

  private getInterstitial(): InterstitialAd {
    if (!this.interstitialAd) {
      this.interstitialAd = this.platform.createInterstitial(this.adUnits.interstitial);
    }
    return this.interstitialAd;
  }

  private emit(e: AdEvent): void {
    this.onEvent?.(e);
  }

  private loadDay(): DayState {
    const now = this.platform.now();
    const saved = this.platform.storage.get<DayState>(STORAGE_KEY);
    if (saved && saved.day === dayKey(now)) return saved;
    return { day: dayKey(now), perPlacement: {}, rewardedTotal: 0, interstitialTotal: 0 };
  }

  private saveDay(): void {
    this.platform.storage.set(STORAGE_KEY, this.day);
  }

  private rolloverIfNeeded(now: number): void {
    const k = dayKey(now);
    if (this.day.day !== k) {
      this.day = { day: k, perPlacement: {}, rewardedTotal: 0, interstitialTotal: 0 };
      this.saveDay();
    }
  }
}
