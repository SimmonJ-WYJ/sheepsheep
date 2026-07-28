import type { Move, Pens } from './types.ts';
import {
  applyMoveInPlace,
  canonicalKey,
  clonePens,
  isWon,
  legalMoves,
  topRun,
} from './board.ts';

/**
 * 求解器 —— 整个项目的地基。
 *
 * 上一版（三消叠叠乐）靠「反向生成」在构造上保证有解。这一版换了玩法，
 * 改成更强的做法：**每个关卡都由求解器实际解出一条通关路径才发给玩家**。
 * 于是我们手上不只有「有解」这个结论，还有一条**具体的解**。
 *
 * 这条具体的解顺带解决了三件事：
 *   1. 「提示」道具 —— 从当前局面重新求解，给出下一步
 *   2. 「牧羊犬」道具 —— 叼走一只羊之后重新求解，无解就不给用（见 game.ts）
 *   3. 「复活」—— 加了空栏位之后必须仍然有解，否则广告就是骗人的
 *
 * 《羊了个羊》做不到这些，因为它压根没有求解器，只能随机铺牌然后祈祷。
 */

export interface SolveResult {
  moves: Move[];
  /** 搜索访问的节点数，用于难度评估和性能观察。 */
  nodes: number;
  /** 是否因为超出预算而放弃（此时 moves 为空但不代表真的无解）。 */
  exhausted: boolean;
}

export interface SolveOptions {
  /** 节点预算。超了就放弃搜索。 */
  budget?: number;
  /** 最大搜索深度，防止在等价状态间无限打转。 */
  maxDepth?: number;
}

const DEFAULT_BUDGET = 300_000;
const DEFAULT_MAX_DEPTH = 220;

/**
 * 深度优先搜索 + 规范化去重。
 *
 * 为什么 DFS 而不是 BFS：我们要的是「存在一条解」和「一条够用的解」，
 * 不是最短解。DFS 的内存占用是深度级别的，BFS 会爆。
 *
 * 启发式排序（`orderMoves`）对速度影响极大 —— 优先走那些
 * 「立刻能出栏」和「把同品种合并」的手，通常几百个节点就能出解。
 */
export function solve(pens: Pens, capacity: number, opts: SolveOptions = {}): SolveResult | null {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

  const state = clonePens(pens);
  const seen = new Set<string>();
  const path: Move[] = [];
  let nodes = 0;
  let exhausted = false;

  const dfs = (depth: number): boolean => {
    if (isWon(state)) return true;
    if (depth >= maxDepth) return false;
    if (nodes >= budget) {
      exhausted = true;
      return false;
    }
    nodes++;

    const key = canonicalKey(state);
    if (seen.has(key)) return false;
    seen.add(key);

    for (const move of orderMoves(state, capacity)) {
      // 记下撤销所需的信息
      const destBefore = state[move.to].length;
      const cleared = applyMoveInPlace(state, capacity, move);
      path.push(move);

      if (dfs(depth + 1)) return true;

      path.pop();
      // 手工回滚：出栏过就要把整栏填回去
      if (cleared !== null) {
        const pen = state[move.to];
        for (let i = 0; i < capacity; i++) pen.push(cleared);
      }
      const src = state[move.from];
      const dest = state[move.to];
      while (dest.length > destBefore) src.push(dest.pop()!);
    }
    return false;
  };

  const ok = dfs(0);
  if (!ok) return exhausted ? { moves: [], nodes, exhausted: true } : null;
  return { moves: path.slice(), nodes, exhausted: false };
}

/**
 * 启发式：好手在前。
 *
 * 1. 这一步就能出栏 —— 直接释放一个栏位，几乎总是对的
 * 2. 把一群羊合并到同品种的栏上 —— 减少碎片
 * 3. 搬空一整栏 —— 也是在释放栏位
 * 4. 往空栏丢 —— 消耗宝贵的缓冲区，放最后
 */
function orderMoves(pens: Pens, capacity: number): Move[] {
  const moves = legalMoves(pens, capacity);
  const scored = moves.map((m) => {
    const dest = pens[m.to];
    const src = pens[m.from];
    const run = topRun(src)!;
    let score = 0;

    if (dest.length + m.count === capacity && (dest.length === 0 || dest[0] === run.breed)) {
      // 落下即满栏同品种 → 出栏
      let uniform = true;
      for (const b of dest) if (b !== run.breed) uniform = false;
      if (uniform) score += 1000;
    }
    if (dest.length > 0) score += 100; // 合并到已有同品种
    if (m.count === src.length) score += 50; // 搬空这一栏
    if (dest.length === 0) score -= 80; // 占用空栏，代价高
    score += m.count * 5; // 一次多搬几只更高效

    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.m);
}

/** 局面是否有解。生成器和道具校验都用它。 */
export function isSolvable(pens: Pens, capacity: number, budget = DEFAULT_BUDGET): boolean {
  const r = solve(pens, capacity, { budget });
  return r !== null && !r.exhausted;
}

/**
 * 死局判定：一步都走不动。
 *
 * 注意这和「无解」是两件事 —— 还能动但怎么动都赢不了，也是输，
 * 只是玩家还没走到头。UI 应该在检测到无解时主动提示玩家用道具，
 * 而不是让他白白多点十几下才发现完了。
 */
export function isDeadlocked(pens: Pens, capacity: number): boolean {
  return legalMoves(pens, capacity).length === 0;
}
