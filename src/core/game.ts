import type {
  Breed,
  GameSnapshot,
  GameStatus,
  ItemKind,
  LevelConfig,
  Move,
  Pens,
} from './types.ts';
import type { Rng } from './rng.ts';
import {
  applyMoveInPlace,
  clonePens,
  countSheep,
  isLegal,
  isWon,
  legalMoves,
  topRun,
} from './board.ts';
import { isDeadlocked, solve } from './solver.ts';
import { generateLevel, reshuffleSolvable } from './generator.ts';

export type MoveResult =
  | { ok: false; reason: 'illegal' | 'not-playing' }
  | { ok: true; shipped: Breed | null; status: GameStatus; combo: number; gained: number };

export interface GameOptions {
  level: LevelConfig;
  rng: Rng;
  now?: () => number;
  comboWindowMs?: number;
  /**
   * 复活后是否确保局面仍然有解。默认开启 ——
   * 玩家看完广告换来的必须是一个真能打通的局面。
   */
  reguaranteeAfterRevive?: boolean;
}

interface HistoryEntry {
  pens: Pens;
  score: number;
  combo: number;
  lastShipAt: number;
  status: GameStatus;
}

const DEFAULT_COMBO_WINDOW_MS = 4000;
/** 局内实时判定用的搜索预算，比生成期小得多，避免卡住主线程。 */
const RUNTIME_BUDGET = 60_000;

export class SortGame {
  readonly level: LevelConfig;
  readonly penCapacity: number;
  /** 生成期算出的解法长度，用于难度体检和评星。 */
  readonly parMoves: number;

  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly comboWindowMs: number;
  private readonly reguaranteeAfterRevive: boolean;

  pens: Pens;
  status: GameStatus = 'playing';
  score = 0;
  combo = 0;
  moves = 0;

  private totalSheep: number;
  private history: HistoryEntry[] = [];
  private itemsLeft = new Map<ItemKind, number>();
  private lastShipAt = -Infinity;
  private startedAt: number;
  /**
   * 当前正在跟随的一条通关计划。
   *
   * 必须整条留着、逐步消耗，**不能每次提示都重新求解** ——
   * 求解器每次可能返回不同的解，玩家连点提示就会在两条解之间来回打转，
   * 永远走不到终点。玩家一旦偏离计划，才把它作废重算。
   */
  private plan: Move[] | null = null;

  constructor(opts: GameOptions) {
    this.level = opts.level;
    this.rng = opts.rng;
    this.now = opts.now ?? (() => Date.now());
    this.comboWindowMs = opts.comboWindowMs ?? DEFAULT_COMBO_WINDOW_MS;
    this.reguaranteeAfterRevive = opts.reguaranteeAfterRevive ?? true;

    const gen = generateLevel(opts.level, opts.rng);
    this.pens = gen.pens;
    this.penCapacity = gen.penCapacity;
    this.parMoves = gen.solutionLength;
    this.totalSheep = countSheep(gen.pens);

    for (const [kind, n] of Object.entries(opts.level.freeItems)) {
      this.itemsLeft.set(kind as ItemKind, n ?? 0);
    }
    this.startedAt = this.now();
  }

  // ---------------------------------------------------------------- 查询

  get remaining(): number {
    return countSheep(this.pens);
  }

  get shipped(): number {
    return this.totalSheep - this.remaining;
  }

  get penCount(): number {
    return this.pens.length;
  }

  /** 栏口那一群羊。UI 用它决定点一下会拿起几只。 */
  topRunOf(penIndex: number): { breed: Breed; count: number } | null {
    const pen = this.pens[penIndex];
    return pen ? topRun(pen) : null;
  }

  legalMoves(): Move[] {
    return legalMoves(this.pens, this.penCapacity);
  }

  /** 从 `from` 栏能不能赶到 `to` 栏。UI 高亮可落点用。 */
  canMove(from: number, to: number): boolean {
    const run = this.topRunOf(from);
    if (!run) return false;
    return isLegal(this.pens, this.penCapacity, { from, to, count: run.count });
  }

  itemCount(kind: ItemKind): number {
    return this.itemsLeft.get(kind) ?? 0;
  }

  elapsedSec(): number {
    return (this.now() - this.startedAt) / 1000;
  }

  timeLeftSec(): number {
    if (this.level.timeLimitSec <= 0) return Infinity;
    return Math.max(0, this.level.timeLimitSec - this.elapsedSec());
  }

  /**
   * 当前局面还有没有解。
   *
   * UI 应当在每步之后查一次：一旦无解就**主动**提示玩家用道具，
   * 而不是让他继续白点十几下才发现完了。这是《羊了个羊》最气人的地方之一。
   */
  isSolvable(): boolean {
    return this.solution() !== null;
  }

  /** 评星：贴近生成期的最优解给 3 星。 */
  stars(): number {
    if (this.status !== 'won') return 0;
    if (this.moves <= this.parMoves) return 3;
    if (this.moves <= Math.ceil(this.parMoves * 1.35)) return 2;
    return 1;
  }

  snapshot(): GameSnapshot {
    return {
      status: this.status,
      pens: clonePens(this.pens),
      penCapacity: this.penCapacity,
      remaining: this.remaining,
      shipped: this.shipped,
      combo: this.combo,
      score: this.score,
      moves: this.moves,
    };
  }

  // ---------------------------------------------------------------- 操作

  /** 把 `from` 栏口那一群羊赶到 `to` 栏。 */
  move(from: number, to: number): MoveResult {
    if (this.status !== 'playing') return { ok: false, reason: 'not-playing' };
    const run = this.topRunOf(from);
    if (!run) return { ok: false, reason: 'illegal' };

    const space = this.penCapacity - this.pens[to].length;
    const count = Math.min(run.count, space);
    const mv: Move = { from, to, count };
    if (count < 1 || !isLegal(this.pens, this.penCapacity, mv)) {
      return { ok: false, reason: 'illegal' };
    }

    this.pushHistory();
    const shipped = applyMoveInPlace(this.pens, this.penCapacity, mv);
    this.moves++;
    this.consumePlan(mv);

    let gained = 0;
    if (shipped !== null) gained = this.awardScore();

    if (isWon(this.pens)) {
      this.status = 'won';
    } else if (isDeadlocked(this.pens, this.penCapacity)) {
      this.status = 'lost';
    }

    return { ok: true, shipped, status: this.status, combo: this.combo, gained };
  }

  /** 限时关由外部循环调用。 */
  tickTimeout(): void {
    if (this.status === 'playing' && this.level.timeLimitSec > 0 && this.timeLeftSec() <= 0) {
      this.status = 'lost';
    }
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
    if (kind === 'addPen') return true;
    if (kind === 'hint') return this.hint() !== null;
    if (kind === 'sort') return this.remaining > 0;
    if (kind === 'dog') return this.dogTargets().length > 0;
    return false;
  }

  useItem(kind: ItemKind, arg?: number): boolean {
    if (!this.canUseItem(kind)) return false;
    if (this.itemCount(kind) <= 0) return false;
    const ok = this.applyItem(kind, arg);
    if (ok) this.itemsLeft.set(kind, this.itemCount(kind) - 1);
    return ok;
  }

  grantItem(kind: ItemKind, n = 1): void {
    this.itemsLeft.set(kind, this.itemCount(kind) + n);
  }

  private applyItem(kind: ItemKind, arg?: number): boolean {
    if (kind === 'undo') return this.undo();
    if (kind === 'addPen') return this.addPens(1);
    if (kind === 'hint') return this.hint() !== null;
    if (kind === 'sort') return this.reshuffle();
    if (kind === 'dog') {
      const targets = this.dogTargets();
      if (targets.length === 0) return false;
      const pick = arg !== undefined && targets.includes(arg) ? arg : targets[0];
      return this.sendAwayTop(pick);
    }
    return false;
  }

  /** 撤销一步。 */
  undo(): boolean {
    const prev = this.history.pop();
    if (!prev) return false;
    this.pens = prev.pens;
    this.score = prev.score;
    this.combo = prev.combo;
    this.lastShipAt = prev.lastShipAt;
    this.status = prev.status === 'lost' ? 'playing' : prev.status;
    this.moves = Math.max(0, this.moves - 1);
    this.invalidateSolution();
    return true;
  }

  /** 加空栏位。只放宽约束，原本有解的局面加完一定还有解。 */
  addPens(n: number): boolean {
    if (n <= 0) return false;
    this.pushHistory();
    for (let i = 0; i < n; i++) this.pens.push([]);
    this.invalidateSolution();
    if (this.status === 'lost' && !isDeadlocked(this.pens, this.penCapacity)) {
      this.status = 'playing';
    }
    return true;
  }

  /** 提示：当前局面解法的下一步。 */
  hint(): Move | null {
    const sol = this.solution();
    return sol && sol.length > 0 ? sol[0] : null;
  }

  /**
   * 「重排」：把剩下的羊打散成一个新的、**保证有解**的局面。
   * 玩家自己走进死路时的救命手段。
   */
  reshuffle(): boolean {
    const next = reshuffleSolvable(this.pens, this.penCapacity, this.rng);
    if (!next) return false;
    this.pushHistory();
    this.pens = next;
    this.invalidateSolution();
    this.status = 'playing';
    return true;
  }

  /**
   * 牧羊犬可以叼走哪些栏口的羊。
   *
   * 只列出「叼走之后依然有解」的栏 —— 因为送走一只羊会破坏
   * 「每个品种的数量是栏位容量的整数倍」这条性质，可能让剩下的羊永远凑不满一栏。
   * 有求解器在手，这里就能直接把不安全的选项挡掉，而不是事后让玩家吃亏。
   */
  dogTargets(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.pens.length; i++) {
      if (this.pens[i].length === 0) continue;
      const probe = clonePens(this.pens);
      probe[i].pop();
      if (isWon(probe)) {
        out.push(i);
        continue;
      }
      const r = solve(probe, this.penCapacity, { budget: RUNTIME_BUDGET });
      if (r && !r.exhausted) out.push(i);
    }
    return out;
  }

  private sendAwayTop(penIndex: number): boolean {
    const pen = this.pens[penIndex];
    if (!pen || pen.length === 0) return false;
    this.pushHistory();
    pen.pop();
    this.totalSheep--; // 这只羊直接离场，不计入「出栏」
    this.invalidateSolution();
    if (isWon(this.pens)) this.status = 'won';
    else if (isDeadlocked(this.pens, this.penCapacity)) this.status = 'lost';
    return true;
  }

  /**
   * 复活：加 n 个空栏位回到可玩状态。
   * 由 monetize/revive.ts 决定看一次广告给几个栏位（递减）。
   */
  revive(extraPens: number): boolean {
    if (this.status !== 'lost') return false;
    this.status = 'playing';
    for (let i = 0; i < extraPens; i++) this.pens.push([]);
    this.invalidateSolution();

    if (this.reguaranteeAfterRevive && !this.isSolvable()) {
      // 加栏位还是死的（限时判负、或者玩家把局面走烂了），
      // 就重排成一个保证有解的局面。广告换来的必须是能打通的局面。
      this.reshuffle();
    }
    if (isDeadlocked(this.pens, this.penCapacity)) {
      this.status = 'lost';
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- 内部

  private pushHistory(): void {
    this.history.push({
      pens: clonePens(this.pens),
      score: this.score,
      combo: this.combo,
      lastShipAt: this.lastShipAt,
      status: this.status,
    });
    // 撤销栈封顶，防止长关卡把内存吃干
    if (this.history.length > 200) this.history.shift();
  }

  private invalidateSolution(): void {
    this.plan = null;
  }

  /**
   * 玩家走了一步之后更新计划。
   * 正好走在计划上就把这一步划掉，否则整条计划作废、下次重算。
   */
  private consumePlan(mv: Move): void {
    if (this.plan && this.plan.length > 0) {
      const head = this.plan[0];
      if (head.from === mv.from && head.to === mv.to) {
        this.plan = this.plan.slice(1);
        return;
      }
    }
    this.plan = null;
  }

  /** 当前正在跟随的通关计划，没有就现算一条。无解返回 null。 */
  private solution(): Move[] | null {
    if (this.plan !== null) return this.plan;
    const r = solve(this.pens, this.penCapacity, { budget: RUNTIME_BUDGET });
    if (!r || r.exhausted) return null;
    this.plan = r.moves;
    return this.plan;
  }

  private awardScore(): number {
    const t = this.now();
    this.combo = t - this.lastShipAt <= this.comboWindowMs ? this.combo + 1 : 1;
    this.lastShipAt = t;
    // 连击加成封顶 5 倍，避免长尾滚雪球把排行榜打崩。
    const mult = Math.min(5, 1 + (this.combo - 1) * 0.5);
    const gained = Math.round(200 * mult);
    this.score += gained;
    return gained;
  }
}
