import test from 'node:test';
import assert from 'node:assert/strict';

import { createRng } from '../src/core/rng.ts';
import { makeLevel } from '../src/core/levels.ts';
import { SheepGame } from '../src/core/game.ts';

function newGame(levelId = 30, seed = 777, now?: () => number) {
  return new SheepGame({
    level: makeLevel(levelId),
    rng: createRng(seed),
    now: now ?? (() => 0),
  });
}

/** 沿当前 solution 一路打到底，返回是否通关。 */
function finishAlongPath(game: SheepGame): boolean {
  let guard = 0;
  while (game.status === 'playing' && guard++ < 10_000) {
    const next = game.solution.find((id) => {
      const t = game.tiles.find((x) => x.id === id);
      return t && t.state === 'stack';
    });
    if (next === undefined) break;
    if (!game.canPick(next)) return false;
    game.pick(next);
  }
  return game.status === 'won';
}

test('被压住的牌点不动', () => {
  const game = newGame();
  const covered = game.tiles.find((t) => t.coveredBy.length > 0 && !game.canPick(t.id));
  assert.ok(covered, '应当存在被遮挡的牌');
  const r = game.pick(covered.id);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'not-free');
});

test('三张同图标自动消除', () => {
  const game = newGame();
  let clearedOnce = false;
  for (const id of game.solution) {
    const r = game.pick(id);
    if (r.ok && r.cleared.length > 0) {
      assert.equal(r.cleared.length % 3, 0, '每次消除都应当是 3 的倍数');
      const icons = new Set(r.cleared.map((t) => game.effectiveIcon(t)));
      assert.equal(icons.size, 1, '一次消除的三张图标应当相同');
      clearedOnce = true;
      break;
    }
  }
  assert.ok(clearedOnce);
});

test('卡槽放满 7 格且没有消除就判负', () => {
  const game = newGame(40, 31337);
  let guard = 0;
  while (game.status === 'playing' && guard++ < 5000) {
    const inSlot = new Set(game.slot.map((t) => game.effectiveIcon(t)));
    const free = game.freeTiles();
    if (free.length === 0) break;
    const bad = free.find((t) => !inSlot.has(game.effectiveIcon(t))) ?? free[0];
    game.pick(bad.id);
  }
  assert.equal(game.status, 'lost');
  assert.equal(game.slot.length, game.slotCapacity, '判负时卡槽应当正好是满的');
});

test('撤销能精确还原上一步（含被消除的三张）', () => {
  const game = newGame();
  // 走到一次消除发生为止，记下「刚点的那张」和「一起被消掉的三张」
  let pickedId = -1;
  let clearedIds: number[] = [];
  for (const id of game.solution) {
    const r = game.pick(id);
    if (r.ok && r.cleared.length > 0) {
      pickedId = id;
      clearedIds = r.cleared.map((t) => t.id);
      break;
    }
  }
  assert.ok(clearedIds.length >= 3);
  assert.ok(clearedIds.includes(pickedId), '触发消除的那张自己也在被消之列');

  const slotBefore = game.slot.map((t) => t.id);
  const scoreBefore = game.score;
  assert.equal(game.undo(), true);

  // 刚点的那张要退回牌堆；和它一起消掉的另外两张要退回卡槽。
  assert.equal(
    game.tiles.find((x) => x.id === pickedId)?.state,
    'stack',
    '刚点的那张应当退回牌堆',
  );
  for (const id of clearedIds) {
    if (id === pickedId) continue;
    const t = game.tiles.find((x) => x.id === id);
    assert.equal(t?.state, 'slot', `撤销后 ${id} 应当回到卡槽`);
  }

  assert.ok(game.score < scoreBefore, '撤销应当回退得分');
  assert.ok(game.slot.length > slotBefore.length, '撤销后卡槽应当比消除完之后更满');
  assert.equal(game.canPick(pickedId), true, '退回牌堆的那张应当可以再点一次');
});

test('撤销可以把判负的局面救回来', () => {
  const game = newGame(40, 31337);
  let guard = 0;
  while (game.status === 'playing' && guard++ < 5000) {
    const inSlot = new Set(game.slot.map((t) => game.effectiveIcon(t)));
    const free = game.freeTiles();
    if (free.length === 0) break;
    const bad = free.find((t) => !inSlot.has(game.effectiveIcon(t))) ?? free[0];
    game.pick(bad.id);
  }
  assert.equal(game.status, 'lost');
  assert.equal(game.undo(), true);
  assert.equal(game.status, 'playing');
});

test('「移出」把卡槽最前面的牌退回牌堆，且退回的牌立刻可点', () => {
  const game = newGame();
  for (let i = 0; i < 3 && game.slot.length < 3; i++) {
    const inSlot = new Set(game.slot.map((t) => game.effectiveIcon(t)));
    const next = game.freeTiles().find((t) => !inSlot.has(game.effectiveIcon(t)));
    if (next) game.pick(next.id);
  }
  const before = game.slot.length;
  assert.ok(before > 0);

  const moved = game.popBack(3);
  assert.equal(moved, Math.min(3, before));
  assert.equal(game.slot.length, before - moved);
  // 退回牌堆的牌上面本来就没东西压着了，所以一定是可点的
  for (const t of game.tiles) {
    if (t.state === 'stack' && t.coveredBy.every((c) => game.tiles.find((x) => x.id === c)?.state !== 'stack')) {
      assert.equal(game.canPick(t.id), true);
      break;
    }
  }
});

test('洗牌之后依然保证有解（跑 20 个随机局面）', () => {
  for (let s = 0; s < 20; s++) {
    const game = newGame(35, 1000 + s);

    // 先随便乱走一通，故意把自己走进一个可能的死路
    let guard = 0;
    while (game.status === 'playing' && guard++ < 12) {
      const free = game.freeTiles();
      if (free.length === 0) break;
      game.pick(free[Math.floor(free.length / 2)].id);
    }
    if (game.status !== 'playing') continue;

    assert.equal(game.reguarantee(), true, `seed ${s} 洗牌失败`);
    assert.ok(
      finishAlongPath(game),
      `seed ${s} 洗牌之后沿新路径没能通关 —— 可解性保证被破坏了`,
    );
  }
});

test('洗牌不会改变卡槽里已有的牌', () => {
  const game = newGame(35, 4242);
  let guard = 0;
  while (game.status === 'playing' && game.slot.length < 3 && guard++ < 50) {
    const inSlot = new Set(game.slot.map((t) => game.effectiveIcon(t)));
    const next = game.freeTiles().find((t) => !inSlot.has(game.effectiveIcon(t)));
    if (!next) break;
    game.pick(next.id);
  }
  const before = game.slot.map((t) => [t.id, game.effectiveIcon(t)]);
  game.reguarantee();
  const after = game.slot.map((t) => [t.id, game.effectiveIcon(t)]);
  assert.deepEqual(after, before, '洗牌只重排牌堆，不应该动卡槽');
});

test('提示在未偏离路径时给出可点的牌', () => {
  const game = newGame();
  for (let i = 0; i < 10; i++) {
    const h = game.hint();
    assert.ok(h, '刚开局沿路径走，提示不应为空');
    assert.equal(game.canPick(h.id), true);
    game.pick(h.id);
  }
});

test('洗牌之后提示恢复可用', () => {
  const game = newGame(35, 606);
  let guard = 0;
  while (game.status === 'playing' && guard++ < 12) {
    const free = game.freeTiles();
    if (free.length === 0) break;
    game.pick(free[free.length - 1].id);
  }
  game.reguarantee();
  const h = game.hint();
  assert.ok(h, '洗牌重算路径后提示应当可用');
  assert.equal(game.canPick(h.id), true);
});

test('连击在时间窗内累加，超时归零', () => {
  const clock = { t: 0 };
  const game = newGame(20, 555, () => clock.t);
  const combos: number[] = [];
  for (const id of game.solution) {
    const r = game.pick(id);
    if (r.ok && r.cleared.length > 0) {
      combos.push(r.combo);
      if (combos.length >= 2) break;
    }
  }
  assert.deepEqual(combos, [1, 2], '窗口内连续消除应当累加连击');

  // 把时钟推过连击窗口，再消除一次应当归 1
  clock.t += 10_000;
  for (const id of game.solution) {
    const t = game.tiles.find((x) => x.id === id);
    if (!t || t.state !== 'stack') continue;
    const r = game.pick(id);
    if (r.ok && r.cleared.length > 0) {
      assert.equal(r.combo, 1, '超过连击窗口应当重新从 1 开始');
      break;
    }
  }
});

test('限时关到点判负', () => {
  const clock = { t: 0 };
  const level = { ...makeLevel(40), timeLimitSec: 10 };
  const game = new SheepGame({ level, rng: createRng(9), now: () => clock.t });
  assert.equal(game.status, 'playing');
  clock.t += 11_000;
  game.tickTimeout();
  assert.equal(game.status, 'lost');
});

test('+1 卡槽道具确实放宽了判负阈值', () => {
  const game = newGame(40, 2024);
  const before = game.slotCapacity;
  game.grantItem('slot', 1);
  assert.equal(game.useItem('slot'), true);
  assert.equal(game.slotCapacity, before + 1);
});
