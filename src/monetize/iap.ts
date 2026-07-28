import type { ItemKind } from '../core/types.ts';

/**
 * 内购（充值）层。
 *
 * ============================================================
 *  一条决定整个盈利模型结构的约束
 * ============================================================
 *
 * 国内小游戏平台（微信 / 抖音）在 **iOS 上历来无法做虚拟支付**
 * —— 苹果不允许平台方绕过 App Store 内购分成。
 * 具体政策会变，上线前必须按当期规范核实一遍，
 * 但**架构上必须把「这台设备根本不能充值」当成一等状态**，而不是一个报错。
 *
 * 所以：
 *   - 广告是**所有人**的收入地板，iOS 用户基本只能靠广告
 *   - 内购是 Android 上的上限，不能作为收入的必要条件
 *   - 任何「不充值就玩不下去」的设计，在 iOS 上等于直接劝退一半用户
 *
 * `PaymentAvailability` 就是为这条约束存在的。
 *
 * ============================================================
 *  广告和内购卖的必须是不同的东西
 * ============================================================
 *
 * 最常见的错误是让两者卖同一份价值：既能看广告拿加栏，又卖加栏钻石包。
 * 结果是玩家算一笔账 —— 看 30 秒广告能拿到的东西，凭什么花钱买？
 * 于是内购转化不起来，而广告收入也没涨。
 *
 * 正确的分工：
 *   广告卖「一次性的小额救急」  —— 单次复活、单次道具
 *   内购卖「省时间 / 免打扰 / 身份」 —— 钻石包、月卡、去插屏、皮肤
 *
 * 换句话说：**广告卖次数，内购卖体验和身份。**
 */

/** 这台设备能不能充值。见文件头的 iOS 约束。 */
export type PaymentAvailability = 'available' | 'unsupported-platform' | 'unavailable';

export type SkuId =
  /** 首充礼包，一次性 */
  | 'starter'
  /** 月卡，30 天 */
  | 'monthly'
  /** 永久去掉强制插屏和 banner（**不影响激励视频**） */
  | 'no_interstitial'
  /** 钻石包，四档 */
  | 'gems_s'
  | 'gems_m'
  | 'gems_l'
  | 'gems_xl'
  /** 卡关礼包，针对性道具 */
  | 'stuck_pack';

export interface Sku {
  id: SkuId;
  name: string;
  /** 单位：分。用分而不是元，避免浮点。 */
  priceFen: number;
  /** 立刻到账的钻石。 */
  gems?: number;
  /** 立刻到账的道具。 */
  items?: Partial<Record<ItemKind, number>>;
  /** 权益天数（月卡）。 */
  entitlementDays?: number;
  /** 是否只能买一次。 */
  once?: boolean;
  desc: string;
}

/**
 * 商品表。
 *
 * 定价说明：
 *   - 6 元是国内小游戏的首充锚点，几乎所有休闲游戏都用它
 *   - 首档钻石包要**刚好买得起 2~3 次复活**，价值感才立得住；
 *     如果首档买不起一次复活，玩家会觉得「这钱花了没用」
 *   - 月卡 30 元 = 每天 1 元，是最容易被接受的心理账户
 *
 * 这些数字都应该走远端配置下发，这里只是冷启动兜底。
 */
export const SKUS: Record<SkuId, Sku> = {
  starter: {
    id: 'starter',
    name: '首充礼包',
    priceFen: 600,
    gems: 300,
    items: { addPen: 5, dog: 2 },
    once: true,
    desc: '300 钻 + 5 个加栏 + 2 次牧羊犬',
  },

  monthly: {
    id: 'monthly',
    name: '牧场月卡',
    priceFen: 3000,
    entitlementDays: 30,
    gems: 200,
    desc: '每天领 80 钻 · 每关首个道具免费 · 去掉插屏广告',
  },

  no_interstitial: {
    id: 'no_interstitial',
    name: '去广告',
    priceFen: 1800,
    once: true,
    desc: '永久去掉插屏和横幅。激励视频入口保留，你想看才看。',
  },

  // 首档 300 钻 ≈ 复活 5 次（60/120/240 的前两档）或道具若干
  gems_s:  { id: 'gems_s',  name: '一小袋钻石', priceFen: 600,   gems: 300,   desc: '300 钻' },
  gems_m:  { id: 'gems_m',  name: '一袋钻石',   priceFen: 3000,  gems: 1650,  desc: '1650 钻（多送 10%）' },
  gems_l:  { id: 'gems_l',  name: '一箱钻石',   priceFen: 9800,  gems: 5900,  desc: '5900 钻（多送 20%）' },
  gems_xl: { id: 'gems_xl', name: '一车钻石',   priceFen: 32800, gems: 21000, desc: '21000 钻（多送 28%）' },

  stuck_pack: {
    id: 'stuck_pack',
    name: '卡关救援包',
    priceFen: 1200,
    items: { addPen: 3, dog: 2, hint: 5 },
    desc: '3 个加栏 + 2 次牧羊犬 + 5 次提示',
  },
};

export function yuan(sku: Sku): string {
  return (sku.priceFen / 100).toFixed(sku.priceFen % 100 === 0 ? 0 : 2);
}

/** 玩家已获得的权益。 */
export interface Entitlements {
  /** 月卡到期时间戳；0 表示没有。 */
  monthlyUntil: number;
  /** 是否买过永久去广告。 */
  noInterstitial: boolean;
  /** 是否付过费（首充判定用）。 */
  hasPaid: boolean;
}

export function emptyEntitlements(): Entitlements {
  return { monthlyUntil: 0, noInterstitial: false, hasPaid: false };
}

export function hasMonthly(e: Entitlements, now: number): boolean {
  return e.monthlyUntil > now;
}

/**
 * 插屏是否应该被免掉。
 *
 * **注意只免插屏，不动激励视频。**
 * 激励视频是玩家自愿点的、能换到东西的；把它一起去掉等于
 * 断掉付费用户继续贡献广告收入的路，而且玩家也没要求去掉它。
 */
export function interstitialFree(e: Entitlements, now: number): boolean {
  return e.noInterstitial || hasMonthly(e, now);
}

/** 一笔支付的结果。 */
export type PayResult =
  | { ok: true; skuId: SkuId }
  | { ok: false; reason: 'cancelled' | 'unsupported' | 'failed'; message?: string };
