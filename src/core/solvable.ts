import type { DifficultyKnobs, GroupId } from './types.ts';
import type { Rng } from './rng.ts';

/**
 * ============================================================
 *  可解性保证 —— 本项目相对《羊了个羊》最核心的改动
 * ============================================================
 *
 * 《羊了个羊》第二关的难，是「随机死局」的难：牌面随机铺，玩家可能从第一步
 * 就已经必败，但要到卡槽爆掉才知道。玩家学不到东西，失败没有归因，只剩挫败。
 *
 * 这里换一种思路：**先造一条通关路径，再把牌面反推出来**。
 * 于是「无解」这种情况在数学上不存在，玩家每一次失败都确实是自己走错了。
 * 难度改由「卡槽压力」来调 —— 需要玩家提前规划，而不是碰运气。
 *
 * 算法（reverse generation）：
 *   1. geometry.ts 先给出遮挡 DAG，再取一条拓扑序 `order`。
 *      order 的含义是：按这个顺序取牌，每一张被取时都恰好是可点的。
 *   2. 沿着 order 逐张分配「组」，同时模拟卡槽。每一步只从
 *      「不会让卡槽溢出」的候选动作里选。
 *   3. 走完 order，卡槽从头到尾没有超过 capacity —— 那么 order 本身
 *      就是一条通关路径。牌面即为有解。
 *
 * 三种动作：
 *   complete —— 给某个已有 2 张的组补第 3 张，立即消除，卡槽 -2
 *   grow     —— 给某个已有 1 张的组补第 2 张，卡槽 +1
 *   new      —— 开一个新组，卡槽 +1
 *
 * 关于「可用格数」：卡槽有 capacity(=7) 格，但**放满 7 格且没有消除就算输**。
 * 所以任何不触发消除的动作（grow / new）之后，占用必须 ≤ capacity - 1。
 * 只有 complete 可以瞬时摸到第 7 格 —— 因为它落下的同时就消掉 3 张。
 * 下面用 usable = capacity - 1 表示「非消除动作的占用上限」。
 *
 * 不会走进死路的两条不变量（证明见下方 assignGroups 的注释）：
 *   (A) 同时开着的组数 D ≤ usable - 1
 *   (B) needed ≤ remaining，其中 needed = Σ(3 - 手上张数)，remaining = 剩余待分配牌数
 */

export interface HandState {
  /** groupId -> 已在卡槽里的张数（1 或 2；到 3 就消除并移除） */
  counts: Map<GroupId, number>;
  /** 卡槽已占格数 = Σ counts */
  size: number;
}

export function emptyHand(): HandState {
  return { counts: new Map(), size: 0 };
}

export interface AssignResult {
  /** order[i] 这个位置上的牌属于哪个组 */
  groupOf: GroupId[];
  /** 一共开了多少组 */
  groupCount: number;
  /** 模拟过程中卡槽占用的峰值，用于难度体检 */
  peakSlotUsage: number;
}

export interface AssignOptions {
  slotCapacity: number;
  knobs: DifficultyKnobs;
  /** 洗牌道具会带着「当前卡槽内容」重新分配剩余牌，此时传入现场手牌。 */
  initialHand?: HandState;
  /** 新组的起始编号（洗牌时要避开已用编号）。 */
  firstGroupId?: number;
}

/**
 * 沿 order 分配组号。返回值与 order 等长。
 *
 * @param length order 的长度，必须满足 (length + initialHand.size) % 3 === 0
 */
export function assignGroups(length: number, rng: Rng, opts: AssignOptions): AssignResult {
  const capacity = opts.slotCapacity;
  const knobs = opts.knobs;
  // 非消除动作之后的占用上限：放满 capacity 格而没消除就是输。
  const usable = capacity - 1;

  // 不变量 (A)：D ≤ usable - 1。这是「永远有路可走」的关键，见下方证明。
  const maxOpen = Math.max(1, Math.min(knobs.maxOpenGroups, usable - 1));

  const hand: HandState = opts.initialHand
    ? { counts: new Map(opts.initialHand.counts), size: opts.initialHand.size }
    : emptyHand();

  if ((length + hand.size) % 3 !== 0) {
    throw new Error(`待分配牌数与手牌不匹配 3 的倍数：length=${length}, hand=${hand.size}`);
  }

  let nextGroupId = opts.firstGroupId ?? 0;
  const groupOf: GroupId[] = new Array(length);
  let peak = hand.size;
  let opened = 0;

  /** 还差多少张才能把当前开着的组全部凑齐。 */
  const neededOf = (h: HandState): number => {
    let n = 0;
    for (const c of h.counts.values()) n += 3 - c;
    return n;
  };

  for (let i = 0; i < length; i++) {
    const remaining = length - i; // 含当前这一张
    const needed = neededOf(hand);

    const completeCandidates: GroupId[] = [];
    const growCandidates: GroupId[] = [];
    for (const [g, c] of hand.counts) {
      if (c === 2) completeCandidates.push(g);
      else if (c === 1) growCandidates.push(g);
    }

    // grow 不触发消除，占用之后必须 ≤ usable。
    const canGrow = growCandidates.length > 0 && hand.size + 1 <= usable;
    // complete 落下即消除，允许瞬时摸到第 capacity 格。
    const canComplete = completeCandidates.length > 0;
    // 开新组：要占一格、要留够 3 张、组数不能超上限，
    // 且开完之后仍要满足不变量 (B)：needed+2 ≤ remaining-1
    const canNew =
      hand.counts.size < maxOpen &&
      hand.size + 1 <= usable &&
      remaining >= 3 &&
      needed + 2 <= remaining - 1;

    /*
     * 「一定有路可走」的证明：
     *   若 D = 0，则 size = 0 ≤ usable-1，且 needed = 0 ≤ remaining，
     *     由 (length+handSize)%3==0 可推出 remaining ≥ 3，故 canNew 成立。
     *   若 D ≥ 1：
     *     - size < usable 时，growCandidates 或 completeCandidates 必有其一非空
     *       （每个开着的组张数只能是 1 或 2），canGrow 或 canComplete 成立。
     *     - size == usable 时，由 (A) 有 D ≤ usable-1 < size，
     *       说明必有某组张数 ≥ 2，即张数恰为 2（到 3 就被清掉了），canComplete 成立。
     *   所以每一步至少有一个候选动作。∎
     */
    const weights = [
      canComplete ? knobs.weightComplete : 0,
      canGrow ? knobs.weightGrow : 0,
      canNew ? knobs.weightNewGroup : 0,
    ];

    // 剩余吃紧（needed == remaining）时必须收口，禁止再开新组 —— canNew 已经排除了。
    // 万一三个权重都被难度参数配成 0，就退化成「能做什么做什么」。
    if (weights[0] + weights[1] + weights[2] === 0) {
      weights[0] = canComplete ? 1 : 0;
      weights[1] = canGrow ? 1 : 0;
      weights[2] = canNew ? 1 : 0;
    }
    if (weights[0] + weights[1] + weights[2] === 0) {
      throw new Error(`分配走入死路 i=${i} size=${hand.size} D=${hand.counts.size}`);
    }

    const action = rng.weighted(weights);
    let chosen: GroupId;

    if (action === 0) {
      chosen = rng.pick(completeCandidates);
      peak = Math.max(peak, hand.size + 1); // 落下的瞬间确实占了这一格
      hand.counts.delete(chosen);
      hand.size -= 2; // 原本 2 张 + 新这张 = 3 张，一起消除
    } else if (action === 1) {
      chosen = rng.pick(growCandidates);
      hand.counts.set(chosen, 2);
      hand.size += 1;
    } else {
      chosen = nextGroupId++;
      opened++;
      hand.counts.set(chosen, 1);
      hand.size += 1;
    }

    groupOf[i] = chosen;
    peak = Math.max(peak, hand.size);
  }

  if (hand.size !== 0) {
    throw new Error(`分配结束时卡槽未清空：size=${hand.size}`);
  }

  return { groupOf, groupCount: opened, peakSlotUsage: peak };
}

/**
 * 把组号映射到玩家看得见的图标。
 *
 * 多个组共用一个图标是**安全**的，而且是我们想要的：
 * 消除规则按图标判定，如果两个组共用图标「青草」，那么手上凑齐任意 3 张青草
 * 就会消除 —— 这只会比模拟时**更早**释放卡槽，占用永远 ≤ 模拟值。
 * 所以通关路径依然成立，同时用少量图标就能撑起大牌面。
 */
export function mapGroupsToIcons(groupCount: number, iconCount: number, rng: Rng): number[] {
  const icons = Math.max(1, iconCount);
  const table: number[] = new Array(groupCount);
  // 先保证每个图标至少被用到一次（图标种类太少时自然退化）
  const base = rng.shuffle(Array.from({ length: groupCount }, (_, i) => i));
  for (let i = 0; i < groupCount; i++) {
    table[base[i]] = i < icons ? i : rng.int(icons);
  }
  return table;
}
