import test from 'node:test';
import assert from 'node:assert/strict';

import { createRng, seedFromString } from '../src/core/rng.ts';
import { makeLevel } from '../src/core/levels.ts';
import { SortGame } from '../src/core/game.ts';
import { generateLevel, reshuffleSolvable, withExtraPens } from '../src/core/generator.ts';
import { isSolvable, solve } from '../src/core/solver.ts';
import { applyMoveInPlace, clonePens, countSheep, isWon, legalMoves } from '../src/core/board.ts';

/**
 * 这个文件是整个项目的地基检查：
 * 「发给玩家的每个局面都真的能通关」如果不成立，上面所有的设计都是空的。
 */

/** 沿求解器给出的解实际走一遍，验证它真的能赢。 */
function playSolution(game: SortGame): number {
  const sol = solve(game.pens, game.penCapacity);
  assert.ok(sol && !sol.exhausted, '求解器应当能解出当前局面');
  let steps = 0;
  for (const mv of sol.moves) {
    const r = game.move(mv.from, mv.to);
    assert.equal(r.ok, true, `第 ${steps} 步 ${mv.from}→${mv.to} 被拒绝`);
    steps++;
    if (game.status !== 'playing') break;
  }
  return steps;
}

test('生成的每个局面都能真正打通（80 关 × 4 种子）', () => {
  for (let id = 1; id <= 80; id++) {
    for (let s = 0; s < 4; s++) {
      const level = makeLevel(id);
      const rng = createRng(seedFromString(`lv${id}-seed${s}`));
      const game = new SortGame({ level, rng, now: () => 0 });

      // 每个品种恰好 penCapacity 只 —— 这条保证「全部出栏」是可能的
      assert.equal(
        game.remaining,
        level.difficulty.breedCount * level.penCapacity,
        `第 ${id} 关羊数不对`,
      );

      playSolution(game);
      assert.equal(game.status, 'won', `第 ${id} 关 seed ${s} 没能通关`);
      assert.equal(game.remaining, 0);
    }
  }
});

test('开局不会白送已经排好的一栏', () => {
  for (let id = 1; id <= 60; id += 3) {
    const level = makeLevel(id);
    const gen = generateLevel(level, createRng(id * 31 + 7));
    for (const pen of gen.pens) {
      if (pen.length !== level.penCapacity) continue;
      const uniform = pen.every((b) => b === pen[0]);
      assert.equal(uniform, false, `第 ${id} 关开局就有一栏排好了，会瞬间自动出栏`);
    }
  }
});

test('生成的解法长度不低于难度配置要求（不能一眼看穿）', () => {
  for (let id = 1; id <= 80; id += 5) {
    const level = makeLevel(id);
    const gen = generateLevel(level, createRng(id * 977));
    assert.ok(
      gen.solutionLength >= level.difficulty.minSolutionLength,
      `第 ${id} 关解法只要 ${gen.solutionLength} 步，低于要求的 ${level.difficulty.minSolutionLength}`,
    );
  }
});

test('同一个 seed 产出完全相同的局面（每日挑战 / 服务端复算的前提）', () => {
  const level = makeLevel(40);
  const a = generateLevel(level, createRng(999));
  const b = generateLevel(level, createRng(999));
  assert.deepEqual(a.pens, b.pens);
  assert.equal(a.solutionLength, b.solutionLength);
});

test('不同 seed 产出不同局面', () => {
  const level = makeLevel(40);
  const a = generateLevel(level, createRng(1));
  const b = generateLevel(level, createRng(2));
  assert.notDeepEqual(a.pens, b.pens);
});

test('求解器给出的每一步都是合法的', () => {
  const level = makeLevel(50);
  const gen = generateLevel(level, createRng(24680));
  const sol = solve(gen.pens, level.penCapacity);
  assert.ok(sol && !sol.exhausted);

  const pens = clonePens(gen.pens);
  for (const mv of sol.moves) {
    const legal = legalMoves(pens, level.penCapacity);
    const found = legal.some((m) => m.from === mv.from && m.to === mv.to && m.count === mv.count);
    assert.ok(found, `步骤 ${mv.from}→${mv.to}×${mv.count} 在当时不合法`);
    applyMoveInPlace(pens, level.penCapacity, mv);
  }
  assert.equal(isWon(pens), true, '走完求解器的解应当通关');
});

test('求解器能正确判定一个真正的死局为无解', () => {
  // 容量 3，两个品种，全满且栏口互不相同 —— 一步都动不了
  const pens = [
    [0, 1, 0],
    [1, 0, 1],
  ];
  assert.equal(legalMoves(pens, 3).length, 0, '这个局面应当一步都走不动');
  assert.equal(isSolvable(pens, 3), false);
});

test('求解器能解一个手工构造的简单局面', () => {
  // 容量 3：把两个品种各自归拢即可
  const pens = [
    [0, 1, 0],
    [1, 0, 1],
    [],
  ];
  const sol = solve(pens, 3);
  assert.ok(sol && !sol.exhausted, '有一个空栏就应当能解开');
  assert.ok(sol.moves.length > 0);
});

test('加空栏位只会让局面更容易，不会让有解变无解', () => {
  for (let id = 10; id <= 70; id += 10) {
    const level = makeLevel(id);
    const gen = generateLevel(level, createRng(id * 13 + 5));
    assert.equal(isSolvable(gen.pens, level.penCapacity), true);
    const wider = withExtraPens(gen.pens, 2);
    assert.equal(
      isSolvable(wider, level.penCapacity),
      true,
      `第 ${id} 关加空栏位之后反而无解了 —— 不可能，说明求解器有问题`,
    );
  }
});

test('重排道具产出的局面一定有解，且羊群构成不变', () => {
  for (let id = 20; id <= 70; id += 10) {
    const level = makeLevel(id);
    const gen = generateLevel(level, createRng(id * 7717));

    const next = reshuffleSolvable(gen.pens, level.penCapacity, createRng(id + 1));
    assert.ok(next, `第 ${id} 关重排失败`);
    assert.equal(
      isSolvable(next, level.penCapacity),
      true,
      `第 ${id} 关重排之后无解 —— 这正是《羊了个羊》洗牌的毛病`,
    );

    // 不能凭空变出羊，也不能吞羊
    assert.equal(countSheep(next), countSheep(gen.pens));
    const before = gen.pens.flat().sort().join(',');
    const after = next.flat().sort().join(',');
    assert.equal(after, before, '重排不该改变羊群的品种构成');
  }
});
