import type { SheepGame } from '../core/game.ts';
import type { AdManager } from './ad-manager.ts';

/**
 * 失败 → 看广告 → 继续 的完整流程。
 *
 * 设计要点（这部分是最容易做坏的地方）：
 *
 * **递减补偿。** 第 1 次广告复活清 3 张，第 2 次清 2 张，之后只能花钻石。
 * 如果每次都清一样多，玩家就能靠无限看广告硬拖过任何关卡 ——
 * 关卡难度失去意义，通关也不再有成就感，长期反而没人看广告了。
 * 递减让「广告复活」是一次救援，而不是一条捷径。
 *
 * **复活后重新保证有解。** 见 game.revive()。
 * 玩家花 30 秒看完广告，换来的必须是一个真能打通的局面。
 * 如果复活回去发现还是死局，这 30 秒就变成了纯粹的欺骗感 —— 这是最伤留存的体验。
 *
 * **兜底也算数。** 广告没加载出来（无填充），照样复活。
 * 玩家永远不该为我们的填充率买单。
 */

export type ReviveOffer =
  | { kind: 'ad'; tilesCleared: number; attempt: number }
  | { kind: 'diamond'; tilesCleared: number; cost: number; attempt: number }
  | { kind: 'none'; reason: string };

/** 广告复活的递减梯度。数组长度 = 允许的广告复活次数。 */
export const AD_REVIVE_LADDER = [3, 2];
/** 广告用完之后的钻石复活，价格递增。 */
export const DIAMOND_REVIVE_LADDER = [
  { cost: 60, tiles: 3 },
  { cost: 120, tiles: 3 },
  { cost: 240, tiles: 3 },
];

export interface Wallet {
  diamonds(): number;
  spend(n: number): boolean;
}

export class ReviveController {
  private ads: AdManager;
  private wallet: Wallet;
  /** 本关已经复活过几次（广告 + 钻石合计）。 */
  private attempts = 0;

  constructor(ads: AdManager, wallet: Wallet) {
    this.ads = ads;
    this.wallet = wallet;
  }

  startLevel(): void {
    this.attempts = 0;
  }

  get attemptCount(): number {
    return this.attempts;
  }

  /**
   * 当前该给玩家看什么复活选项。UI 直接照着这个渲染即可。
   */
  offer(): ReviveOffer {
    const adIndex = this.attempts;
    if (adIndex < AD_REVIVE_LADDER.length) {
      const gate = this.ads.check('revive');
      if (gate.allowed) {
        return { kind: 'ad', tilesCleared: AD_REVIVE_LADDER[adIndex], attempt: this.attempts + 1 };
      }
      // 广告位被频控挡住（比如日上限到了），降级到钻石而不是直接结束。
    }

    const dIndex = Math.max(0, this.attempts - AD_REVIVE_LADDER.length);
    if (dIndex < DIAMOND_REVIVE_LADDER.length) {
      const step = DIAMOND_REVIVE_LADDER[dIndex];
      return {
        kind: 'diamond',
        tilesCleared: step.tiles,
        cost: step.cost,
        attempt: this.attempts + 1,
      };
    }

    return { kind: 'none', reason: '本关复活次数已用完' };
  }

  /**
   * 执行一次广告复活。
   * @returns 是否真的复活了
   */
  async reviveByAd(game: SheepGame): Promise<{ ok: boolean; fallback: boolean; tiles: number }> {
    const offer = this.offer();
    if (offer.kind !== 'ad') return { ok: false, fallback: false, tiles: 0 };

    const outcome = await this.ads.request('revive');
    if (!outcome.granted) return { ok: false, fallback: false, tiles: 0 };

    this.attempts++;
    game.revive(offer.tilesCleared);
    return { ok: true, fallback: outcome.fallback, tiles: offer.tilesCleared };
  }

  /** 钻石复活。 */
  reviveByDiamond(game: SheepGame): { ok: boolean; tiles: number } {
    const offer = this.offer();
    if (offer.kind !== 'diamond') return { ok: false, tiles: 0 };
    if (!this.wallet.spend(offer.cost)) return { ok: false, tiles: 0 };

    this.attempts++;
    game.revive(offer.tilesCleared);
    return { ok: true, tiles: offer.tilesCleared };
  }
}

/** 最简单的钻石钱包实现，接入内购时替换成服务端账本。 */
export class LocalWallet implements Wallet {
  private balance: number;
  constructor(initial = 0) {
    this.balance = initial;
  }
  diamonds(): number {
    return this.balance;
  }
  add(n: number): void {
    this.balance += n;
  }
  spend(n: number): boolean {
    if (this.balance < n) return false;
    this.balance -= n;
    return true;
  }
}
