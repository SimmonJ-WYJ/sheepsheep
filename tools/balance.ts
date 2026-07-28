/**
 * 数值体检工具。
 *
 *   npm run balance            # 默认抽查
 *   npm run balance -- 1 60 5  # 起始关 结束关 每关模拟人数
 *
 * 用三档「机器人」模拟真人，跑出每一关的通过率曲线。
 * 这是把「我觉得这关挺难的」换成「这关新手通过率 18%」的唯一办法。
 *
 * 三档机器人：
 *   random  —— 完全乱点。代表「没看懂规则」的人，也是通过率的下界。
 *   greedy  —— 优先凑手上快满的图标。代表绝大多数普通玩家。
 *   planner —— greedy 基础上会避开「把下层同图标闷死」的点法。代表老手。
 *
 * 判读标准（手游三消的常见健康区间）：
 *   greedy 通过率 85%+ 的关卡太水，会让人觉得没意思
 *   greedy 通过率 25% 以下的关卡太硬，会掉队 —— 尖峰关除外，那是故意的
 */

import { createRng } from '../src/core/rng.ts';
import type { Rng } from '../src/core/rng.ts';
import { makeLevel } from '../src/core/levels.ts';
import { SheepGame } from '../src/core/game.ts';
import type { Tile } from '../src/core/types.ts';

type Bot = 'random' | 'greedy' | 'planner';

function chooseRandom(game: SheepGame, rng: Rng): Tile | null {
  const free = game.freeTiles();
  return free.length ? free[rng.int(free.length)] : null;
}

function chooseGreedy(game: SheepGame, rng: Rng): Tile | null {
  const free = game.freeTiles();
  if (!free.length) return null;

  const inSlot = new Map<number, number>();
  for (const t of game.slot) {
    const ic = game.effectiveIcon(t);
    inSlot.set(ic, (inSlot.get(ic) ?? 0) + 1);
  }

  // 能立刻凑成三张的最优先，其次是能配对的，最后才是开新图标
  let best: Tile | null = null;
  let bestScore = -Infinity;
  for (const t of free) {
    const held = inSlot.get(game.effectiveIcon(t)) ?? 0;
    const score = held === 2 ? 100 : held === 1 ? 50 : -10 * game.slot.length;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best ?? free[rng.int(free.length)];
}

function choosePlanner(game: SheepGame, rng: Rng): Tile | null {
  const free = game.freeTiles();
  if (!free.length) return null;

  const inSlot = new Map<number, number>();
  for (const t of game.slot) {
    const ic = game.effectiveIcon(t);
    inSlot.set(ic, (inSlot.get(ic) ?? 0) + 1);
  }

  // 统计每个图标在牌堆里还剩几张可点的，用来判断「现在拿了会不会吊死」
  const freeByIcon = new Map<number, number>();
  for (const t of free) {
    const ic = game.effectiveIcon(t);
    freeByIcon.set(ic, (freeByIcon.get(ic) ?? 0) + 1);
  }

  let best: Tile | null = null;
  let bestScore = -Infinity;
  const pressure = game.slot.length / game.slotCapacity;

  for (const t of free) {
    const ic = game.effectiveIcon(t);
    const held = inSlot.get(ic) ?? 0;
    const alsoFree = (freeByIcon.get(ic) ?? 1) - 1;

    let score: number;
    if (held === 2) score = 1000;
    // 手上有一张、场上还能立刻再摸到一张 → 这一步之后能马上消掉，很安全
    else if (held === 1 && alsoFree >= 1) score = 800;
    else if (held === 1) score = 400;
    // 场上同图标有 3 张都可点，开新坑也无所谓，一轮就能清掉
    else if (alsoFree >= 2) score = 200 - pressure * 300;
    else score = -200 - pressure * 600;

    // 卡槽越满，越不敢开新图标
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best ?? free[rng.int(free.length)];
}

const BOTS: Record<Bot, (g: SheepGame, r: Rng) => Tile | null> = {
  random: chooseRandom,
  greedy: chooseGreedy,
  planner: choosePlanner,
};

function simulate(levelId: number, bot: Bot, seed: number): boolean {
  const rng = createRng(seed);
  const game = new SheepGame({ level: makeLevel(levelId), rng, now: () => 0 });
  const choose = BOTS[bot];
  let guard = 0;
  while (game.status === 'playing' && guard++ < 20_000) {
    const t = choose(game, rng);
    if (!t) break;
    game.pick(t.id);
  }
  return game.status === 'won';
}

function pct(n: number, d: number): string {
  return d === 0 ? '  -  ' : `${((n / d) * 100).toFixed(0).padStart(3)}%`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const from = Number(argv[0] ?? 1);
  const to = Number(argv[1] ?? 60);
  const runs = Number(argv[2] ?? 60);

  const bots: Bot[] = ['random', 'greedy', 'planner'];
  console.log(`\n关卡数值体检  (每关每档 ${runs} 次模拟)\n`);
  console.log('  关卡   牌数  层数  图标  同开组  限时   random greedy planner');
  console.log('  ' + '-'.repeat(66));

  const warn: string[] = [];

  for (let id = from; id <= to; id++) {
    const level = makeLevel(id);
    const probe = new SheepGame({ level, rng: createRng(1), now: () => 0 });
    const results: Record<Bot, number> = { random: 0, greedy: 0, planner: 0 };

    for (const bot of bots) {
      for (let i = 0; i < runs; i++) {
        if (simulate(id, bot, id * 100_003 + i)) results[bot]++;
      }
    }

    const spike = level.name.includes('尖峰');
    const tag = spike ? ' *' : '  ';
    console.log(
      `  ${String(id).padStart(4)}${tag} ${String(probe.tiles.length).padStart(5)} ` +
        `${String(level.layout.layers.length).padStart(5)} ` +
        `${String(level.difficulty.iconCount).padStart(5)} ` +
        `${String(level.difficulty.maxOpenGroups).padStart(6)} ` +
        `${String(level.timeLimitSec || '-').padStart(5)}   ` +
        `${pct(results.random, runs)}  ${pct(results.greedy, runs)}  ${pct(results.planner, runs)}`,
    );

    const greedyRate = results.greedy / runs;
    const plannerRate = results.planner / runs;
    // 前 10 关本来就该是「几乎不可能输」，不参与偏水判定。
    if (!spike && id > 10 && greedyRate > 0.95) {
      warn.push(`第 ${id} 关偏水（greedy ${(greedyRate * 100).toFixed(0)}%）`);
    }
    if (!spike && greedyRate < 0.2) {
      warn.push(`第 ${id} 关偏硬（greedy ${(greedyRate * 100).toFixed(0)}%）`);
    }
    // 老手都打不过，说明是牌面本身太挤，而不是玩家菜 —— 这种一定要改。
    if (!spike && plannerRate < 0.4) {
      warn.push(`第 ${id} 关连老手都吃力（planner ${(plannerRate * 100).toFixed(0)}%）`);
    }
  }

  console.log('\n  * = 尖峰关，难度陡增是故意的\n');
  if (warn.length) {
    console.log('  需要复看的关卡：');
    for (const w of warn.slice(0, 20)) console.log(`    - ${w}`);
    if (warn.length > 20) console.log(`    ...另有 ${warn.length - 20} 条`);
  } else {
    console.log('  所有关卡都落在健康区间内。');
  }
  console.log();
}

main();
