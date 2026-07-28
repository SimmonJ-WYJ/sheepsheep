import test from 'node:test';
import assert from 'node:assert/strict';

import { createRng } from '../src/core/rng.ts';
import { makeLevel } from '../src/core/levels.ts';
import { SortGame } from '../src/core/game.ts';
import type { LevelConfig, Pens } from '../src/core/types.ts';
import { isSolvable } from '../src/core/solver.ts';
import { countSheep, topRun } from '../src/core/board.ts';

function newGame(levelId = 30, seed = 777, now?: () => number): SortGame {
  return new SortGame({
    level: makeLevel(levelId),
    rng: createRng(seed),
    now: now ?? (() => 0),
  });
}

/**
 * 构造一个指定局面的游戏，用来测那些随机生成很难碰到的边界情况。
 * `pens` 直接覆盖生成结果 —— 只在测试里这么用。
 */
function gameWithPens(pens: Pens, capacity: number, extra?: Partial<LevelConfig>): SortGame {
  const level: LevelConfig = {
    id: 999,
    name: 'fixture',
    penCapacity: capacity,
    timeLimitSec: 0,
    difficulty: { breedCount: 2, emptyPens: 2, minSolutionLength: 1 },
    freeItems: { undo: 9, addPen: 9, hint: 9, sort: 9, dog: 9 },
    ...extra,
  };
  const game = new SortGame({ level, rng: createRng(1), now: () => 0 });
  game.pens = pens.map((p) => p.slice());
  return game;
}

/** 一直随机走到分出胜负。 */
function playRandom(game: SortGame, rng = createRng(4242)): void {
  let guard = 0;
  while (game.status === 'playing' && guard++ < 3000) {
    const moves = game.legalMoves();
    if (moves.length === 0) break;
    const m = moves[rng.int(moves.length)];
    game.move(m.from, m.to);
  }
}

// ------------------------------------------------------------------ 规则

test('品种不同的羊不能叠在一起', () => {
  const game = gameWithPens(
    [
      [0, 0],
      [1],
      [],
    ],
    4,
  );
  assert.equal(game.canMove(0, 1), false, '0 号品种不能叠到 1 号品种上');
  assert.equal(game.move(0, 1).ok, false);
  assert.equal(game.canMove(0, 2), true, '空栏可以放');
});

test('满栏不能再放', () => {
  const game = gameWithPens(
    [
      [0, 1, 1, 1],
      [1],
    ],
    4,
  );
  assert.equal(game.canMove(1, 0), false, '第 0 栏已满');
});

test('一次能赶走栏口连续同品种的一整群', () => {
  const game = gameWithPens(
    [
      [1, 0, 0, 0],
      [0],
    ],
    4,
  );
  assert.deepEqual(topRun(game.pens[0]), { breed: 0, count: 3 });
  const r = game.move(0, 1);
  assert.equal(r.ok, true);
  // 1 + 3 = 4 只同品种 → 立刻整栏出栏
  assert.equal(r.ok === true && r.shipped, 0, '应当出栏 0 号品种');
  assert.deepEqual(game.pens[1], [], '出栏后栏位空出来');
  assert.deepEqual(game.pens[0], [1]);
});

test('空间不够时只赶走能装下的那几只', () => {
  const game = gameWithPens(
    [
      [0, 0, 0],
      [1, 0],
    ],
    4,
  );
  const r = game.move(0, 1);
  assert.equal(r.ok, true);
  assert.equal(game.pens[1].length, 4, '只能再装 2 只');
  assert.equal(game.pens[0].length, 1, '第 0 栏还剩 1 只');
});

test('集满一栏同品种就出栏，且栏位可以复用', () => {
  const game = gameWithPens(
    [
      [0, 0, 0],
      [0],
      [1, 1],
    ],
    4,
  );
  const before = countSheep(game.pens);
  const r = game.move(1, 0);
  assert.equal(r.ok === true && r.shipped, 0);
  assert.equal(countSheep(game.pens), before - 4, '出栏 4 只');
  assert.deepEqual(game.pens[0], []);
  assert.equal(game.canMove(2, 0), true, '空出来的栏位应当可以再用');
});

test('一步都走不动就判负', () => {
  // 随机乱走一定会把自己走死 —— 找一个真实的失败局面来验状态机
  const lost = findLostGame();
  assert.ok(lost, '在若干个高难关卡里应当能随机走到失败');
  assert.equal(lost.status, 'lost');
  assert.equal(lost.legalMoves().length, 0, '判负时应当确实一步都走不动');
  assert.ok(lost.remaining > 0, '还有羊没出栏');
});

test('全部出栏即通关', () => {
  const game = gameWithPens(
    [
      [0, 0, 0],
      [0],
    ],
    4,
  );
  const r = game.move(1, 0);
  assert.equal(r.ok === true && r.status, 'won');
  assert.equal(game.remaining, 0);
});

// ------------------------------------------------------------------ 道具

test('撤销精确还原上一步', () => {
  const game = newGame(30, 555);
  const before = game.pens.map((p) => p.slice());
  const scoreBefore = game.score;

  const mv = game.legalMoves()[0];
  game.move(mv.from, mv.to);
  assert.notDeepEqual(game.pens, before, '走了一步，局面应当变了');

  assert.equal(game.undo(), true);
  assert.deepEqual(game.pens, before, '撤销后局面应当完全还原');
  assert.equal(game.score, scoreBefore);
  assert.equal(game.moves, 0);
});

test('撤销能把判负的局面救回来', () => {
  const game = findLostGame();
  assert.ok(game);
  assert.equal(game.undo(), true);
  assert.equal(game.status, 'playing');
  assert.ok(game.legalMoves().length > 0, '撤销之后应当又有路可走');
});

test('出栏之后撤销能把整栏羊还回来', () => {
  const game = gameWithPens(
    [
      [0, 0, 0],
      [0],
      [1, 1],
    ],
    4,
  );
  const before = countSheep(game.pens);
  game.move(1, 0);
  assert.equal(countSheep(game.pens), before - 4);
  assert.equal(game.undo(), true);
  assert.equal(countSheep(game.pens), before, '撤销应当把出栏的 4 只还回来');
  assert.deepEqual(game.pens[0], [0, 0, 0]);
});

test('加栏位能把死局救活', () => {
  const game = findLostGame();
  assert.ok(game);
  assert.equal(game.addPens(1), true);
  assert.equal(game.status, 'playing', '多一个空栏位就有路可走了');
  assert.ok(game.legalMoves().length > 0);
});

test('提示给出的一步合法，且走完之后依然有解', () => {
  const game = newGame(45, 3131);
  for (let i = 0; i < 6 && game.status === 'playing'; i++) {
    const h = game.hint();
    assert.ok(h, '有解的局面应当能给出提示');
    assert.equal(game.canMove(h.from, h.to), true, '提示的一步应当合法');
    game.move(h.from, h.to);
    if (game.status === 'playing') {
      assert.equal(game.isSolvable(), true, '沿提示走之后应当仍然有解');
    }
  }
});

test('重排之后局面有解、羊群构成不变', () => {
  const game = newGame(50, 8080);
  playRandomUntilStuckOrN(game, 10);
  if (game.status !== 'playing') return;

  const before = game.pens.flat().sort().join(',');
  assert.equal(game.reshuffle(), true);
  assert.equal(game.pens.flat().sort().join(','), before, '重排不该改变羊群构成');
  assert.equal(game.isSolvable(), true, '重排之后必须有解');
});

test('牧羊犬只在「叼走之后依然有解」时可用', () => {
  // 容量 3，场上只有 3 只 0 号羊：叼走任意一只，剩下 2 只永远凑不满一栏
  const game = gameWithPens(
    [
      [0, 0],
      [0],
      [],
    ],
    3,
  );
  assert.equal(game.isSolvable(), true, '原局面是有解的');
  assert.deepEqual(game.dogTargets(), [], '任何一只都不能叼 —— 会变成永远无法通关');
  assert.equal(game.canUseItem('dog'), false);
  assert.equal(game.useItem('dog'), false);
});

test('牧羊犬能把无解的局面救回来（叼走那只多余的羊）', () => {
  // 0 号和 1 号各 3 只（凑得满），外加一只孤零零的 2 号 ——
  // 只要那只 2 号还在场上，它永远凑不满一栏，整局必然赢不了。
  const game = gameWithPens(
    [
      [0, 0, 1],
      [1, 1, 0],
      [2],
      [],
    ],
    3,
  );
  assert.equal(game.isSolvable(), false, '有一只孤零零的羊，这局赢不了');

  const targets = game.dogTargets();
  assert.deepEqual(targets, [2], `只有那只多余的羊能叼，实际 targets=${targets}`);

  const before = countSheep(game.pens);
  assert.equal(game.useItem('dog', 2), true);
  assert.equal(countSheep(game.pens), before - 1);
  assert.equal(game.isSolvable(), true, '叼走之后这局就能打通了');
});

test('道具用完就不能再用', () => {
  const game = newGame(30, 1234);
  const n = game.itemCount('hint');
  for (let i = 0; i < n; i++) assert.equal(game.useItem('hint'), true);
  assert.equal(game.useItem('hint'), false, '次数用完应当失败');
  game.grantItem('hint', 1);
  assert.equal(game.useItem('hint'), true, '补发之后可以再用');
});

// ------------------------------------------------------------------ 其他

test('连击在时间窗内累加', () => {
  const clock = { t: 0 };
  const timed = comboFixture(clock);
  // 三组羊，每组差一只 —— 可以连续出栏三次
  timed.pens = [
    [0, 0, 0],
    [0],
    [1, 1, 1],
    [1],
    [2, 2, 2],
    [2],
  ];

  const a = timed.move(1, 0);
  assert.equal(a.ok === true && a.combo, 1);
  const b = timed.move(3, 2);
  assert.equal(b.ok === true && b.combo, 2, '窗口内连续出栏应当累加');
  const c = timed.move(5, 4);
  assert.equal(c.ok === true && c.combo, 3);
  assert.ok(
    (c.ok === true ? c.gained : 0) > (a.ok === true ? a.gained : 0),
    '连击越高单次得分越高',
  );
});

test('超过连击窗口就归零', () => {
  const clock = { t: 0 };
  const timed = comboFixture(clock);
  timed.pens = [
    [0, 0, 0],
    [0],
    [1, 1, 1],
    [1],
  ];

  const a = timed.move(1, 0);
  assert.equal(a.ok === true && a.combo, 1);

  clock.t += 60_000; // 远超连击窗口
  const b = timed.move(3, 2);
  assert.equal(b.ok === true && b.combo, 1, '超过连击窗口应当重新从 1 开始');
});

test('限时关到点判负', () => {
  const clock = { t: 0 };
  const level = { ...makeLevel(40), timeLimitSec: 10 };
  const game = new SortGame({ level, rng: createRng(9), now: () => clock.t });
  assert.equal(game.status, 'playing');
  clock.t += 11_000;
  game.tickTimeout();
  assert.equal(game.status, 'lost');
});

test('评星按步数贴近最优解程度给', () => {
  const game = newGame(35, 246);
  const sol = game.hint() ? game.parMoves : 0;
  assert.ok(sol > 0);
  assert.equal(game.stars(), 0, '还没通关不给星');

  // 沿最优解打通 → 3 星
  let guard = 0;
  while (game.status === 'playing' && guard++ < 500) {
    const h = game.hint();
    if (!h) break;
    game.move(h.from, h.to);
  }
  assert.equal(game.status, 'won');
  assert.equal(game.stars(), 3, `沿最优解通关应当 3 星（用了 ${game.moves} 步 / par ${game.parMoves}）`);
});

test('随机乱走也不会让引擎进入非法状态', () => {
  for (let s = 0; s < 25; s++) {
    const game = newGame(40, 1000 + s);
    playRandom(game, createRng(s * 31));
    assert.ok(['won', 'lost', 'playing'].includes(game.status));
    // 每栏都不能超过容量
    for (const pen of game.pens) {
      assert.ok(pen.length <= game.penCapacity, `栏位超容量: ${pen.length}`);
    }
    // 羊只会出栏，不会凭空消失
    assert.equal(game.remaining + game.shipped, game.level.difficulty.breedCount * game.penCapacity);
  }
});

test('还能动但已经赢不了的局面也能被检测出来', () => {
  // 0 号和 1 号各只有 2 只，容量 3 —— 永远凑不满一栏，但栏口还能来回搬
  const game = gameWithPens(
    [
      [0, 1],
      [1, 0],
      [],
    ],
    3,
  );
  assert.ok(game.legalMoves().length > 0, '还有合法步');
  assert.equal(game.isSolvable(), false, '但怎么走都赢不了');
  assert.equal(game.status, 'playing', '引擎不会提前判负 —— 所以 UI 必须主动提示玩家用道具');
  assert.equal(game.canUseItem('hint'), false, '无解时提示道具应当置灰');
});

function playRandomUntilStuckOrN(game: SortGame, n: number): void {
  const rng = createRng(99);
  for (let i = 0; i < n && game.status === 'playing'; i++) {
    const moves = game.legalMoves();
    if (moves.length === 0) break;
    const m = moves[rng.int(moves.length)];
    game.move(m.from, m.to);
  }
}

function comboFixture(clock: { t: number }): SortGame {
  return new SortGame({
    level: {
      id: 998,
      name: 'combo',
      penCapacity: 4,
      timeLimitSec: 0,
      difficulty: { breedCount: 2, emptyPens: 2, minSolutionLength: 1 },
      freeItems: {},
    },
    rng: createRng(1),
    now: () => clock.t,
  });
}

/** 在几个高难关卡里随机乱走，找一个真实的失败局面。 */
function findLostGame(): SortGame | null {
  for (let s = 0; s < 60; s++) {
    const game = newGame(50, 5000 + s);
    playRandom(game, createRng(s * 7919 + 3));
    if (game.status === 'lost') return game;
  }
  return null;
}
