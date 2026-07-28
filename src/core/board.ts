import type { Breed, Move, Pens } from './types.ts';

/**
 * 棋盘规则层：纯函数，不持有状态。
 *
 * 单独抽出来是为了让 solver 能高速地在状态空间里搜索 ——
 * solver 每秒要跑几十万次 applyMove，任何对象分配都很贵。
 */

export function clonePens(pens: Pens): Pens {
  const out: Pens = new Array(pens.length);
  for (let i = 0; i < pens.length; i++) out[i] = pens[i].slice();
  return out;
}

/** 栏口连续同品种的一群羊。空栏返回 null。 */
export function topRun(pen: Breed[]): { breed: Breed; count: number } | null {
  if (pen.length === 0) return null;
  const breed = pen[pen.length - 1];
  let count = 1;
  for (let i = pen.length - 2; i >= 0 && pen[i] === breed; i--) count++;
  return { breed, count };
}

/**
 * 当前所有合法移动。
 *
 * 做了两处剪枝，对 solver 的速度影响很大：
 *  - 多个空栏位是等价的，只考虑第一个
 *  - 「把整栏同品种的羊搬到另一个空栏」是纯粹的原地打转，直接排除
 */
export function legalMoves(pens: Pens, capacity: number): Move[] {
  const moves: Move[] = [];
  let firstEmpty = -1;
  for (let i = 0; i < pens.length; i++) {
    if (pens[i].length === 0) {
      firstEmpty = i;
      break;
    }
  }

  for (let from = 0; from < pens.length; from++) {
    const run = topRun(pens[from]);
    if (!run) continue;
    // 整栏都是同一品种：搬到空栏没有任何意义
    const wholePen = run.count === pens[from].length;

    for (let to = 0; to < pens.length; to++) {
      if (to === from) continue;
      const dest = pens[to];
      if (dest.length === 0) {
        if (to !== firstEmpty) continue; // 空栏等价，只留一个
        if (wholePen) continue; // 原地打转
      } else if (dest[dest.length - 1] !== run.breed) {
        continue;
      }
      const space = capacity - dest.length;
      if (space <= 0) continue;
      const count = Math.min(run.count, space);
      moves.push({ from, to, count });
    }
  }
  return moves;
}

export function isLegal(pens: Pens, capacity: number, move: Move): boolean {
  if (move.from === move.to) return false;
  const src = pens[move.from];
  const dest = pens[move.to];
  if (!src || !dest || src.length === 0) return false;
  const run = topRun(src);
  if (!run || move.count < 1 || move.count > run.count) return false;
  if (dest.length + move.count > capacity) return false;
  if (dest.length > 0 && dest[dest.length - 1] !== run.breed) return false;
  return true;
}

/**
 * 就地执行一次移动，并处理出栏。
 *
 * @returns 出栏的品种（没有出栏则为 null）。就地修改 `pens`。
 */
export function applyMoveInPlace(pens: Pens, capacity: number, move: Move): Breed | null {
  const src = pens[move.from];
  const dest = pens[move.to];
  for (let i = 0; i < move.count; i++) dest.push(src.pop()!);

  // 集满一栏同品种 → 整栏出栏
  if (dest.length === capacity) {
    const b = dest[0];
    let uniform = true;
    for (let i = 1; i < dest.length; i++) {
      if (dest[i] !== b) {
        uniform = false;
        break;
      }
    }
    if (uniform) {
      dest.length = 0;
      return b;
    }
  }
  return null;
}

export function isWon(pens: Pens): boolean {
  for (const p of pens) if (p.length > 0) return false;
  return true;
}

export function countSheep(pens: Pens): number {
  let n = 0;
  for (const p of pens) n += p.length;
  return n;
}

/**
 * 状态的规范化指纹，用于 solver 的去重。
 *
 * 栏位之间是**可互换**的（第 3 栏和第 5 栏没有区别），所以排序之后再拼。
 * 不这么做的话，同一个局面会被当成几十种不同状态反复搜索。
 */
export function canonicalKey(pens: Pens): string {
  const parts: string[] = new Array(pens.length);
  for (let i = 0; i < pens.length; i++) parts[i] = pens[i].join(',');
  parts.sort();
  return parts.join('|');
}
