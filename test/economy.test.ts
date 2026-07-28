import test from 'node:test';
import assert from 'node:assert/strict';

import { MockPlatform } from '../src/platform/mock.ts';
import { AdManager } from '../src/monetize/ad-manager.ts';
import { DEFAULT_AD_POLICY, PLACEHOLDER_AD_UNITS } from '../src/monetize/policy.ts';
import { DIAMOND_REVIVE_LADDER, ReviveController } from '../src/monetize/revive.ts';
import { OfferEngine, emptyOfferState } from '../src/monetize/offers.ts';
import { emptyEntitlements } from '../src/monetize/iap.ts';
import {
  EARN,
  GemLedger,
  dailyEarnCeiling,
  reviveCostThrough,
} from '../src/monetize/economy.ts';
import { createRng } from '../src/core/rng.ts';
import { makeLevel } from '../src/core/levels.ts';
import { SortGame } from '../src/core/game.ts';

const DAY = 24 * 60 * 60 * 1000;

function ledger(now: () => number, initial = 0): GemLedger {
  const p = new MockPlatform();
  return new GemLedger(p.storage, now, initial);
}

// ───────────────────────── 核心平衡：免费玩家不会被硬墙拦住

test('每天免费获取的钻石够买前两档复活（不会被硬墙拦住）', () => {
  const need = reviveCostThrough(2); // 60 + 120
  assert.ok(
    dailyEarnCeiling() >= need,
    `每日免费上限 ${dailyEarnCeiling()} 钻应当 ≥ 前两档复活 ${need} 钻 —— ` +
      `否则不充值的用户（iOS 上是全部用户）会在第 3 次复活撞上硬墙`,
  );
});

test('但也买不起三档全买，最深那档仍然有价值', () => {
  const all = reviveCostThrough(DIAMOND_REVIVE_LADDER.length); // 60+120+240
  assert.ok(
    dailyEarnCeiling() < all,
    `每日免费上限 ${dailyEarnCeiling()} 钻应当 < 全部三档 ${all} 钻 —— ` +
      `否则免费无限复活，关卡难度和内购都失去意义`,
  );
});

test('看广告换钻石是免费玩家最大的单一来源', () => {
  const caps = Object.values(EARN)
    .filter((r) => r.source !== 'streak_bonus')
    .sort((a, b) => b.dailyCap - a.dailyCap);
  assert.equal(
    caps[0].source,
    'ad_for_gems',
    '不能充值的用户只剩广告这条路，它必须是最大的来源',
  );
});

// ───────────────────────── 账本行为

test('每日上限会截断超额领取', () => {
  const clock = { t: 0 };
  const l = ledger(() => clock.t);

  // 通关星星每颗 5 钻，每日上限 60 → 最多 12 颗星
  const got = l.earn('level_stars', 20); // 想拿 100
  assert.equal(got, 60, '应当被每日上限截到 60');
  assert.equal(l.earn('level_stars', 3), 0, '已达上限再领应当拿到 0');
  assert.equal(l.diamonds(), 60);
});

test('跨天之后额度重置', () => {
  const clock = { t: 0 };
  const l = ledger(() => clock.t);
  l.earn('daily_signin');
  assert.equal(l.remainingToday('daily_signin'), 0);

  clock.t += DAY;
  assert.equal(l.remainingToday('daily_signin'), EARN.daily_signin.dailyCap);
  assert.equal(l.earn('daily_signin'), EARN.daily_signin.gems);
  assert.equal(l.diamonds(), EARN.daily_signin.gems * 2, '余额跨天不清零，只有当日额度重置');
});

test('余额不足时花不出去，且不会变成负数', () => {
  const l = ledger(() => 0, 50);
  assert.equal(l.spend(60), false);
  assert.equal(l.diamonds(), 50);
  assert.equal(l.spend(50), true);
  assert.equal(l.diamonds(), 0);
  assert.equal(l.spend(1), false);
});

test('账本会持久化，重建之后余额还在', () => {
  const p = new MockPlatform();
  const clock = { t: 0 };
  const a = new GemLedger(p.storage, () => clock.t);
  a.earn('daily_signin');
  a.earn('ad_for_gems');
  const balance = a.diamonds();
  assert.ok(balance > 0);

  // 同一个 storage 重建 —— 模拟杀进程重进
  const b = new GemLedger(p.storage, () => clock.t);
  assert.equal(b.diamonds(), balance);
  assert.equal(b.remainingToday('daily_signin'), 0, '当日额度也要一起持久化，不然重进就能刷');
});

// ───────────────────────── 不能充值的设备：完整路径

test('不能充值的设备上，玩家靠免费钻石也能走完复活梯度前两档', async () => {
  const platform = new MockPlatform({ payment: 'unsupported-platform' });
  const ads = new AdManager({
    platform,
    adUnits: PLACEHOLDER_AD_UNITS,
    policy: DEFAULT_AD_POLICY,
    bootAt: 0,
  });
  platform.advance(DEFAULT_AD_POLICY.coldStartQuietMs + 1000);

  const clock = { t: platform.now() };
  const wallet = new GemLedger(platform.storage, () => clock.t);

  // 模拟一天的日常收入
  wallet.earn('daily_signin');
  wallet.earn('sidebar_visit');
  wallet.earn('daily_challenge');
  wallet.earn('level_stars', 12);
  for (let i = 0; i < 4; i++) wallet.earn('ad_for_gems');

  assert.ok(
    wallet.diamonds() >= reviveCostThrough(2),
    `一天日常收入 ${wallet.diamonds()} 钻应当够前两档复活`,
  );

  // 充值入口一个都不出
  const offers = new OfferEngine(
    { availability: platform.paymentAvailability() },
    0,
    emptyOfferState(),
  );
  assert.equal(offers.canPay, false);

  // 但钻石复活照样能用
  const revive = new ReviveController(ads, wallet);
  revive.startLevel();
  // 先把两次广告复活用掉
  for (let i = 0; i < 2; i++) {
    const g = makeLostGame();
    const r = await revive.reviveByAd(g);
    assert.equal(r.ok, true);
    platform.advance(60_000);
    clock.t = platform.now();
  }
  const offer = revive.offer();
  assert.equal(offer.kind, 'diamond', '广告梯度用完应当转钻石');

  const g = makeLostGame();
  const paid = revive.reviveByDiamond(g);
  assert.equal(paid.ok, true, '不能充值的用户也应当能用攒来的钻石复活');
  assert.equal(g.status, 'playing');
});

test('看广告换钻石每日 4 次封顶，与账本上限一致', async () => {
  const platform = new MockPlatform();
  const ads = new AdManager({
    platform,
    adUnits: PLACEHOLDER_AD_UNITS,
    policy: DEFAULT_AD_POLICY,
    bootAt: 0,
  });
  platform.advance(DEFAULT_AD_POLICY.coldStartQuietMs + 1000);
  ads.startLevel(20);

  const clock = { t: platform.now() };
  const wallet = new GemLedger(platform.storage, () => clock.t);

  let granted = 0;
  for (let i = 0; i < 8; i++) {
    const r = await ads.request('gems_for_ad');
    if (r.granted) {
      granted++;
      wallet.earn('ad_for_gems');
    }
    platform.advance(60_000);
    clock.t = platform.now();
  }
  assert.equal(granted, 4, '广告位每日上限 4 次');
  assert.equal(
    wallet.diamonds(),
    EARN.ad_for_gems.dailyCap,
    '账本的每日上限应当正好等于 4 次广告的产出，两处数值不能打架',
  );
});

/** 造一个已经判负的局面。 */
function makeLostGame(): SortGame {
  for (let s = 0; s < 80; s++) {
    const game = new SortGame({ level: makeLevel(50), rng: createRng(7000 + s), now: () => 0 });
    const rng = createRng(s * 6151 + 5);
    let guard = 0;
    while (game.status === 'playing' && guard++ < 3000) {
      const moves = game.legalMoves();
      if (!moves.length) break;
      const m = moves[rng.int(moves.length)];
      game.move(m.from, m.to);
    }
    if (game.status === 'lost') return game;
  }
  throw new Error('没能构造出失败局面');
}
