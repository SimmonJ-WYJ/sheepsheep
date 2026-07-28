import test from 'node:test';
import assert from 'node:assert/strict';

import { createRng, seedFromString } from '../src/core/rng.ts';
import { makeLevel } from '../src/core/levels.ts';
import { SheepGame } from '../src/core/game.ts';
import { buildDeck } from '../src/core/deck.ts';

/**
 * 这个文件是整个项目的地基检查：
 * 「生成的牌面一定能通关」如果不成立，上面所有的设计都是空的。
 */

function playSolution(game: SheepGame): { maxSlot: number; steps: number } {
  let maxSlot = 0;
  let steps = 0;
  for (const id of game.solution) {
    const r = game.pick(id);
    assert.equal(r.ok, true, `第 ${steps} 步点 ${id} 失败`);
    maxSlot = Math.max(maxSlot, game.slot.length);
    steps++;
    if (game.status !== 'playing') break;
  }
  return { maxSlot, steps };
}

test('生成的牌面沿解法路径一定能通关（60 关 × 5 种子）', () => {
  for (let id = 1; id <= 60; id++) {
    for (let s = 0; s < 5; s++) {
      const level = makeLevel(id);
      const rng = createRng(seedFromString(`lv${id}-seed${s}`));
      const game = new SheepGame({ level, rng, now: () => 0 });

      const total = game.tiles.length;
      assert.equal(total % 3, 0, `第 ${id} 关牌数不是 3 的倍数: ${total}`);

      const { maxSlot, steps } = playSolution(game);

      assert.equal(game.status, 'won', `第 ${id} 关 seed ${s} 未通关`);
      assert.equal(steps, total, `第 ${id} 关未走完全部牌`);
      assert.ok(
        maxSlot < level.slotCapacity,
        `第 ${id} 关卡槽峰值 ${maxSlot} 触顶 ${level.slotCapacity}`,
      );
    }
  }
});

test('拓扑序里每一步取的牌当时都是可点的', () => {
  const level = makeLevel(40);
  const rng = createRng(12345);
  const game = new SheepGame({ level, rng, now: () => 0 });
  for (const id of game.solution) {
    assert.ok(game.canPick(id), `牌 ${id} 在该步不可点`);
    game.pick(id);
  }
  assert.equal(game.status, 'won');
});

test('同一个 seed 产出完全相同的牌面（每日挑战 / 服务端复算的前提）', () => {
  const level = makeLevel(30);
  const a = buildDeck(level, createRng(999));
  const b = buildDeck(level, createRng(999));
  assert.deepEqual(
    a.tiles.map((t) => [t.id, t.icon, t.layer, t.x, t.y]),
    b.tiles.map((t) => [t.id, t.icon, t.layer, t.x, t.y]),
  );
  assert.deepEqual(a.solution, b.solution);
});

test('不同 seed 产出不同牌面', () => {
  const level = makeLevel(30);
  const a = buildDeck(level, createRng(1));
  const b = buildDeck(level, createRng(2));
  assert.notDeepEqual(a.solution, b.solution);
});

test('图标数受难度配置约束，且每种图标的总数都是 3 的倍数', () => {
  for (let id = 1; id <= 60; id += 7) {
    const level = makeLevel(id);
    const deck = buildDeck(level, createRng(id * 7717));
    const count = new Map<number, number>();
    for (const t of deck.tiles) count.set(t.icon, (count.get(t.icon) ?? 0) + 1);

    assert.ok(
      count.size <= level.difficulty.iconCount,
      `第 ${id} 关图标种类 ${count.size} 超过配置 ${level.difficulty.iconCount}`,
    );
    for (const [icon, n] of count) {
      // 每个「组」恰好 3 张，一个图标是若干个组的并集 —— 所以必然是 3 的倍数。
      // 这条性质保证了：走完全部牌之后卡槽一定空，即一定是「通关」而非「卡住」。
      assert.equal(n % 3, 0, `第 ${id} 关图标 ${icon} 数量 ${n} 不是 3 的倍数`);
    }
  }
});
