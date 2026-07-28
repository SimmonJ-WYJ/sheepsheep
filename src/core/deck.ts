import type { LevelConfig, Tile } from './types.ts';
import type { Rng } from './rng.ts';
import { buildGeometry, topologicalOrder } from './geometry.ts';
import { assignGroups, mapGroupsToIcons } from './solvable.ts';

export interface Deck {
  tiles: Tile[];
  /** 生成时用的那条通关路径（牌 id 序列）。用于「提示」道具和自动演示。 */
  solution: number[];
  peakSlotUsage: number;
  groupCount: number;
}

/**
 * 造一副保证有解的牌。
 *
 * 流程：几何结构 → 拓扑序（一条合法取牌顺序）→ 沿序分配组 → 组映射成图标。
 */
export function buildDeck(level: LevelConfig, rng: Rng): Deck {
  const tiles = buildGeometry(level.layout, rng);
  const order = topologicalOrder(tiles, rng);

  const assigned = assignGroups(order.length, rng, {
    slotCapacity: level.slotCapacity,
    knobs: level.difficulty,
  });

  const iconTable = mapGroupsToIcons(assigned.groupCount, level.difficulty.iconCount, rng);
  const byId = new Map(tiles.map((t) => [t.id, t]));

  for (let i = 0; i < order.length; i++) {
    const tile = byId.get(order[i]);
    if (!tile) continue;
    tile.group = assigned.groupOf[i];
    tile.icon = iconTable[tile.group] ?? 0;
  }

  applyWilds(tiles, level.difficulty.wildCount, rng);

  return {
    tiles,
    solution: order,
    peakSlotUsage: assigned.peakSlotUsage,
    groupCount: assigned.groupCount,
  };
}

/**
 * 万能牌：可以顶替任意图标。
 * 把一张普通牌换成万能牌，只会放宽约束 —— 原来的通关路径把它当原图标用即可，
 * 所以可解性不受影响。
 */
function applyWilds(tiles: Tile[], wildCount: number, rng: Rng): void {
  if (wildCount <= 0) return;
  const picks = rng.shuffle(tiles.map((t) => t.id)).slice(0, Math.min(wildCount, tiles.length));
  const byId = new Map(tiles.map((t) => [t.id, t]));
  for (const id of picks) {
    const t = byId.get(id);
    if (t) t.special = 'wild';
  }
}
