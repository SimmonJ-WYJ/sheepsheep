import test from 'node:test';
import assert from 'node:assert/strict';

import { createRng } from '../src/core/rng.ts';
import { makeLevel } from '../src/core/levels.ts';
import { SortGame } from '../src/core/game.ts';
import { MockPlatform } from '../src/platform/mock.ts';
import { AdManager } from '../src/monetize/ad-manager.ts';
import { DEFAULT_AD_POLICY, PLACEHOLDER_AD_UNITS } from '../src/monetize/policy.ts';
import { AD_REVIVE_LADDER, LocalWallet, ReviveController } from '../src/monetize/revive.ts';
import { ItemShop } from '../src/monetize/item-shop.ts';

function setup(behaviour?: { endedRate?: number; errorRate?: number }) {
  const platform = new MockPlatform(behaviour);
  const ads = new AdManager({
    platform,
    adUnits: PLACEHOLDER_AD_UNITS,
    policy: DEFAULT_AD_POLICY,
    bootAt: 0,
  });
  // 跳过冷启动静默期，并进到非新手关
  platform.advance(DEFAULT_AD_POLICY.coldStartQuietMs + 1000);
  ads.startLevel(20);
  return { platform, ads };
}

function makeGame(levelId = 20, seed = 4242): SortGame {
  return new SortGame({ level: makeLevel(levelId), rng: createRng(seed), now: () => 0 });
}

/** 随便走一步，让「撤销」变得可用。 */
function makeUndoable(game: SortGame): void {
  if (game.itemCount('undo') >= 0 && game.canUseItem('undo')) return;
  const m = game.legalMoves()[0];
  if (m) game.move(m.from, m.to);
}

/** 找一个真实的失败局面（随机乱走到走不动）。 */
function lostGame(): SortGame {
  for (let s = 0; s < 80; s++) {
    const game = makeGame(50, 6000 + s);
    const rng = createRng(s * 7919 + 11);
    let guard = 0;
    while (game.status === 'playing' && guard++ < 3000) {
      const moves = game.legalMoves();
      if (moves.length === 0) break;
      const m = moves[rng.int(moves.length)];
      game.move(m.from, m.to);
    }
    if (game.status === 'lost') return game;
  }
  throw new Error('没能构造出失败局面');
}

// ------------------------------------------------------------------ 频控

test('冷启动静默期内所有广告都被挡住', () => {
  const platform = new MockPlatform();
  const ads = new AdManager({ platform, adUnits: PLACEHOLDER_AD_UNITS, bootAt: 0 });
  ads.startLevel(20);
  const gate = ads.check('revive');
  assert.equal(gate.allowed, false);
  assert.equal(gate.allowed === false && gate.reason, 'cold-start-quiet');
});

test('新手关（前 5 关）不出广告', () => {
  const { ads } = setup();
  ads.startLevel(3);
  const gate = ads.check('item_undo');
  assert.equal(gate.allowed, false);
  assert.equal(gate.allowed === false && gate.reason, 'newbie-levels');
});

test('复活位豁免全局间隔，道具位不豁免', async () => {
  const { ads } = setup();
  await ads.request('item_sort'); // 占掉 lastAnyAdAt
  // 全局间隔 45s 内
  assert.equal(ads.check('item_hint').allowed, false);
  assert.equal(ads.check('revive').allowed, true, '复活位应当豁免全局间隔');
});

test('单关上限生效：同一道具每关最多看 2 次广告', async () => {
  const { platform, ads } = setup();
  for (let i = 0; i < 2; i++) {
    const r = await ads.request('item_undo');
    assert.equal(r.granted, true);
    platform.advance(60_000); // 越过冷却和全局间隔
  }
  const gate = ads.check('item_undo');
  assert.equal(gate.allowed, false);
  assert.equal(gate.allowed === false && gate.reason, 'level-cap');
});

test('加栏位这类强力道具额度收得更紧', async () => {
  const { platform, ads } = setup();
  // addPen 单关上限 2、日上限 5；dog 单关上限 1
  await ads.request('item_dog');
  platform.advance(60_000);
  const gate = ads.check('item_dog');
  assert.equal(gate.allowed, false);
  assert.equal(gate.allowed === false && gate.reason, 'level-cap');
});

test('换一关之后单关计数重置', async () => {
  const { platform, ads } = setup();
  for (let i = 0; i < 2; i++) {
    await ads.request('item_undo');
    platform.advance(60_000);
  }
  assert.equal(ads.check('item_undo').allowed, false);
  ads.startLevel(21);
  assert.equal(ads.check('item_undo').allowed, true);
});

test('激励视频日上限封顶后全部拒绝', async () => {
  const { platform, ads } = setup();
  let granted = 0;
  const places = ['revive', 'item_undo', 'item_sort', 'item_hint', 'item_addPen'] as const;
  for (let round = 0; round < 30; round++) {
    ads.startLevel(20 + round);
    for (const p of places) {
      const r = await ads.request(p);
      if (r.granted) granted++;
      platform.advance(60_000);
    }
  }
  assert.equal(
    granted,
    DEFAULT_AD_POLICY.rewardedDailyCap,
    `激励视频总量应当正好封顶在 ${DEFAULT_AD_POLICY.rewardedDailyCap}`,
  );
});

test('跨天之后额度重置', async () => {
  const { platform, ads } = setup();
  for (let round = 0; round < 30; round++) {
    ads.startLevel(20 + round);
    await ads.request('revive');
    platform.advance(60_000);
  }
  assert.equal(ads.check('revive').allowed, false);

  platform.advance(24 * 60 * 60 * 1000);
  ads.startLevel(99);
  assert.equal(ads.check('revive').allowed, true, '跨天后应当重置');
});

// ------------------------------------------------------------- 失败兜底

test('广告无填充时照样发奖（grantOnFailure）', async () => {
  const { ads } = setup({ errorRate: 1 });
  const r = await ads.request('revive');
  assert.equal(r.granted, true, '无填充不应该惩罚玩家');
  assert.equal(r.granted === true && r.fallback, true, '要标记成兜底，不能计入广告收入');
  assert.equal(r.granted === true && r.reason, 'ad-failed');
});

test('玩家中途关掉广告则不发奖', async () => {
  const { ads } = setup({ endedRate: 0, errorRate: 0 });
  const r = await ads.request('revive');
  assert.equal(r.granted, false);
  assert.equal(r.granted === false && r.reason, 'abandoned');
});

test('插屏加载失败不发奖也不报错', async () => {
  const { ads } = setup({ errorRate: 1 });
  const r = await ads.request('level_start');
  assert.equal(r.granted, false);
  assert.equal(r.granted === false && r.reason, 'failed');
});

// -------------------------------------------------------------- 复活流程

test('广告复活按梯度递减（2 个栏位 → 1 个），用完后转钻石', async () => {
  const { platform, ads } = setup();
  const revive = new ReviveController(ads, new LocalWallet(1000));
  revive.startLevel();

  for (let i = 0; i < AD_REVIVE_LADDER.length; i++) {
    const offer = revive.offer();
    assert.equal(offer.kind, 'ad', `第 ${i + 1} 次应当是广告复活`);
    assert.equal(
      offer.kind === 'ad' && offer.extraPens,
      AD_REVIVE_LADDER[i],
      `第 ${i + 1} 次应当给 ${AD_REVIVE_LADDER[i]} 个空栏位`,
    );

    const game = lostGame();
    const r = await revive.reviveByAd(game);
    assert.equal(r.ok, true);
    assert.equal(game.status, 'playing');
    platform.advance(60_000);
  }

  const after = revive.offer();
  assert.equal(after.kind, 'diamond', '广告梯度用完应当转钻石');
});

test('复活给的是空栏位，而且复活后局面真的能打通', async () => {
  const { ads } = setup();
  const revive = new ReviveController(ads, new LocalWallet(0));
  revive.startLevel();

  const game = lostGame();
  const pensBefore = game.penCount;

  const r = await revive.reviveByAd(game);
  assert.equal(r.ok, true);
  assert.equal(game.status, 'playing');
  assert.equal(game.penCount, pensBefore + AD_REVIVE_LADDER[0], '应当多出 2 个空栏位');
  assert.equal(
    game.isSolvable(),
    true,
    '看完广告换来的必须是一个真能打通的局面 —— 否则那 30 秒就是欺骗',
  );
});

test('广告无填充也能复活（玩家不为填充率买单）', async () => {
  const { ads } = setup({ errorRate: 1 });
  const revive = new ReviveController(ads, new LocalWallet(0));
  revive.startLevel();

  const game = lostGame();
  const r = await revive.reviveByAd(game);
  assert.equal(r.ok, true);
  assert.equal(r.fallback, true);
  assert.equal(game.status, 'playing');
  assert.equal(game.isSolvable(), true);
});

test('钻石不足时复活失败，且不扣钻石', async () => {
  const { platform, ads } = setup();
  const wallet = new LocalWallet(10);
  const revive = new ReviveController(ads, wallet);
  revive.startLevel();

  // 先把广告梯度用完
  for (let i = 0; i < AD_REVIVE_LADDER.length; i++) {
    await revive.reviveByAd(lostGame());
    platform.advance(60_000);
  }
  const offer = revive.offer();
  assert.equal(offer.kind, 'diamond');

  const game = lostGame();
  const r = revive.reviveByDiamond(game);
  assert.equal(r.ok, false);
  assert.equal(wallet.diamonds(), 10, '失败不该扣钻石');
  assert.equal(game.status, 'lost');
});

// ---------------------------------------------------------------- 道具

test('有免费次数时不弹广告，用完才转广告', async () => {
  const { ads } = setup();
  const shop = new ItemShop(ads, new LocalWallet(0));
  const game = makeGame(20); // 第 20 关每种道具免费 1 次

  assert.equal(shop.buttonState(game, 'hint'), 'free');
  assert.equal(shop.useFree(game, 'hint').ok, true);

  assert.equal(shop.buttonState(game, 'hint'), 'ad', '免费次数用完应当转广告');
  const r = await shop.useByAd(game, 'hint');
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.source, 'ad');
});

test('道具用下去没效果时直接置灰，不放行到广告', async () => {
  const { ads } = setup();
  const shop = new ItemShop(ads, new LocalWallet(500));
  const game = makeGame(20);

  // 一步都没走过，「撤销」点下去什么都不会发生
  assert.equal(game.canUseItem('undo'), false);
  assert.equal(shop.buttonState(game, 'undo'), 'locked');

  const r = await shop.useByAd(game, 'undo');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'no-effect');
  assert.equal(ads.stats().rewardedTotal, 0, '不该为一个无效道具播广告');
});

test('牧羊犬在会把局面搞成无解时置灰，不放行到广告', async () => {
  const { ads } = setup();
  const shop = new ItemShop(ads, new LocalWallet(500));
  const game = makeGame(20);

  // 新生成的局面里每个品种数量刚好，叼走任何一只都会让某个品种凑不满
  assert.equal(game.dogTargets().length, 0);
  assert.equal(shop.buttonState(game, 'dog'), 'locked');
  const r = await shop.useByAd(game, 'dog');
  assert.equal(r.ok === false && r.reason, 'no-effect');
  assert.equal(ads.stats().rewardedTotal, 0);
});

test('广告额度耗尽且钻石不足时道具置灰', async () => {
  const { platform, ads } = setup();
  const shop = new ItemShop(ads, new LocalWallet(0));
  const game = makeGame(20);

  makeUndoable(game);
  assert.equal(shop.useFree(game, 'undo').ok, true);
  for (let i = 0; i < 2; i++) {
    makeUndoable(game);
    const r = await shop.useByAd(game, 'undo');
    assert.equal(r.ok, true, `第 ${i + 1} 次广告换道具应当成功`);
    platform.advance(60_000);
  }
  makeUndoable(game); // 保证道具本身可用，置灰只能是额度原因
  assert.equal(shop.buttonState(game, 'undo'), 'locked');
});

test('钻石够时降级到钻石购买而不是置灰', async () => {
  const { platform, ads } = setup();
  const shop = new ItemShop(ads, new LocalWallet(500));
  const game = makeGame(20);

  makeUndoable(game);
  shop.useFree(game, 'undo');
  for (let i = 0; i < 2; i++) {
    makeUndoable(game);
    await shop.useByAd(game, 'undo');
    platform.advance(60_000);
  }
  makeUndoable(game);
  assert.equal(shop.buttonState(game, 'undo'), 'diamond');
  assert.equal(shop.useByDiamond(game, 'undo').ok, true);
});

test('道具箱一次广告开出 3 个道具', async () => {
  const { ads } = setup();
  const shop = new ItemShop(ads, new LocalWallet(0));
  const game = makeGame(20);
  const total = (): number =>
    game.itemCount('undo') + game.itemCount('hint') + game.itemCount('sort') + game.itemCount('addPen');

  const before = total();
  const r = await shop.openBox(game, (pool) => pool[0]);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 3);
  assert.equal(total() - before, 3);
});
