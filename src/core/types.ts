/**
 * 核心数据结构。这一层完全不依赖渲染和平台 SDK，
 * 可以在 Node / 浏览器 / 抖音小游戏运行时里原样跑。
 */

/** 图标 id。三张相同 icon 即可消除。 */
export type IconId = number;

/**
 * 组 id。生成器内部用「组」来证明可解性（每组恰好 3 张牌），
 * 但玩家看到的是 icon —— 多个组可以复用同一个 icon（见 deck.ts 的说明）。
 */
export type GroupId = number;

export type TileState = 'stack' | 'slot' | 'cleared';

/** 特殊牌。当前引擎只实现 wild（可证明不破坏可解性），其余见 docs/02。 */
export type SpecialKind = 'wild';

export interface Tile {
  id: number;
  icon: IconId;
  group: GroupId;
  /** 层号，越大越靠上，越靠上越先可点。 */
  layer: number;
  /** 左上角坐标，单位是「半张牌」。一张牌占 2×2。 */
  x: number;
  y: number;
  /** 压在这张牌上面的牌 id（这些牌全部移走后，本牌才可点）。 */
  coveredBy: number[];
  /** 本牌压住的牌 id。 */
  covers: number[];
  state: TileState;
  special?: SpecialKind;
}

export interface LayerSpec {
  /** 该层可用的横向格数（单位：半张牌），实际落点按 2 取步长。 */
  width: number;
  height: number;
  /** 该层放几张牌。 */
  count: number;
  /** 相对基准原点的偏移，用于制造层与层之间的错位遮挡。 */
  offsetX: number;
  offsetY: number;
}

/** 底部「牌河」：若干条竖直堆叠的牌垛，只有最上面一张可点。 */
export interface RiverSpec {
  stacks: number;
  depth: number;
}

export interface DeckLayout {
  layers: LayerSpec[];
  river?: RiverSpec;
}

export interface DifficultyKnobs {
  /**
   * 允许同时「开着」的组数上限。越大越难（卡槽压力越大）。
   * 引擎会强制 clamp 到 slotCapacity - 1，这是可解性证明的前提，见 solvable.ts。
   */
  maxOpenGroups: number;
  /** 生成解法路径时，三类动作的权重：开新组 / 补到 2 张 / 凑齐消除。 */
  weightNewGroup: number;
  weightGrow: number;
  weightComplete: number;
  /** 图标种类数。种类越少，越容易「意外提前消除」，越简单。 */
  iconCount: number;
  /** 万能牌数量。 */
  wildCount: number;
}

export interface LevelConfig {
  id: number;
  name: string;
  layout: DeckLayout;
  difficulty: DifficultyKnobs;
  /** 卡槽格数，经典玩法是 7。 */
  slotCapacity: number;
  /** 限时（秒）。0 表示不限时。 */
  timeLimitSec: number;
  /** 每种道具的免费次数。 */
  freeItems: Partial<Record<ItemKind, number>>;
}

export type ItemKind = 'undo' | 'pop3' | 'shuffle' | 'xray' | 'slot';

export type GameStatus = 'playing' | 'won' | 'lost';

export interface GameSnapshot {
  status: GameStatus;
  slot: Tile[];
  slotCapacity: number;
  remaining: number;
  cleared: number;
  combo: number;
  score: number;
}
