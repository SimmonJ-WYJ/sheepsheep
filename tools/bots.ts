import type { Move, Pens } from '../src/core/types.ts';
import type { Rng } from '../src/core/rng.ts';
import { applyMoveInPlace, canonicalKey, clonePens, legalMoves, topRun } from '../src/core/board.ts';

/**
 * 模拟玩家的三档机器人。
 *
 * 这些不是游戏的一部分，只服务于 `tools/balance.ts` 的难度体检。
 * 关键要求是**三档之间必须真的有水平差距** ——
 * 如果 greedy 和 planner 打出一样的通过率，那这张表就什么都说明不了。
 */

export type Bot = 'random' | 'greedy' | 'planner';

/**
 * 局面评分（越大越好）。planner 靠它做一步预判。
 *
 * 三个真正重要的因素：
 *   - 空栏位是硬通货，缺一个就少一条活路
 *   - 同品种聚在一起（纯栏）是进度
 *   - 「被压住」的羊是债务：一只羊上面压着别的品种，就得先把上面搬走
 */
export function evalBoard(pens: Pens, capacity: number): number {
  let score = 0;
  for (const pen of pens) {
    if (pen.length === 0) {
      score += 34; // 空栏位
      continue;
    }
    let changes = 0;
    for (let i = 1; i < pen.length; i++) if (pen[i] !== pen[i - 1]) changes++;
    // 纯栏（只有一种品种）
    if (changes === 0) score += 18 + pen.length * 4;
    else score -= changes * 22;

    // 被压住的羊：上面存在不同品种
    let buried = 0;
    for (let i = 0; i < pen.length - 1; i++) {
      for (let j = i + 1; j < pen.length; j++) {
        if (pen[j] !== pen[i]) {
          buried++;
          break;
        }
      }
    }
    score -= buried * 7;
    // 快满但不纯的栏最难处理
    if (changes > 0 && pen.length === capacity) score -= 30;
  }
  return score;
}

/** 只看眼前一步的打分，不做预判。 */
function shallowScore(pens: Pens, capacity: number, m: Move): number {
  const src = pens[m.from];
  const dest = pens[m.to];
  const run = topRun(src);
  if (!run) return -Infinity;

  let score = 0;
  const destUniform = dest.length > 0 && dest.every((b) => b === run.breed);
  if ((dest.length === 0 || destUniform) && dest.length + m.count === capacity) score += 1000;
  if (destUniform) score += 120;
  if (m.count === src.length) score += 60;
  if (dest.length === 0) score -= 60;
  score += m.count * 6;
  return score;
}

/** 走一步之后的局面。 */
function afterMove(pens: Pens, capacity: number, m: Move): Pens {
  const next = clonePens(pens);
  applyMoveInPlace(next, capacity, m);
  return next;
}

/**
 * 返回按优劣排好序的候选步。
 * balance.ts 会依次尝试，跳过那些会走回旧局面的步（防止原地打转）。
 */
export function rankMoves(bot: Bot, pens: Pens, capacity: number, rng: Rng): Move[] {
  const moves = legalMoves(pens, capacity);
  if (moves.length === 0) return [];

  if (bot === 'random') return rng.shuffle(moves);

  if (bot === 'greedy') {
    // 只看眼前一步；同分随机打散，避免总走同一条死路
    const scored = rng.shuffle(moves).map((m) => ({ m, s: shallowScore(pens, capacity, m) }));
    scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.m);
  }

  return plannerRank(pens, capacity, rng);
}

/** 一条线的价值：先看出栏进度（羊越少越好），再看局面质量。 */
function lineValue(pens: Pens, capacity: number): number {
  return -countSheepIn(pens) * 120 + evalBoard(pens, capacity);
}

const BEAM_WIDTH = 5;
const BEAM_DEPTH = 5;

/**
 * planner：束搜索（beam search）。
 *
 * 一步预判是不够的 —— 这个品类的技巧恰恰在于**多步之后才兑现**的取舍
 * （现在占掉一个空栏位，是为了三步之后能连出两栏）。
 * 只看一步的机器人和只看眼前的 greedy 打出来的通过率几乎一样，
 * 那张表就说明不了任何问题。所以这里往下看 5 步。
 *
 * 做法：从当前局面展开一棵宽度 5、深度 5 的搜索束，
 * 记录每条线的**起手**，最后按各起手能达到的最好局面排序。
 */
function plannerRank(pens: Pens, capacity: number, rng: Rng): Move[] {
  const roots = rng.shuffle(legalMoves(pens, capacity));
  if (roots.length === 0) return [];

  interface Node {
    pens: Pens;
    rootIdx: number;
  }

  const bestByRoot = new Map<number, number>();
  let beam: Node[] = [];

  roots.forEach((m, i) => {
    const next = afterMove(pens, capacity, m);
    const v = lineValue(next, capacity);
    bestByRoot.set(i, v);
    beam.push({ pens: next, rootIdx: i });
  });

  const seen = new Set<string>(beam.map((n) => canonicalKey(n.pens)));
  beam = trim(beam, capacity);

  for (let d = 1; d < BEAM_DEPTH; d++) {
    const nextBeam: Node[] = [];
    for (const node of beam) {
      for (const m of legalMoves(node.pens, capacity)) {
        const child = afterMove(node.pens, capacity, m);
        const key = canonicalKey(child);
        if (seen.has(key)) continue;
        seen.add(key);
        const v = lineValue(child, capacity);
        const prev = bestByRoot.get(node.rootIdx) ?? -Infinity;
        if (v > prev) bestByRoot.set(node.rootIdx, v);
        nextBeam.push({ pens: child, rootIdx: node.rootIdx });
      }
    }
    if (nextBeam.length === 0) break;
    beam = trim(nextBeam, capacity);
  }

  return roots
    .map((m, i) => ({ m, s: bestByRoot.get(i) ?? -Infinity }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m);
}

function trim(nodes: { pens: Pens; rootIdx: number }[], capacity: number): typeof nodes {
  nodes.sort((a, b) => lineValue(b.pens, capacity) - lineValue(a.pens, capacity));
  return nodes.slice(0, BEAM_WIDTH);
}

function countSheepIn(pens: Pens): number {
  let n = 0;
  for (const p of pens) n += p.length;
  return n;
}

export { canonicalKey };
