import type { LevelConfig } from './types.ts';

/**
 * 难度曲线。
 *
 * 《羊了个羊》只有两关：第 1 关幼儿园，第 2 关通过率 <0.1%。
 * 落差本身是它的传播引擎，但代价是没有中段 —— 玩家在第 2 关卡死后就流失了，
 * 没有任何「我在变强」的反馈。
 *
 * 这里铺一条连续曲线，把那个落差保留下来，但只放在特定位置（SPIKE_LEVELS），
 * 让它成为「话题关」而不是「劝退墙」。
 *
 * 三个旋钮，按有效性排序：
 *   emptyPens   —— 空栏位数量 = 缓冲区大小。**最有效**，从 3 个收到 1 个，难度是量级差异
 *   breedCount  —— 品种数，决定局面规模和需要同时追踪的信息量
 *   penCapacity —— 每栏容量，4 是手感最好的值，只在后期升到 5
 */

/** 尖峰关：难度显著高于邻居，用来制造「XX 关我卡了三天」的话题。 */
const SPIKE_LEVELS = new Set([10, 20, 35, 50, 66, 88]);

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

export function makeLevel(id: number): LevelConfig {
  const spike = SPIKE_LEVELS.has(id);
  // t 从 0 平滑走到 1（第 80 关封顶），尖峰关额外前移 0.22 的进度。
  const t = Math.min(1, (id - 1) / 79 + (spike ? 0.22 : 0));

  /*
   * 容量固定 4。
   * 试过后期升到 5，实测（tools/balance.ts）只是把局面拉长，并没有更有趣，
   * 而且 9 品种 × 5 只 = 45 只羊在手机竖屏上太挤，栏位画得又细又高。
   */
  const penCapacity = 4;

  // 品种数 3 → 9。用 t^0.7 让它**早期涨得快一些** ——
  // 不然第 11~19 关会是一路 100% 通过的白板（第一版就是这个毛病）。
  const breedCount = Math.round(lerp(3, 9, Math.pow(t, 0.7)));

  /*
   * 空栏位是最狠的旋钮，直接决定有多少回旋余地。
   * 分三段而不是插值 —— 这个值只有 3/2/1 三种可能，插值只会让台阶落在奇怪的地方。
   *   3 个：教学期，随便走都不会死
   *   2 个：主体区间，需要想一下
   *   1 个：后期和尖峰关，必须提前规划（普通打法通过率会掉到 20% 上下）
   */
  let emptyPens = t < 0.09 ? 3 : t < 0.62 ? 2 : 1;
  if (spike) emptyPens = 1;

  // 要求生成的解法不能太短，否则一眼就看穿了，没有解谜感。
  const minSolutionLength = Math.round(lerp(4, 26, t));

  // 限时从第 30 关进场，且给得宽松 —— 这个品类的乐趣在思考，
  // 时间压力只用来给后期加一点紧张感，不该成为主要失败原因。
  const timeLimitSec = id >= 30 ? Math.round(lerp(300, 180, (id - 30) / 50)) : 0;

  return {
    id,
    name: spike ? `第 ${id} 关 · 尖峰` : `第 ${id} 关`,
    penCapacity,
    timeLimitSec,
    difficulty: { breedCount, emptyPens, minSolutionLength },
    freeItems: {
      // 前 5 关道具管够，先把使用习惯养出来，之后再收紧、由广告补给
      undo: id <= 5 ? 5 : 1,
      addPen: id <= 5 ? 2 : 0,
      hint: id <= 5 ? 3 : 1,
      sort: id <= 5 ? 2 : 1,
      dog: 0,
    },
  };
}

/** 每日挑战：全服同一副局面，用日期做 seed。 */
export function makeDailyLevel(dateKey: string): LevelConfig {
  const level = makeLevel(45);
  return { ...level, id: -1, name: `每日挑战 · ${dateKey}`, timeLimitSec: 240 };
}
