import type { Storage } from '../platform/adapter.ts';
import type { Wallet } from './revive.ts';
import { DIAMOND_REVIVE_LADDER } from './revive.ts';

/**
 * 钻石经济 —— **不充值也要能玩下去**。
 *
 * ============================================================
 *  这个文件是补一个真实的漏洞
 * ============================================================
 *
 * 复活的梯度是「2 次广告 → 之后只能花钻石」。
 * 如果钻石只能靠充值获得，那么**不充值的用户打到第 3 次复活就撞上一道硬墙**。
 * 而在 iOS 上（虚拟支付历来关闭，见 platform/adapter.ts）那就是全部用户。
 *
 * 这正是《羊了个羊》最招骂的那种体感：你不是打不过，你是被拦住了。
 * 我们花了整个项目去规避「玩家觉得被耍」，不能在最后一步自己踩进去。
 *
 * 所以钻石必须有一条**完全免费的获取通路**，而且要算得出来够不够用。
 *
 * ============================================================
 *  但也不能无限
 * ============================================================
 *
 * 每日获取有上限，且上限刻意设成：
 *   够买前两档钻石复活（60 + 120 = 180），但**买不起三档全买**（+240 = 420）。
 *
 * 于是：
 *   - 免费玩家永远不会被硬墙拦住（够两次复活）
 *   - 最深的那一档仍然有价值（要么攒几天，要么充值）
 *   - 「充值」买的是**省时间**，而不是买通行权 —— 和 iap.ts 的分工原则一致
 *
 * 这两条都有单测守着，改数值时会被立刻抓出来。
 */

export type EarnSource =
  /** 每日签到 */
  | 'daily_signin'
  /** 连续签到 7 天的额外奖励 */
  | 'streak_bonus'
  /** 从抖音侧边栏进入（不花广告成本的召回位） */
  | 'sidebar_visit'
  /** 通关评星奖励，按星数结算 */
  | 'level_stars'
  /** 完成每日挑战 */
  | 'daily_challenge'
  /** 看激励视频直接换钻石 —— 免费玩家的主要来源 */
  | 'ad_for_gems';

export interface EarnRule {
  source: EarnSource;
  /** 单次（或单位）到账钻石数。 */
  gems: number;
  /** 每日上限（钻石数，不是次数）。 */
  dailyCap: number;
  note: string;
}

/**
 * 获取来源表。全部数值应走远端配置下发，这里只是冷启动兜底。
 *
 * `ad_for_gems` 是这张表里最重要的一条：
 * 它既是免费玩家的生命线，也是**把不付费用户变现的主要方式** ——
 * 对不能充值的 iOS 用户来说，这一条基本就是全部收入来源。
 */
export const EARN: Record<EarnSource, EarnRule> = {
  daily_signin:    { source: 'daily_signin',    gems: 25, dailyCap: 25,  note: '每日签到' },
  streak_bonus:    { source: 'streak_bonus',    gems: 100, dailyCap: 100, note: '连签 7 天' },
  sidebar_visit:   { source: 'sidebar_visit',   gems: 30, dailyCap: 30,  note: '从侧边栏进入' },
  level_stars:     { source: 'level_stars',     gems: 5,  dailyCap: 60,  note: '每颗星 5 钻' },
  daily_challenge: { source: 'daily_challenge', gems: 40, dailyCap: 40,  note: '完成每日挑战' },
  ad_for_gems:     { source: 'ad_for_gems',     gems: 30, dailyCap: 120, note: '看广告换钻，每日 4 次' },
};

/**
 * 每日靠免费途径最多能拿到多少钻石。
 *
 * 注意 `streak_bonus` 不计入 —— 它一周才出现一次，不能当日常收入算。
 */
export function dailyEarnCeiling(): number {
  let total = 0;
  for (const r of Object.values(EARN)) {
    if (r.source === 'streak_bonus') continue;
    total += r.dailyCap;
  }
  return total;
}

/** 前 n 档钻石复活的总花费。 */
export function reviveCostThrough(n: number): number {
  return DIAMOND_REVIVE_LADDER.slice(0, n).reduce((sum, s) => sum + s.cost, 0);
}

interface LedgerDay {
  day: string;
  earned: Partial<Record<EarnSource, number>>;
}

interface LedgerState {
  balance: number;
  today: LedgerDay;
}

const STORAGE_KEY = 'gem_ledger_v1';

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * 钻石账本。
 *
 * 上线时余额必须以**服务端为准** —— 这里的本地账本只是缓存和离线兜底，
 * 否则改本地存储就能刷钻石。`spend()` 的最终裁决权应该在服务端。
 */
export class GemLedger implements Wallet {
  private storage: Storage;
  private now: () => number;
  private state: LedgerState;

  constructor(storage: Storage, now: () => number, initial = 0) {
    this.storage = storage;
    this.now = now;
    const saved = storage.get<LedgerState>(STORAGE_KEY);
    const today = dayKey(now());
    this.state =
      saved && saved.today.day === today
        ? saved
        : { balance: saved?.balance ?? initial, today: { day: today, earned: {} } };
  }

  diamonds(): number {
    return this.state.balance;
  }

  spend(n: number): boolean {
    if (n < 0) return false;
    if (this.state.balance < n) return false;
    this.state.balance -= n;
    this.save();
    return true;
  }

  /** 内购到账。 */
  credit(n: number): void {
    this.state.balance += n;
    this.save();
  }

  /** 今天这个来源已经拿了多少。 */
  earnedToday(source: EarnSource): number {
    this.rollover();
    return this.state.today.earned[source] ?? 0;
  }

  /** 今天这个来源还能拿多少。 */
  remainingToday(source: EarnSource): number {
    return Math.max(0, EARN[source].dailyCap - this.earnedToday(source));
  }

  /**
   * 领取一次奖励。
   *
   * @param units 单位数（如通关拿到 3 颗星就传 3）
   * @returns 实际到账的钻石数；被每日上限截掉时会小于名义值，返回 0 表示已达上限
   */
  earn(source: EarnSource, units = 1): number {
    this.rollover();
    const rule = EARN[source];
    const want = rule.gems * Math.max(0, units);
    const room = this.remainingToday(source);
    const got = Math.min(want, room);
    if (got <= 0) return 0;

    this.state.today.earned[source] = this.earnedToday(source) + got;
    this.state.balance += got;
    this.save();
    return got;
  }

  private rollover(): void {
    const today = dayKey(this.now());
    if (this.state.today.day !== today) {
      this.state.today = { day: today, earned: {} };
      this.save();
    }
  }

  private save(): void {
    this.storage.set(STORAGE_KEY, this.state);
  }
}
