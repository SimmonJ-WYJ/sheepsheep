import type { LevelConfig, Pens } from './types.ts';
import type { Rng } from './rng.ts';
import { canonicalKey, clonePens } from './board.ts';
import { solve } from './solver.ts';

/**
 * 关卡生成。
 *
 * 核心承诺：**发给玩家的每一个局面，都已经被求解器实际解出来过。**
 * 不是「大概能过」，是手上真的攥着一条解。
 *
 * 流程：
 *   1. 按品种铺满（每个品种恰好 penCapacity 只 —— 这条保证了「全部出栏」是可能的）
 *   2. 随机打散到各个栏位
 *   3. 求解器验证；不过就重抽
 *   4. 解法太短（一眼就能看穿）也重抽，见 minSolutionLength
 *   5. 试满次数还不行，就多给一个空栏位再来 —— 这一步保证生成一定会终止
 */

export interface GeneratedLevel {
  pens: Pens;
  penCapacity: number;
  /** 求解器算出的一条通关路径，长度用于难度评估。 */
  solutionLength: number;
  /** 实际使用的栏位总数（可能比配置多，见上面第 5 步）。 */
  penCount: number;
  /** 生成过程中重抽了几次，用于观察难度配置是否合理。 */
  attempts: number;
}

const MAX_ATTEMPTS = 160;

export function generateLevel(level: LevelConfig, rng: Rng): GeneratedLevel {
  const capacity = level.penCapacity;
  const { breedCount, minSolutionLength } = level.difficulty;
  let emptyPens = level.difficulty.emptyPens;

  for (let round = 0; round < 8; round++) {
    const penCount = breedCount + emptyPens;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const pens = shuffleIntoPens(breedCount, capacity, penCount, rng);

      // 打散之后可能碰巧出现「满栏同品种」，那会在开局瞬间自动出栏，
      // 白送玩家一栏，观感很怪 —— 直接重抽。
      if (hasReadyPen(pens, capacity)) continue;

      const solved = solve(pens, capacity);
      if (!solved || solved.exhausted) continue;
      if (solved.moves.length < minSolutionLength) continue;

      return {
        pens,
        penCapacity: capacity,
        solutionLength: solved.moves.length,
        penCount,
        attempts: attempt + 1,
      };
    }
    // 这个难度配置太紧，放宽一格缓冲区再试。
    emptyPens++;
  }

  throw new Error(`第 ${level.id} 关生成失败：难度配置过紧（breedCount=${breedCount}）`);
}

/** 每个品种恰好 capacity 只，整体洗牌后依次填进栏位。 */
function shuffleIntoPens(breedCount: number, capacity: number, penCount: number, rng: Rng): Pens {
  const sheep: number[] = [];
  for (let b = 0; b < breedCount; b++) {
    for (let i = 0; i < capacity; i++) sheep.push(b);
  }
  const shuffled = rng.shuffle(sheep);

  const pens: Pens = [];
  for (let i = 0; i < penCount; i++) pens.push([]);
  // 前 breedCount 个栏位装满，其余留空作为缓冲区
  let k = 0;
  for (let i = 0; i < breedCount; i++) {
    for (let j = 0; j < capacity; j++) pens[i].push(shuffled[k++]);
  }
  return pens;
}

function hasReadyPen(pens: Pens, capacity: number): boolean {
  for (const pen of pens) {
    if (pen.length !== capacity) continue;
    let uniform = true;
    for (let i = 1; i < pen.length; i++) {
      if (pen[i] !== pen[0]) {
        uniform = false;
        break;
      }
    }
    if (uniform) return true;
  }
  return false;
}

/**
 * 「重排」道具用：把场上剩下的羊重新打散成一个**保证有解**的新局面。
 *
 * 和生成新关卡的区别是它必须沿用当前的羊群构成（不能凭空变出羊），
 * 以及栏位数不变。
 *
 * 这是对《羊了个羊》洗牌道具的直接回答 —— 那个是纯随机的，可能越洗越死。
 */
export function reshuffleSolvable(pens: Pens, capacity: number, rng: Rng): Pens | null {
  const sheep: number[] = [];
  for (const pen of pens) for (const b of pen) sheep.push(b);
  if (sheep.length === 0) return null;

  const penCount = pens.length;
  const original = canonicalKey(pens);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const shuffled = rng.shuffle(sheep);
    const next: Pens = [];
    for (let i = 0; i < penCount; i++) next.push([]);

    // 从头依次装，装满一栏换下一栏，末尾自然留出空栏
    let pen = 0;
    for (const b of shuffled) {
      if (next[pen].length >= capacity) pen++;
      if (pen >= penCount) break;
      next[pen].push(b);
    }

    // 洗出来和原来一样就没意义
    if (canonicalKey(next) === original) continue;
    if (hasReadyPen(next, capacity)) continue;

    const solved = solve(next, capacity);
    if (solved && !solved.exhausted) return next;
  }
  return null;
}

/**
 * 给局面加 n 个空栏位。复活和「加栏」道具都走这里。
 * 加空栏位只会放宽约束，所以原本有解的局面加完一定还有解。
 */
export function withExtraPens(pens: Pens, n: number): Pens {
  const next = clonePens(pens);
  for (let i = 0; i < n; i++) next.push([]);
  return next;
}
