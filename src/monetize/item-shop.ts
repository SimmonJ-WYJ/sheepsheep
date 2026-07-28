import type { ItemKind } from '../core/types.ts';
import type { SortGame } from '../core/game.ts';
import type { AdManager } from './ad-manager.ts';
import { ITEM_PLACEMENT } from './policy.ts';
import type { Wallet } from './revive.ts';

/**
 * 道具 → 广告 的兑换流程。
 *
 * 交互顺序刻意设计成这样：
 *   玩家点道具 → 有免费次数就直接用（**不弹任何东西**）
 *              → 没有了才弹「看广告 +1 次」
 *
 * 很多小游戏是「点道具就先弹广告确认框」，这会让玩家觉得每个按钮都是陷阱，
 * 于是干脆不点道具了 —— 道具用得越少，广告收入反而越低。
 * 先给甜头、把使用习惯养出来，再在断供点收广告，长期总收入更高。
 */

export type ItemRequestResult =
  | { ok: true; source: 'free' | 'ad' | 'diamond'; fallback?: boolean }
  | { ok: false; reason: 'no-effect' | 'not-usable' | 'ad-blocked' | 'ad-not-granted' | 'insufficient' };

/** 道具的钻石价格。 */
export const ITEM_PRICE: Record<ItemKind, number> = {
  undo: 20,
  hint: 25,
  sort: 30,
  addPen: 60,
  dog: 50,
};

/** 道具箱一次开出的道具数量。 */
const BOX_SIZE = 3;
const BOX_POOL: ItemKind[] = ['undo', 'hint', 'sort', 'addPen'];

export class ItemShop {
  private ads: AdManager;
  private wallet: Wallet;

  constructor(ads: AdManager, wallet: Wallet) {
    this.ads = ads;
    this.wallet = wallet;
  }

  /**
   * UI 用它决定道具按钮长什么样：
   *   free   → 显示剩余次数
   *   ad     → 显示小电视图标
   *   diamond→ 显示钻石价格
   *   locked → 置灰
   *
   * 道具当前用下去没有效果时（比如一步都没走就点「撤销」、
   * 或者牧羊犬叼走任何一只羊都会让局面变成无解）一律置灰，
   * 绝不放行到广告 —— 详见 game.canUseItem()。
   */
  buttonState(game: SortGame, kind: ItemKind): 'free' | 'ad' | 'diamond' | 'locked' {
    if (!game.canUseItem(kind)) return 'locked';
    if (game.itemCount(kind) > 0) return 'free';
    if (this.ads.check(ITEM_PLACEMENT[kind]).allowed) return 'ad';
    if (this.wallet.diamonds() >= ITEM_PRICE[kind]) return 'diamond';
    return 'locked';
  }

  /** 直接用免费次数。 */
  useFree(game: SortGame, kind: ItemKind): ItemRequestResult {
    if (!game.canUseItem(kind)) return { ok: false, reason: 'no-effect' };
    return game.useItem(kind)
      ? { ok: true, source: 'free' }
      : { ok: false, reason: 'not-usable' };
  }

  /** 看广告换一次使用机会，并立即使用。 */
  async useByAd(game: SortGame, kind: ItemKind): Promise<ItemRequestResult> {
    // 先确认这道具真能起作用，再去播广告。顺序不能反。
    if (!game.canUseItem(kind)) return { ok: false, reason: 'no-effect' };

    const placement = ITEM_PLACEMENT[kind];
    if (!this.ads.check(placement).allowed) return { ok: false, reason: 'ad-blocked' };

    const outcome = await this.ads.request(placement);
    if (!outcome.granted) return { ok: false, reason: 'ad-not-granted' };

    game.grantItem(kind, 1);
    // 广告已经看了，道具就是玩家的了。
    // 万一这里用不掉（极端时序），次数留在背包里，不能吞。
    if (!game.useItem(kind)) return { ok: false, reason: 'not-usable' };
    return { ok: true, source: 'ad', fallback: outcome.fallback };
  }

  /** 钻石购买并使用。 */
  useByDiamond(game: SortGame, kind: ItemKind): ItemRequestResult {
    if (!game.canUseItem(kind)) return { ok: false, reason: 'no-effect' };
    if (!this.wallet.spend(ITEM_PRICE[kind])) return { ok: false, reason: 'insufficient' };
    game.grantItem(kind, 1);
    if (!game.useItem(kind)) return { ok: false, reason: 'not-usable' };
    return { ok: true, source: 'diamond' };
  }

  /**
   * 道具箱：一次广告开 3 个道具。
   *
   * 单次广告的价值更高，玩家更愿意点，而总的广告打断次数更少 ——
   * 对留存和 eCPM 都更友好。放在关卡开始前的准备页，是主推形态。
   */
  async openBox(
    game: SortGame,
    pick: (pool: ItemKind[]) => ItemKind,
  ): Promise<{ ok: boolean; items: ItemKind[]; fallback?: boolean }> {
    if (!this.ads.check('item_box').allowed) return { ok: false, items: [] };
    const outcome = await this.ads.request('item_box');
    if (!outcome.granted) return { ok: false, items: [] };

    const items: ItemKind[] = [];
    for (let i = 0; i < BOX_SIZE; i++) {
      const k = pick(BOX_POOL);
      game.grantItem(k, 1);
      items.push(k);
    }
    return { ok: true, items, fallback: outcome.fallback };
  }
}
