import type { Entitlements, PaymentAvailability, SkuId } from './iap.ts';
import { hasMonthly } from './iap.ts';

/**
 * 充值弹窗的触发引擎 —— 回答「什么时候让他充值」。
 *
 * ============================================================
 *  唯一的核心原则
 * ============================================================
 *
 * **在玩家已经用行为证明了需求之后才弹，绝不提前弹。**
 *
 * 反例（也是绝大多数小游戏的做法）：一进游戏就弹首充。
 * 这时玩家对游戏还没有任何感情，弹窗只传达一件事：「这游戏想掏我钱」。
 * 转化率极低，而且污染第一印象，连带压低次留。
 *
 * 正例：玩家刚刚看完一支 30 秒广告换到复活 —— 他已经用行动说了
 * 「我在意这一关，我愿意为它付出成本」。此时首充礼包的价值锚点
 * 就是他刚刚亲手付出的那 30 秒，转化率会高一个量级。
 *
 * 所以下面每一条触发条件，都是一个「玩家已经表达了需求」的信号。
 *
 * ============================================================
 *  第二条原则：关掉几次就永久别再弹
 * ============================================================
 *
 * 每个弹窗都有 `maxShows`。玩家关掉 N 次之后就再也不弹。
 *
 * 这条经常被当成「让钱」，其实反了：一个从不骚扰人的弹窗，
 * 玩家在真正需要的时候才会点开看；一个反复糊脸的弹窗，
 * 玩家会训练出「见到就关」的肌肉记忆，之后再也转化不了。
 */

export type OfferId =
  | 'starter'
  | 'monthly'
  | 'no_interstitial'
  | 'gems'
  | 'stuck_pack';

/** 触发引擎需要知道的玩家状态。全部由外部维护并持久化。 */
export interface PlayerSignals {
  /** 累计登录天数。 */
  totalDays: number;
  /** 连续登录天数。 */
  streakDays: number;
  /** 累计看过多少支激励视频 —— 最重要的付费意愿信号。 */
  adsWatchedTotal: number;
  /** 本次会话里靠广告复活了几次。 */
  adRevivesThisSession: number;
  /** 累计被插屏打断了几次。 */
  interstitialsSeen: number;
  /** 当前钻石余额。 */
  gems: number;
  /** 当前关卡。 */
  levelId: number;
  /** 当前这一关连续失败了几次。 */
  failsThisLevel: number;
  /** 玩家刚刚是不是因为钻石不够而没买成东西。 */
  justBlockedByGems: boolean;
}

export interface OfferState {
  /** 每个弹窗展示过几次。 */
  shown: Partial<Record<OfferId, number>>;
  /** 每个弹窗上次展示的时间戳。 */
  lastShownAt: Partial<Record<OfferId, number>>;
  /** 玩家主动关掉过几次。 */
  dismissed: Partial<Record<OfferId, number>>;
}

export function emptyOfferState(): OfferState {
  return { shown: {}, lastShownAt: {}, dismissed: {} };
}

interface Rule {
  id: OfferId;
  sku: SkuId | 'gems-tiers';
  /** 数字越大越优先。同时满足多个条件时只弹优先级最高的那个。 */
  priority: number;
  /** 两次展示的最小间隔。 */
  cooldownMs: number;
  /** 累计展示上限。到了就永久不再弹。 */
  maxShows: number;
  /** 玩家主动关掉几次之后永久不再弹。 */
  maxDismiss: number;
  /** 已经买过就不再弹。 */
  skipIfOwned?: (e: Entitlements, now: number) => boolean;
  /** 触发条件 —— 每一条都是「玩家已经表达了需求」的信号。 */
  when: (s: PlayerSignals, e: Entitlements, now: number) => boolean;
  /** 给运营和埋点看的一句话说明。 */
  rationale: string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * 触发规则表。这是整个盈利模型「什么时候」的答案，全在这张表里。
 * 上线后应当整表走远端配置下发。
 */
export const RULES: Rule[] = [
  {
    id: 'stuck_pack',
    sku: 'stuck_pack',
    priority: 100,
    cooldownMs: 30 * MIN,
    maxShows: 6,
    maxDismiss: 3,
    // 同一关连续失败 3 次 —— 需求最明确的时刻，转化率最高的场景
    when: (s) => s.failsThisLevel >= 3,
    rationale: '同一关连输 3 次：需求极其明确，针对性给道具',
  },

  {
    id: 'gems',
    sku: 'gems-tiers',
    priority: 90,
    cooldownMs: 10 * MIN,
    maxShows: 30,
    maxDismiss: 8,
    // 刚刚因为钻石不够买不成东西 —— 玩家自己撞到了墙，不是我们推的
    when: (s) => s.justBlockedByGems,
    rationale: '钻石不足导致操作失败的那一刻，玩家自己产生了缺口',
  },

  {
    id: 'starter',
    sku: 'starter',
    priority: 80,
    cooldownMs: 2 * HOUR,
    maxShows: 5,
    maxDismiss: 2,
    skipIfOwned: (e) => e.hasPaid,
    /*
     * 首充礼包的触发时机是整个模型里最值得琢磨的一个。
     *
     * 不是「进游戏」，不是「第一次失败」，而是
     * **第一次靠广告复活成功之后** ——
     * 玩家刚刚亲手付出 30 秒换到了继续游戏的机会，
     * 他已经用行动证明了「这一关值得我付出成本」。
     * 此时 6 元礼包的价值锚点是他刚刚付出的那 30 秒，而不是空气。
     */
    when: (s) => s.adRevivesThisSession >= 1,
    rationale: '第一次广告复活之后：玩家刚用 30 秒证明了付费意愿',
  },

  {
    id: 'monthly',
    sku: 'monthly',
    priority: 70,
    cooldownMs: 24 * HOUR,
    maxShows: 8,
    maxDismiss: 3,
    skipIfOwned: (e, now) => hasMonthly(e, now),
    /*
     * 月卡卖的是「把时间成本换成金钱成本」。
     * 所以触发信号应该是「这个人已经在大量支付时间成本」：
     * 累计看了 15 支广告，或者连续登录 3 天。
     */
    when: (s) => s.adsWatchedTotal >= 15 || s.streakDays >= 3,
    rationale: '累计看 15 支广告或连登 3 天：已在大量付出时间成本，可升级为金钱成本',
  },

  {
    id: 'no_interstitial',
    sku: 'no_interstitial',
    priority: 60,
    cooldownMs: 12 * HOUR,
    maxShows: 4,
    maxDismiss: 2,
    skipIfOwned: (e) => e.noInterstitial,
    /*
     * 给「讨厌广告但愿意付钱」的人一个出口。
     * 没有这个出口，他们的选择就只剩卸载。
     * 触发信号：被插屏打断 3 次以上。
     */
    when: (s) => s.interstitialsSeen >= 3,
    rationale: '被插屏打断 3 次以上：给厌广用户一个花钱解决的出口，否则他们只会卸载',
  },
];

export interface Offer {
  id: OfferId;
  sku: SkuId | 'gems-tiers';
  rationale: string;
}

export type OfferDecision =
  | { show: true; offer: Offer }
  | { show: false; reason: 'payment-unavailable' | 'nothing-triggered' | 'all-gated' };

export interface OfferEngineOptions {
  /** 这台设备能不能充值。iOS 上通常不能，见 iap.ts 文件头。 */
  availability: PaymentAvailability;
  /** 新手保护：前 N 关一个充值弹窗都不出。 */
  quietLevels?: number;
  /** 冷启动静默期。 */
  quietMs?: number;
  rules?: Rule[];
}

const DEFAULT_QUIET_LEVELS = 8;
const DEFAULT_QUIET_MS = 5 * MIN;

/**
 * 决定「现在该不该弹充值、弹哪个」。
 *
 * 用法：在关卡结算、失败、钻石不足这几个自然断点各调一次；
 * **不要在游戏进行中调**，弹窗打断操作是最招人烦的。
 */
export class OfferEngine {
  private opts: OfferEngineOptions;
  private rules: Rule[];
  private bootAt: number;
  state: OfferState;

  constructor(opts: OfferEngineOptions, bootAt: number, state?: OfferState) {
    this.opts = opts;
    this.rules = (opts.rules ?? RULES).slice().sort((a, b) => b.priority - a.priority);
    this.bootAt = bootAt;
    this.state = state ?? emptyOfferState();
  }

  /** 这台设备完全不能充值时，所有充值入口都不该出现（连按钮都别画）。 */
  get canPay(): boolean {
    return this.opts.availability === 'available';
  }

  decide(s: PlayerSignals, e: Entitlements, now: number): OfferDecision {
    // iOS 不能虚拟支付 —— 直接闭嘴，别画任何充值入口
    if (!this.canPay) return { show: false, reason: 'payment-unavailable' };

    // 冷启动静默 + 新手关保护：第一印象不能是「这游戏想掏我钱」
    if (now - this.bootAt < (this.opts.quietMs ?? DEFAULT_QUIET_MS)) {
      return { show: false, reason: 'all-gated' };
    }
    if (s.levelId > 0 && s.levelId <= (this.opts.quietLevels ?? DEFAULT_QUIET_LEVELS)) {
      return { show: false, reason: 'all-gated' };
    }

    let anyTriggered = false;

    for (const r of this.rules) {
      if (!r.when(s, e, now)) continue;
      anyTriggered = true;

      if (r.skipIfOwned?.(e, now)) continue;
      if ((this.state.shown[r.id] ?? 0) >= r.maxShows) continue;
      if ((this.state.dismissed[r.id] ?? 0) >= r.maxDismiss) continue;

      const last = this.state.lastShownAt[r.id] ?? -Infinity;
      if (now - last < r.cooldownMs) continue;

      return { show: true, offer: { id: r.id, sku: r.sku, rationale: r.rationale } };
    }

    return { show: false, reason: anyTriggered ? 'all-gated' : 'nothing-triggered' };
  }

  /** UI 真的把弹窗画出来之后调用。 */
  markShown(id: OfferId, now: number): void {
    this.state.shown[id] = (this.state.shown[id] ?? 0) + 1;
    this.state.lastShownAt[id] = now;
  }

  /** 玩家主动关掉弹窗时调用 —— 关够次数就永久不再打扰。 */
  markDismissed(id: OfferId): void {
    this.state.dismissed[id] = (this.state.dismissed[id] ?? 0) + 1;
  }

  /** 玩家买了。 */
  markPurchased(id: OfferId): void {
    // 买过之后这个位置就不用再推了，交给 skipIfOwned / 余额判断
    this.state.lastShownAt[id] = Infinity;
  }

  /** 推荐哪一档钻石包：能刚好解决当前缺口的最小一档。 */
  static gemTierFor(shortfall: number): SkuId {
    if (shortfall <= 300) return 'gems_s';
    if (shortfall <= 1650) return 'gems_m';
    if (shortfall <= 5900) return 'gems_l';
    return 'gems_xl';
  }
}
