import type { DeckLayout, Tile } from './types.ts';
import type { Rng } from './rng.ts';

/**
 * 牌堆几何结构生成 —— 只决定「牌摆在哪、谁压着谁」，不决定花色。
 * 花色由 solvable.ts 在这个结构之上分配，从而保证一定有解。
 *
 * 坐标系：一张牌占 2×2 个单位格。同层落点按步长 2 取，
 * 层与层之间用 offsetX/offsetY 制造错位，形成交错遮挡。
 */

/** 两张牌是否在平面上重叠（不看层号）。 */
function overlaps(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) < 2 && Math.abs(ay - by) < 2;
}

interface RawTile {
  layer: number;
  x: number;
  y: number;
}

/**
 * 生成裸几何结构。返回的牌数会被调整成 3 的倍数（多退少补，从最上层动手）。
 */
export function buildGeometry(layout: DeckLayout, rng: Rng): Tile[] {
  const raw: RawTile[] = [];

  for (let li = 0; li < layout.layers.length; li++) {
    const spec = layout.layers[li];
    const candidates: RawTile[] = [];
    for (let y = 0; y + 2 <= spec.height; y += 2) {
      for (let x = 0; x + 2 <= spec.width; x += 2) {
        candidates.push({ layer: li, x: x + spec.offsetX, y: y + spec.offsetY });
      }
    }
    const picked = rng.shuffle(candidates).slice(0, Math.min(spec.count, candidates.length));
    raw.push(...picked);
  }

  // 底部牌河：每垛在同一 (x, y) 上竖直叠 depth 张，天然形成严格的先后顺序。
  if (layout.river && layout.river.stacks > 0 && layout.river.depth > 0) {
    const baseLayer = layout.layers.length;
    const riverY = maxY(raw) + 4;
    for (let s = 0; s < layout.river.stacks; s++) {
      for (let d = 0; d < layout.river.depth; d++) {
        raw.push({ layer: baseLayer + d, x: s * 2, y: riverY });
      }
    }
  }

  const adjusted = forceMultipleOfThree(raw, rng);
  return linkOcclusion(adjusted);
}

function maxY(raw: RawTile[]): number {
  let m = 0;
  for (const t of raw) m = Math.max(m, t.y);
  return m;
}

/**
 * 牌数必须是 3 的倍数。多出来的从最高层删（删最高层不会破坏下层的可达性），
 * 不够就往最高层的空位补。
 */
function forceMultipleOfThree(raw: RawTile[], rng: Rng): RawTile[] {
  const extra = raw.length % 3;
  if (extra === 0) return raw;

  const sorted = raw.slice().sort((a, b) => b.layer - a.layer);
  const topLayer = sorted[0].layer;
  const topIdx: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].layer === topLayer) topIdx.push(i);
  }

  if (topIdx.length >= extra) {
    const drop = new Set(rng.shuffle(topIdx).slice(0, extra));
    return raw.filter((_, i) => !drop.has(i));
  }
  // 兜底：最高层牌数不够删，就从全局随机删。
  const drop = new Set(rng.shuffle(raw.map((_, i) => i)).slice(0, extra));
  return raw.filter((_, i) => !drop.has(i));
}

/** 建立遮挡关系：高层牌压住所有与之平面重叠的低层牌。 */
function linkOcclusion(raw: RawTile[]): Tile[] {
  const tiles: Tile[] = raw.map((t, i) => ({
    id: i,
    icon: -1,
    group: -1,
    layer: t.layer,
    x: t.x,
    y: t.y,
    coveredBy: [],
    covers: [],
    state: 'stack',
  }));

  for (let i = 0; i < tiles.length; i++) {
    for (let j = 0; j < tiles.length; j++) {
      if (i === j) continue;
      const a = tiles[i];
      const b = tiles[j];
      if (a.layer > b.layer && overlaps(a.x, a.y, b.x, b.y)) {
        a.covers.push(b.id);
        b.coveredBy.push(a.id);
      }
    }
  }
  return tiles;
}

/**
 * 一张牌当前是否可点：所有压住它的牌都已经离开牌堆。
 */
export function isFree(tile: Tile, byId: Map<number, Tile>): boolean {
  if (tile.state !== 'stack') return false;
  for (const cid of tile.coveredBy) {
    const c = byId.get(cid);
    if (c && c.state === 'stack') return false;
  }
  return true;
}

/**
 * 拓扑序：反复从「当前可点」的牌里随机挑一张取走，直到取空。
 * 因为遮挡关系是按层号严格定向的（高层 → 低层），这个 DAG 一定无环，
 * 所以一定能取完，得到一条合法的取牌顺序。
 *
 * `tiles` 可以只是牌堆的一个子集（洗牌道具只重排剩余牌），
 * 此时不在子集里的遮挡者视为已经离场，不计入入度。
 */
export function topologicalOrder(tiles: Tile[], rng: Rng): number[] {
  const present = new Set(tiles.map((t) => t.id));
  const pending = new Map<number, number>();
  for (const t of tiles) {
    let deg = 0;
    for (const cid of t.coveredBy) if (present.has(cid)) deg++;
    pending.set(t.id, deg);
  }

  let frontier = tiles.filter((t) => (pending.get(t.id) ?? 0) === 0).map((t) => t.id);
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const order: number[] = [];

  while (frontier.length > 0) {
    const k = rng.int(frontier.length);
    const id = frontier[k];
    frontier[k] = frontier[frontier.length - 1];
    frontier.pop();
    order.push(id);

    const tile = byId.get(id);
    if (!tile) continue;
    for (const belowId of tile.covers) {
      if (!present.has(belowId)) continue;
      const left = (pending.get(belowId) ?? 0) - 1;
      pending.set(belowId, left);
      if (left === 0) frontier.push(belowId);
    }
  }

  if (order.length !== tiles.length) {
    throw new Error(`遮挡关系成环，拓扑排序失败：${order.length}/${tiles.length}`);
  }
  return order;
}
