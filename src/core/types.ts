/**
 * 《羊群大整理》核心数据结构。
 *
 * 玩法：有限个栏位，每个栏位能站 C 只羊。把混在一起的羊按品种归到一起，
 * 一栏集满同品种 C 只 → 整栏出栏（羊跑走），栏位空出来接着用。
 * 全部羊出栏即通关；一步都走不动即失败。
 *
 * 这一层完全不依赖渲染和平台 SDK，Node / 浏览器 / 抖音小游戏都能原样跑。
 */

/** 品种 id（决定羊的颜色和外观）。同品种才能叠在一起。 */
export type Breed = number;

/**
 * 栏位状态。`pens[i]` 是第 i 个栏位，数组下标 0 是**栏底**，末尾是**栏口**。
 * 只有栏口的羊能被赶走 —— 这就是全部的信息约束，没有暗牌。
 */
export type Pens = Breed[][];

/**
 * 一次移动：把 `from` 栏口连续同品种的 `count` 只羊赶到 `to` 栏。
 * 允许一次赶一群，是这个品类的标准操作，也大幅降低了操作次数。
 */
export interface Move {
  from: number;
  to: number;
  count: number;
}

export type ItemKind =
  /** 撤销一步 */
  | 'undo'
  /** 临时加一个空栏位 */
  | 'addPen'
  /** 提示下一步（由 solver 算出） */
  | 'hint'
  /** 牧羊犬叼走 1 只羊。只在「叼走之后依然有解」时可用 */
  | 'dog'
  /** 重排剩余的羊，换一个保证有解的新局面 */
  | 'sort';

export type GameStatus = 'playing' | 'won' | 'lost';

export interface DifficultyKnobs {
  /** 品种数。每个品种恰好 C 只羊（C = 栏位容量）。 */
  breedCount: number;
  /** 空栏位数量 = 缓冲区大小。**这是最有效的难度旋钮**，越少越难。 */
  emptyPens: number;
  /**
   * 生成时容许的最小解法步数。越大越需要提前规划。
   * 生成器会重抽直到满足（或用尽尝试次数）。
   */
  minSolutionLength: number;
}

export interface LevelConfig {
  id: number;
  name: string;
  /** 每个栏位站几只羊。经典配置是 4。 */
  penCapacity: number;
  difficulty: DifficultyKnobs;
  /** 限时（秒）。0 表示不限时。 */
  timeLimitSec: number;
  /** 每种道具的免费次数。 */
  freeItems: Partial<Record<ItemKind, number>>;
}

export interface GameSnapshot {
  status: GameStatus;
  pens: Pens;
  penCapacity: number;
  /** 场上还剩几只羊 */
  remaining: number;
  /** 已经出栏几只 */
  shipped: number;
  combo: number;
  score: number;
  moves: number;
}
