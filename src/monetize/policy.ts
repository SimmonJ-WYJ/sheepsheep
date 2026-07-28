import type { ItemKind } from '../core/types.ts';

/**
 * 广告策略。
 *
 * 三条原则，全部落成了下面的配置项：
 *
 * 1) **广告是玩家主动买的服务，不是我们强塞的税。**
 *    绝大多数广告位是激励视频（rewarded），玩家点了才播，且必须知道能换到什么。
 *    插屏（interstitial）只保留一个位置，而且带冷却和日上限。
 *
 * 2) **永远不要因为广告没加载出来而惩罚玩家。**
 *    无填充 / 加载超时 / 网络抖动都不是玩家的错。`grantOnFailure` 为 true 的广告位，
 *    播放失败照样发奖励。丢的是一次 eCPM，保住的是留存 —— 这笔账永远划算。
 *
 * 3) **前几分钟一分钱都不要赚。**
 *    冷启动静默期 + 新手关免广告。第一印象是「这游戏挺好玩」还是「广告真多」，
 *    直接决定次留，而次留决定了这个用户一辈子能给你带来多少广告收入。
 */

export type AdFormat = 'rewarded' | 'interstitial' | 'banner';

export type AdPlacement =
  /** 失败后复活继续 */
  | 'revive'
  /** 单个道具补一次使用次数 */
  | 'item_undo'
  | 'item_addPen'
  | 'item_hint'
  | 'item_dog'
  | 'item_sort'
  /** 道具箱：一次广告换 3 个随机道具，用来降低广告打断频次 */
  | 'item_box'
  /**
   * 看广告直接换钻石。
   *
   * 这是**不能充值的用户（iOS）唯一的钻石来源**，也是把免费用户变现的主要方式。
   * 额度给得比别的位都宽，因为它同时承担「别把人堵死」和「赚钱」两件事。
   */
  | 'gems_for_ad'
  /** 每日签到奖励翻倍 */
  | 'daily_double'
  /** 牧场离线收益翻倍 */
  | 'offline_double'
  /** 关卡开始前插屏 */
  | 'level_start'
  /** 结算页 banner */
  | 'settle_banner';

export const ITEM_PLACEMENT: Record<ItemKind, AdPlacement> = {
  undo: 'item_undo',
  addPen: 'item_addPen',
  hint: 'item_hint',
  dog: 'item_dog',
  sort: 'item_sort',
};

export interface PlacementRule {
  format: AdFormat;
  /** 单个自然日上限。0 表示禁用该广告位。 */
  dailyCap: number;
  /** 单关上限。Infinity 表示不限。 */
  perLevelCap: number;
  /** 该广告位自己的冷却。 */
  cooldownMs: number;
  /** 播放失败（无填充/超时/报错）时是否照样发奖励。 */
  grantOnFailure: boolean;
  /** 玩家中途关掉没看完时是否发奖励。默认否，否则激励视频就失去意义了。 */
  grantOnAbandon: boolean;
}

export interface AdPolicy {
  /** 任意两次广告之间的全局最小间隔。防止「消一次弹一次」的体验灾难。 */
  globalMinIntervalMs: number;
  /** 冷启动后多久之内不出任何广告。 */
  coldStartQuietMs: number;
  /** 前 N 关完全不出广告（含激励视频入口都不展示）。 */
  newUserQuietLevels: number;
  /** 激励视频每日总上限。超过之后所有 rewarded 位一律 blocked。 */
  rewardedDailyCap: number;
  /** 插屏每日总上限。 */
  interstitialDailyCap: number;
  placements: Record<AdPlacement, PlacementRule>;
}

const rewarded = (
  dailyCap: number,
  perLevelCap: number,
  cooldownMs: number,
  grantOnFailure = true,
): PlacementRule => ({
  format: 'rewarded',
  dailyCap,
  perLevelCap,
  cooldownMs,
  grantOnFailure,
  grantOnAbandon: false,
});

/**
 * 默认策略。数值是给冷启动用的起点，上线后应该由远端配置下发、按分层 AB 调。
 * 见 docs/03 的「怎么调」小节。
 */
export const DEFAULT_AD_POLICY: AdPolicy = {
  globalMinIntervalMs: 45_000,
  coldStartQuietMs: 180_000,
  newUserQuietLevels: 5,
  rewardedDailyCap: 20,
  interstitialDailyCap: 5,
  placements: {
    // 复活：核心广告位，日上限给到最宽，冷却设 0
    // —— 玩家在失败当下的付费意愿最高，这时候卡他毫无道理。
    revive: rewarded(12, 2, 0),

    // 单道具补充：每关每种最多 2 次，避免「无限道具」把关卡难度冲垮
    item_undo: rewarded(8, 2, 20_000),
    item_hint: rewarded(8, 2, 20_000),
    item_sort: rewarded(8, 2, 20_000),
    // 加栏位是本作最强的道具（直接放宽缓冲区），额度收得比别的紧
    item_addPen: rewarded(5, 2, 30_000),
    // 牧羊犬会送走一只羊，等于跳过一段解法，同样收紧
    item_dog: rewarded(4, 1, 30_000),

    // 道具箱：一次广告给 3 个道具。
    // 单次价值更高 → 玩家更愿意看 → 打断次数反而更少，是更优的形态。
    item_box: rewarded(6, 1, 60_000),

    // 看广告换钻石：每日 4 次。免费玩家的生命线，见 economy.ts
    gems_for_ad: rewarded(4, Infinity, 30_000),

    daily_double: rewarded(1, Infinity, 0),
    offline_double: rewarded(3, Infinity, 0),

    // 唯一的强制广告。放在关卡之间的自然断点，且从第 6 关才开始出。
    level_start: {
      format: 'interstitial',
      dailyCap: 5,
      perLevelCap: 1,
      cooldownMs: 240_000,
      grantOnFailure: false,
      grantOnAbandon: false,
    },

    settle_banner: {
      format: 'banner',
      dailyCap: Infinity,
      perLevelCap: Infinity,
      cooldownMs: 0,
      grantOnFailure: false,
      grantOnAbandon: false,
    },
  },
};

/** 抖音后台申请到的广告位 id，填在这里。 */
export interface AdUnitIds {
  rewardedVideo: string;
  interstitial: string;
  banner: string;
}

export const PLACEHOLDER_AD_UNITS: AdUnitIds = {
  rewardedVideo: 'REPLACE_ME_REWARDED_VIDEO_ID',
  interstitial: 'REPLACE_ME_INTERSTITIAL_ID',
  banner: 'REPLACE_ME_BANNER_ID',
};
