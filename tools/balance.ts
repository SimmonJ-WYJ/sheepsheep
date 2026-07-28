/**
 * 数值体检工具。
 *
 *   npm run balance            # 默认抽查 1~80 关
 *   npm run balance -- 1 60 40 # 起始关 结束关 每关模拟人数
 *
 * 用三档「机器人」模拟真人，跑出每一关的通过率曲线。
 * 这是把「我觉得这关挺难的」换成「这关新手通过率 43%」的唯一办法。
 *
 * 三档机器人（实现见 tools/bots.ts）：
 *   random  —— 完全乱走。通过率的下界。
 *   greedy  —— 只看眼前一步：能出栏就出栏，能合并就合并。代表大多数普通玩家。
 *   planner —— 每种走法都推演一遍，用局面评分挑最好的。代表会算的老手。
 *
 * 判读标准：
 *   greedy 95%+ 偏水（前 10 关除外，那是教学）
 *   greedy 20% 以下偏硬
 *   planner 40% 以下 → 是局面本身太挤，不是玩家菜，必须改
 *
 * **greedy 和 planner 的差距是这张表最重要的一列** ——
 * 差距大说明胜负由打法决定，这正是本作相对《羊了个羊》的立足点。
 */

import { createRng } from '../src/core/rng.ts';
import { makeLevel } from '../src/core/levels.ts';
import { SortGame } from '../src/core/game.ts';
import { applyMoveInPlace, canonicalKey, clonePens, isWon } from '../src/core/board.ts';
import { rankMoves } from './bots.ts';
import type { Bot } from './bots.ts';

interface Outcome {
  won: boolean;
  moves: number;
}

/**
 * 跑一局。直接在裸棋盘上推演，不经过 SortGame —— 快，而且不用管道具和计分。
 *
 * 关键细节：**跳过会走回旧局面的步**。
 * 否则确定性的机器人会在两个局面之间无限来回、白白判负，
 * 打出「乱点比会玩的还强」这种荒谬结果（第一版就踩了这个坑）。
 */
function simulate(levelId: number, bot: Bot, seed: number): Outcome {
  const rng = createRng(seed);
  const game = new SortGame({ level: makeLevel(levelId), rng, now: () => 0 });
  const capacity = game.penCapacity;

  let pens = clonePens(game.pens);
  const seen = new Set<string>([canonicalKey(pens)]);
  let moves = 0;

  for (let guard = 0; guard < 800; guard++) {
    if (isWon(pens)) return { won: true, moves };

    const ranked = rankMoves(bot, pens, capacity, rng);
    let advanced = false;

    for (const m of ranked) {
      const next = clonePens(pens);
      applyMoveInPlace(next, capacity, m);
      const key = canonicalKey(next);
      if (seen.has(key)) continue; // 原地打转，换下一个候选
      seen.add(key);
      pens = next;
      moves++;
      advanced = true;
      break;
    }
    if (!advanced) break; // 无路可走（或所有走法都是回头路）
  }
  return { won: isWon(pens), moves };
}

function pct(n: number, d: number): string {
  return d === 0 ? '  -  ' : `${((n / d) * 100).toFixed(0).padStart(3)}%`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const from = Number(argv[0] ?? 1);
  const to = Number(argv[1] ?? 80);
  const runs = Number(argv[2] ?? 40);

  const bots: Bot[] = ['random', 'greedy', 'planner'];
  console.log(`\n关卡数值体检  (每关每档 ${runs} 次模拟)\n`);
  console.log('  关卡   羊数  品种  空栏  容量  par  限时   random greedy planner  技巧收益');
  console.log('  ' + '-'.repeat(78));

  const warn: string[] = [];

  for (let id = from; id <= to; id++) {
    const level = makeLevel(id);
    const probe = new SortGame({ level, rng: createRng(1), now: () => 0 });
    const won: Record<Bot, number> = { random: 0, greedy: 0, planner: 0 };

    for (const bot of bots) {
      for (let i = 0; i < runs; i++) {
        if (simulate(id, bot, id * 100_003 + i).won) won[bot]++;
      }
    }

    const g = won.greedy / runs;
    const p = won.planner / runs;
    const spike = level.name.includes('尖峰');

    console.log(
      `  ${String(id).padStart(4)}${spike ? ' *' : '  '} ${String(probe.remaining).padStart(5)} ` +
        `${String(level.difficulty.breedCount).padStart(5)} ` +
        `${String(level.difficulty.emptyPens).padStart(5)} ` +
        `${String(level.penCapacity).padStart(5)} ` +
        `${String(probe.parMoves).padStart(4)} ` +
        `${String(level.timeLimitSec || '-').padStart(5)}   ` +
        `${pct(won.random, runs)}  ${pct(won.greedy, runs)}  ${pct(won.planner, runs)}` +
        `   ${(p - g >= 0 ? '+' : '') + ((p - g) * 100).toFixed(0)}pt`,
    );

    if (!spike && id > 10 && g > 0.95) warn.push(`第 ${id} 关偏水（greedy ${(g * 100).toFixed(0)}%）`);
    if (!spike && g < 0.2) warn.push(`第 ${id} 关偏硬（greedy ${(g * 100).toFixed(0)}%）`);
    if (!spike && p < 0.4) warn.push(`第 ${id} 关连老手都吃力（planner ${(p * 100).toFixed(0)}%）`);
  }

  console.log('\n  * = 尖峰关，难度陡增是故意的');
  console.log('  par = 生成期求解器算出的最优步数');
  console.log('  技巧收益 = planner - greedy，越大说明这一关越吃打法而不是运气\n');
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
