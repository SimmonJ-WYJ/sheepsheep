import type {
  GameSnapshot,
  GameStatus,
  IconId,
  ItemKind,
  LevelConfig,
  Tile,
} from './types.ts';
import type { Rng } from './rng.ts';
import { isFree, topologicalOrder } from './geometry.ts';
import { buildDeck } from './deck.ts';
import { assignGroups, emptyHand, mapGroupsToIcons } from './solvable.ts';
import type { HandState } from './solvable.ts';

export type PickResult =
  | { ok: false; reason: 'not-free' | 'not-playing' | 'no-such-tile' }
  | { ok: true; cleared: Tile[]; status: GameStatus; combo: number; gained: number };

export interface GameOptions {
  level: LevelConfig;
  rng: Rng;
  /** 注入时钟，方便测试与录像回放。 */
  now?: () => number;
  /** 连击窗口（毫秒）：两次消除间隔小于它就累加连击。 */
  comboWindowMs?: number;
  /**
   * 复活后是否重新生成剩余牌面，使其重新「保证有解」。
   * 默认开启 —— 玩家看完广告换来的应该是一个真能打通的局，而不是另一个死局。
   */
  reguaranteeAfterRevive?: boolean;
}

interface HistoryEntry {
  tileId: number;
  clearedIds: number[];
  prevSlot: number[];
  prevScore: number;
  prevCombo: number;
  prevLastClearAt: number;
}

const DEFAULT_COMBO_WINDOW_MS = 3000;

export class SheepGame {
  readonly level: LevelConfig;
  readonly tiles: Tile[];

  /**
   * 当前这盘的通关路径（牌 id 序列），供「提示」和自动演示使用。
   * 洗牌 / 复活重算牌面之后会被替换成新的路径。
   */
  private path: number[];
  get solution(): number[] {
    return this.path;
  }

  private readonly byId: Map<number, Tile>;
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly comboWindowMs: number;
  private readonly reguaranteeAfterRevive: boolean;

  private slotIds: number[] = [];
  private history: HistoryEntry[] = [];
  private wildOverride = new Map<number, IconId>();
  private itemsLeft = new Map<ItemKind, number>();
  private revealed = new Set<number>();

  status: GameStatus = 'playing';
  score = 0;
  combo = 0;
  slotCapacity: number;
  private lastClearAt = -Infinity;
  private startedAt: number;

  constructor(opts: GameOptions) {
    this.level = opts.level;
    this.rng = opts.rng;
    this.now = opts.now ?? (() => Date.now());
    this.comboWindowMs = opts.comboWindowMs ?? DEFAULT_COMBO_WINDOW_MS;
    this.reguaranteeAfterRevive = opts.reguaranteeAfterRevive ?? true;
    this.slotCapacity = opts.level.slotCapacity;

    const deck = buildDeck(opts.level, opts.rng);
    this.tiles = deck.tiles;
    this.path = deck.solution;
    this.byId = new Map(this.tiles.map((t) => [t.id, t]));

    for (const [kind, n] of Object.entries(opts.level.freeItems)) {
      this.itemsLeft.set(kind as ItemKind, n ?? 0);
    }
    this.startedAt = this.now();
  }

  // ---------------------------------------------------------------- 查询

  get slot(): Tile[] {
    return this.slotIds.map((id) => this.byId.get(id)!).filter(Boolean);
  }

  get remaining(): number {
    let n = 0;
    for (const t of this.tiles) if (t.state === 'stack') n++;
    return n;
  }

  get clearedCount(): number {
    let n = 0;
    for (const t of this.tiles) if (t.state === 'cleared') n++;
    return n;
  }

  /** 一张牌当前能不能点。 */
  canPick(id: number): boolean {
    const t = this.byId.get(id);
    return !!t && isFree(t, this.byId);
  }

  freeTiles(): Tile[] {
    return this.tiles.filter((t) => isFree(t, this.byId));
  }

  /** 生效图标：万能牌可被玩家改写，默认用它自己的原始图标。 */
  effectiveIcon(t: Tile): IconId {
    return this.wildOverride.get(t.id) ?? t.icon;
  }

  itemCount(kind: ItemKind): number {
    return this.itemsLeft.get(kind) ?? 0;
  }

  isRevealed(id: number): boolean {
    return this.revealed.has(id);
  }

  elapsedSec(): number {
    return (this.now() - this.startedAt) / 1000;
  }

  timeLeftSec(): number {
    if (this.level.timeLimitSec <= 0) return Infinity;
    return Math.max(0, this.level.timeLimitSec - this.elapsedSec());
  }

  snapshot(): GameSnapshot {
    return {
      status: this.status,
      slot: this.slot,
      slotCapacity: this.slotCapacity,
      remaining: this.remaining,
      cleared: this.clearedCount,
      combo: this.combo,
      score: this.score,
    };
  }

  // ---------------------------------------------------------------- 操作

  /** 点一张牌，进卡槽。三张同图标自动消除。 */
  pick(id: number): PickResult {
    if (this.status !== 'playing') return { ok: false, reason: 'not-playing' };
    const tile = this.byId.get(id);
    if (!tile) return { ok: false, reason: 'no-such-tile' };
    if (!isFree(tile, this.byId)) return { ok: false, reason: 'not-free' };

    const entry: HistoryEntry = {
      tileId: id,
      clearedIds: [],
      prevSlot: this.slotIds.slice(),
      prevScore: this.score,
      prevCombo: this.combo,
      prevLastClearAt: this.lastClearAt,
    };

    tile.state = 'slot';
    this.slotIds.push(id);
    // 同图标聚拢，和《羊了个羊》一致：视觉上更容易数清楚还差几张。
    this.sortSlot();

    const cleared = this.resolveClears();
    entry.clearedIds = cleared.map((t) => t.id);
    this.history.push(entry);

    let gained = 0;
    if (cleared.length > 0) {
      gained = this.awardScore();
    } else if (this.slotIds.length >= this.slotCapacity) {
      this.status = 'lost';
    }

    if (this.remaining === 0 && this.slotIds.length === 0) {
      this.status = 'won';
    }

    return { ok: true, cleared, status: this.status, combo: this.combo, gained };
  }

  /** 给卡槽里的万能牌指定一个图标。 */
  designateWild(tileId: number, icon: IconId): boolean {
    const t = this.byId.get(tileId);
    if (!t || t.special !== 'wild' || t.state !== 'slot') return false;
    this.wildOverride.set(tileId, icon);
    this.sortSlot();
    const cleared = this.resolveClears();
    if (cleared.length > 0) this.awardScore();
    if (this.remaining === 0 && this.slotIds.length === 0) this.status = 'won';
    return true;
  }

  /**
   * 提示：沿当前通关路径给出下一张该点的牌。
   * 玩家偏离这条路径之后返回 null —— 此时 UI 应当引导玩家用「洗牌」，
   * 洗牌会重算一条新路径，提示随之恢复可用。
   */
  hint(): Tile | null {
    for (const id of this.path) {
      const t = this.byId.get(id);
      if (t && t.state === 'stack') {
        return isFree(t, this.byId) ? t : null;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- 道具

  /**
   * 这个道具当前用下去有没有实际效果。
   *
   * 必须在「弹看广告」之前查一次：让玩家看完 30 秒广告，
   * 换来一个点下去什么都没发生的道具，是最直接的差评来源。
   */
  canUseItem(kind: ItemKind): boolean {
    if (this.status !== 'playing') return false;
    if (kind === 'undo') return this.history.length > 0;
    if (kind === 'pop3') return this.slotIds.length > 0;
    if (kind === 'shuffle') return this.remaining > 0;
    if (kind === 'xray') {
      return this.tiles.some(
        (t) => t.state === 'stack' && !isFree(t, this.byId) && !this.revealed.has(t.id),
      );
    }
    if (kind === 'slot') return true;
    return false;
  }

  /**
   * 使用道具。库存不足返回 false —— 上层（ItemShop）负责决定
   * 是弹「看广告 +1 次」还是弹「钻石购买」。
   */
  useItem(kind: ItemKind): boolean {
    if (!this.canUseItem(kind)) return false;
    if (this.itemCount(kind) <= 0) return false;
    const ok = this.applyItem(kind);
    if (ok) this.itemsLeft.set(kind, this.itemCount(kind) - 1);
    return ok;
  }

  /** 广告/内购发放道具次数。 */
  grantItem(kind: ItemKind, n = 1): void {
    this.itemsLeft.set(kind, this.itemCount(kind) + n);
  }

  private applyItem(kind: ItemKind): boolean {
    if (kind === 'undo') return this.undo();
    if (kind === 'pop3') return this.popBack(3) > 0;
    if (kind === 'shuffle') return this.reguarantee();
    if (kind === 'xray') return this.reveal(6) > 0;
    if (kind === 'slot') {
      this.slotCapacity += 1;
      return true;
    }
    return false;
  }

  /** 撤销上一步。 */
  undo(): boolean {
    const entry = this.history.pop();
    if (!entry) return false;

    for (const cid of entry.clearedIds) {
      const t = this.byId.get(cid);
      if (t) t.state = 'slot';
    }
    const back = this.byId.get(entry.tileId);
    if (back) back.state = 'stack';

    this.slotIds = entry.prevSlot;
    this.score = entry.prevScore;
    this.combo = entry.prevCombo;
    this.lastClearAt = entry.prevLastClearAt;
    this.status = 'playing';
    return true;
  }

  /** 「移出」：把卡槽最前面的 n 张退回牌堆。返回实际退回的张数。 */
  popBack(n: number): number {
    let moved = 0;
    while (moved < n && this.slotIds.length > 0) {
      const id = this.slotIds.shift()!;
      const t = this.byId.get(id);
      if (t) {
        t.state = 'stack';
        this.wildOverride.delete(id);
      }
      moved++;
    }
    if (moved > 0) {
      this.history = []; // 退回之后不允许再撤销跨越这一步
      this.status = 'playing';
    }
    return moved;
  }

  /** 「透视」：随机点亮 n 张被压住的牌，UI 据此半透明显示下层。 */
  reveal(n: number): number {
    const hidden = this.tiles.filter(
      (t) => t.state === 'stack' && !isFree(t, this.byId) && !this.revealed.has(t.id),
    );
    const picks = this.rng.shuffle(hidden.map((t) => t.id)).slice(0, n);
    for (const id of picks) this.revealed.add(id);
    return picks.length;
  }

  /**
   * 「洗牌」：重排剩余牌堆的图标，并**重新保证有解**。
   *
   * 做法是把当前卡槽内容当作 assignGroups 的起始手牌，
   * 对剩余牌堆重新走一遍「先造解法再铺牌」的流程。
   * 因此洗牌之后一定还能通关 —— 这和《羊了个羊》的洗牌（纯随机、可能越洗越死）不同。
   */
  reguarantee(): boolean {
    if (this.status !== 'playing') return false;
    const stack = this.tiles.filter((t) => t.state === 'stack');
    if (stack.length === 0) return false;

    // 按「生效图标」把卡槽归桶，每桶就是一个还开着的组。
    const bucket = new Map<IconId, number>();
    for (const t of this.slot) {
      const ic = this.effectiveIcon(t);
      bucket.set(ic, (bucket.get(ic) ?? 0) + 1);
    }

    const hand: HandState = emptyHand();
    const groupIcon = new Map<number, IconId>();
    let gid = 0;
    for (const [icon, count] of bucket) {
      const g = gid++;
      hand.counts.set(g, count);
      hand.size += count;
      groupIcon.set(g, icon);
    }

    const order = topologicalOrder(stack, this.rng);
    const assigned = assignGroups(order.length, this.rng, {
      slotCapacity: this.slotCapacity,
      knobs: this.level.difficulty,
      initialHand: hand,
      firstGroupId: gid,
    });

    // 新开的组分配新图标；已有组沿用卡槽里的图标。
    const freshIcons = mapGroupsToIcons(
      assigned.groupCount,
      this.level.difficulty.iconCount,
      this.rng,
    );
    for (let i = 0; i < order.length; i++) {
      const t = this.byId.get(order[i]);
      if (!t) continue;
      const g = assigned.groupOf[i];
      t.group = g;
      const known = groupIcon.get(g);
      t.icon = known !== undefined ? known : (freshIcons[g - gid] ?? 0);
    }

    // 新的通关路径就是这次用的拓扑序，提示功能随之复位。
    this.path = order;
    this.history = [];
    return true;
  }

  /**
   * 复活：清掉卡槽里若干张牌，回到可玩状态。
   * 由 monetize/revive.ts 决定看一次广告给几张（递减），这里只负责执行。
   */
  revive(clearTiles: number): boolean {
    if (this.status !== 'lost') return false;
    this.status = 'playing';
    this.popBack(clearTiles);
    if (this.reguaranteeAfterRevive) this.reguarantee();
    return true;
  }

  /** 限时关卡由外部循环调用。 */
  tickTimeout(): void {
    if (this.status === 'playing' && this.level.timeLimitSec > 0 && this.timeLeftSec() <= 0) {
      this.status = 'lost';
    }
  }

  // ---------------------------------------------------------------- 内部

  private sortSlot(): void {
    const rank = new Map<IconId, number>();
    let next = 0;
    for (const id of this.slotIds) {
      const t = this.byId.get(id);
      if (!t) continue;
      const ic = this.effectiveIcon(t);
      if (!rank.has(ic)) rank.set(ic, next++);
    }
    this.slotIds.sort((a, b) => {
      const ta = this.byId.get(a);
      const tb = this.byId.get(b);
      if (!ta || !tb) return 0;
      return (rank.get(this.effectiveIcon(ta)) ?? 0) - (rank.get(this.effectiveIcon(tb)) ?? 0);
    });
  }

  /** 反复消除，直到卡槽里没有任何 3 张同图标。 */
  private resolveClears(): Tile[] {
    const clearedAll: Tile[] = [];
    for (;;) {
      const byIcon = new Map<IconId, number[]>();
      for (const id of this.slotIds) {
        const t = this.byId.get(id);
        if (!t) continue;
        const ic = this.effectiveIcon(t);
        const arr = byIcon.get(ic);
        if (arr) arr.push(id);
        else byIcon.set(ic, [id]);
      }

      let hit: number[] | null = null;
      for (const ids of byIcon.values()) {
        if (ids.length >= 3) {
          hit = ids.slice(0, 3);
          break;
        }
      }
      if (!hit) break;

      const hitSet = new Set(hit);
      this.slotIds = this.slotIds.filter((id) => !hitSet.has(id));
      for (const id of hit) {
        const t = this.byId.get(id);
        if (t) {
          t.state = 'cleared';
          this.wildOverride.delete(id);
          clearedAll.push(t);
        }
      }
    }
    return clearedAll;
  }

  private awardScore(): number {
    const t = this.now();
    this.combo = t - this.lastClearAt <= this.comboWindowMs ? this.combo + 1 : 1;
    this.lastClearAt = t;
    // 连击加成封顶 5 倍，避免长尾滚雪球把排行榜打崩。
    const mult = Math.min(5, 1 + (this.combo - 1) * 0.5);
    const gained = Math.round(100 * mult);
    this.score += gained;
    return gained;
  }
}
