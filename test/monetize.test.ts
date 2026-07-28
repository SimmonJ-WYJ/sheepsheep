import test from 'node:test';
import assert from 'node:assert/strict';

import { createRng } from '../src/core/rng.ts';
import { makeLevel } from '../src/core/levels.ts';
import { SheepGame } from '../src/core/game.ts';
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

function makeGame(levelId = 20) {
  const level = makeLevel(levelId);
  return new SheepGame({ level, rng: createRng(4242), now: () => 0 });
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
  await ads.request('item_pop3'); // 占掉 lastAnyAdAt
  // 全局间隔 45s 内
  assert.equal(ads.check('item_xray').allowed, false);
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
  // 轮着刷各个位置，把日总量顶满
  const places = ['revive', 'item_undo', 'item_pop3', 'item_shuffle', 'item_xray'] as const;
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

test('广告复活按梯度递减，用完后转钻石', async () => {
  const { platform, ads } = setup();
  const wallet = new LocalWallet(1000);
  const revive = new ReviveController(ads, wallet);
  revive.startLevel();

  for (let i = 0; i < AD_REVIVE_LADDER.length; i++) {
    const offer = revive.offer();
    assert.equal(offer.kind, 'ad', `第 ${i + 1} 次应当是广告复活`);
    assert.equal(offer.kind === 'ad' && offer.tilesCleared, AD_REVIVE_LADDER[i]);

    const game = makeGame();
    // 造一个失败局面
    forceLose(game);
    const r = await revive.reviveByAd(game);
    assert.equal(r.ok, true);
    assert.equal(game.status, 'playing');
    platform.advance(60_000);
  }

  const after = revive.offer();
  assert.equal(after.kind, 'diamond', '广告梯度用完应当转钻石');
});

test('复活之后的局面重新保证有解', async () => {
  const { ads } = setup();
  const wallet = new LocalWallet(0);
  const revive = new ReviveController(ads, wallet);
  revive.startLevel();

  const game = makeGame(30);
  forceLose(game);
  assert.equal(game.status, 'lost');

  const r = await revive.reviveByAd(game);
  assert.equal(r.ok, true);
  assert.equal(game.status, 'playing');

  // 复活后重新跑一遍「保证有解」的检查：
  // 用洗牌重算一条路径，然后验证卡槽全程不溢出。
  assert.equal(game.reguarantee(), true, '复活后应当仍可重新保证有解');
});

test('广告无填充也能复活（玩家不为填充率买单）', async () => {
  const { ads } = setup({ errorRate: 1 });
  const revive = new ReviveController(ads, new LocalWallet(0));
  revive.startLevel();

  const game = makeGame();
  forceLose(game);
  const r = await revive.reviveByAd(game);
  assert.equal(r.ok, true);
  assert.equal(r.fallback, true);
  assert.equal(game.status, 'playing');
});

// ---------------------------------------------------------------- 道具

test('有免费次数时不弹广告，用完才转广告', async () => {
  const { ads } = setup();
  const shop = new ItemShop(ads, new LocalWallet(0));
  const game = makeGame(20); // 第 20 关每种道具免费 1 次

  assert.equal(shop.buttonState(game, 'xray'), 'free');
  assert.equal(shop.useFree(game, 'xray').ok, true);

  assert.equal(shop.buttonState(game, 'xray'), 'ad', '免费次数用完应当转广告');
  const r = await shop.useByAd(game, 'xray');
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.source, 'ad');
});

test('广告额度耗尽且钻石不足时道具置灰', async () => {
  const { platform, ads } = setup();
  const shop = new ItemShop(ads, new LocalWallet(0));
  const game = makeGame(20);

  fillSlot(game, 2);
  assert.equal(shop.useFree(game, 'pop3').ok, true);
  for (let i = 0; i < 2; i++) {
    fillSlot(game, 2);
    const r = await shop.useByAd(game, 'pop3');
    assert.equal(r.ok, true, `第 ${i + 1} 次广告换道具应当成功`);
    platform.advance(60_000);
  }
  fillSlot(game, 2); // 保证道具本身是可用的，置灰只能是额度原因
  assert.equal(shop.buttonState(game, 'pop3'), 'locked');
});

test('钻石够时降级到钻石购买而不是置灰', async () => {
  const { platform, ads } = setup();
  const shop = new ItemShop(ads, new LocalWallet(500));
  const game = makeGame(20);

  fillSlot(game, 2);
  shop.useFree(game, 'pop3');
  for (let i = 0; i < 2; i++) {
    fillSlot(game, 2);
    await shop.useByAd(game, 'pop3');
    platform.advance(60_000);
  }
  fillSlot(game, 2);
  assert.equal(shop.buttonState(game, 'pop3'), 'diamond');
  assert.equal(shop.useByDiamond(game, 'pop3').ok, true);
});

test('道具用下去没效果时直接置灰，不放行到广告', async () => {
  const { ads } = setup();
  const shop = new ItemShop(ads, new LocalWallet(500));
  const game = makeGame(20);

  // 刚开局：卡槽是空的，「移出」点下去什么都不会发生
  assert.equal(game.canUseItem('pop3'), false);
  assert.equal(shop.buttonState(game, 'pop3'), 'locked');

  const r = await shop.useByAd(game, 'pop3');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'no-effect');
  assert.equal(ads.stats().rewardedTotal, 0, '不该为一个无效道具播广告');

  // 一步都没走过，「撤销」同样无效
  assert.equal(game.canUseItem('undo'), false);
});

test('道具箱一次广告开出 3 个道具', async () => {
  const { ads } = setup();
  const shop = new ItemShop(ads, new LocalWallet(0));
  const game = makeGame(20);
  const before = game.itemCount('undo') + game.itemCount('pop3') + game.itemCount('shuffle') + game.itemCount('xray');

  const r = await shop.openBox(game, (pool) => pool[0]);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 3);

  const after = game.itemCount('undo') + game.itemCount('pop3') + game.itemCount('shuffle') + game.itemCount('xray');
  assert.equal(after - before, 3);
});

/** 往卡槽里塞 n 张不会互相消除的牌，让「移出」「撤销」这类道具变得可用。 */
function fillSlot(game: SheepGame, n: number): void {
  let guard = 0;
  while (game.slot.length < n && game.status === 'playing' && guard++ < 200) {
    const inSlot = new Set(game.slot.map((t) => game.effectiveIcon(t)));
    const next = game.freeTiles().find((t) => !inSlot.has(game.effectiveIcon(t)));
    if (!next) break;
    game.pick(next.id);
  }
}

/** 把游戏推到失败状态：一直点可点的牌，直到卡槽爆掉。 */
function forceLose(game: SheepGame): void {
  let guard = 0;
  while (game.status === 'playing' && guard++ < 5000) {
    const free = game.freeTiles();
    if (free.length === 0) break;
    // 刻意挑一张和卡槽里现有图标都不同的，尽快把卡槽填满
    const inSlot = new Set(game.slot.map((t) => game.effectiveIcon(t)));
    const bad = free.find((t) => !inSlot.has(game.effectiveIcon(t))) ?? free[0];
    game.pick(bad.id);
  }
}
