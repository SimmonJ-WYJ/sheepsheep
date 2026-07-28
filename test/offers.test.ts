import test from 'node:test';
import assert from 'node:assert/strict';

import { OfferEngine, emptyOfferState } from '../src/monetize/offers.ts';
import type { PlayerSignals } from '../src/monetize/offers.ts';
import { emptyEntitlements, hasMonthly, interstitialFree, SKUS, yuan } from '../src/monetize/iap.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

function signals(over: Partial<PlayerSignals> = {}): PlayerSignals {
  return {
    totalDays: 1,
    streakDays: 1,
    adsWatchedTotal: 0,
    adRevivesThisSession: 0,
    interstitialsSeen: 0,
    gems: 0,
    levelId: 20,
    failsThisLevel: 0,
    justBlockedByGems: false,
    ...over,
  };
}

/** 越过冷启动静默期的时间点。 */
const T = 10 * MIN;

function engine(availability: 'available' | 'unsupported-platform' = 'available') {
  return new OfferEngine({ availability }, 0, emptyOfferState());
}

// ─────────────────────────────────────────────── 平台约束

test('不能虚拟支付的设备上一个充值入口都不出（iOS 约束）', () => {
  const e = engine('unsupported-platform');
  assert.equal(e.canPay, false);
  const d = e.decide(signals({ failsThisLevel: 9, justBlockedByGems: true }), emptyEntitlements(), T);
  assert.equal(d.show, false);
  assert.equal(d.show === false && d.reason, 'payment-unavailable');
});

// ─────────────────────────────────────────────── 新手保护

test('冷启动静默期内不弹任何充值', () => {
  const e = engine();
  const d = e.decide(signals({ failsThisLevel: 5 }), emptyEntitlements(), 60_000);
  assert.equal(d.show, false);
  assert.equal(d.show === false && d.reason, 'all-gated');
});

test('前 8 关不弹任何充值', () => {
  const e = engine();
  const d = e.decide(signals({ levelId: 5, failsThisLevel: 5 }), emptyEntitlements(), T);
  assert.equal(d.show, false);
});

test('没有任何需求信号时什么都不弹', () => {
  const e = engine();
  const d = e.decide(signals(), emptyEntitlements(), T);
  assert.equal(d.show, false);
  assert.equal(d.show === false && d.reason, 'nothing-triggered');
});

// ─────────────────────────────────────────────── 各触发点

test('首充在「第一次广告复活之后」才弹，不是一进游戏就弹', () => {
  const e = engine();
  // 只是失败、还没看广告复活 → 不弹首充
  const before = e.decide(signals({ failsThisLevel: 1 }), emptyEntitlements(), T);
  assert.equal(before.show, false, '没看广告复活过就不该弹首充');

  // 看完广告复活了 → 弹
  const after = e.decide(signals({ adRevivesThisSession: 1 }), emptyEntitlements(), T);
  assert.equal(after.show, true);
  assert.equal(after.show === true && after.offer.id, 'starter');
});

test('已经付过费就不再弹首充', () => {
  const e = engine();
  const ent = { ...emptyEntitlements(), hasPaid: true };
  const d = e.decide(signals({ adRevivesThisSession: 2 }), ent, T);
  assert.equal(d.show === true && d.offer.id === 'starter', false);
});

test('同一关连输 3 次弹卡关礼包，且优先级最高', () => {
  const e = engine();
  // 同时满足卡关 + 首充两个条件，应当只弹优先级更高的卡关包
  const d = e.decide(signals({ failsThisLevel: 3, adRevivesThisSession: 1 }), emptyEntitlements(), T);
  assert.equal(d.show, true);
  assert.equal(d.show === true && d.offer.id, 'stuck_pack');
});

test('钻石不够导致操作失败的那一刻弹钻石包', () => {
  const e = engine();
  const d = e.decide(signals({ justBlockedByGems: true }), emptyEntitlements(), T);
  assert.equal(d.show, true);
  assert.equal(d.show === true && d.offer.id, 'gems');
});

test('月卡在「累计看 15 支广告」或「连登 3 天」时弹', () => {
  const e1 = engine();
  assert.equal(e1.decide(signals({ adsWatchedTotal: 14 }), emptyEntitlements(), T).show, false);

  const e2 = engine();
  const byAds = e2.decide(signals({ adsWatchedTotal: 15 }), emptyEntitlements(), T);
  assert.equal(byAds.show === true && byAds.offer.id, 'monthly');

  const e3 = engine();
  const byStreak = e3.decide(signals({ streakDays: 3 }), emptyEntitlements(), T);
  assert.equal(byStreak.show === true && byStreak.offer.id, 'monthly');
});

test('已有月卡就不再弹月卡', () => {
  const e = engine();
  const ent = { ...emptyEntitlements(), monthlyUntil: T + 10 * 24 * HOUR };
  const d = e.decide(signals({ adsWatchedTotal: 40 }), ent, T);
  assert.equal(d.show === true && d.offer.id === 'monthly', false);
});

test('被插屏打断 3 次后给「去广告」的出口', () => {
  const e = engine();
  const d = e.decide(signals({ interstitialsSeen: 3 }), emptyEntitlements(), T);
  assert.equal(d.show, true);
  assert.equal(d.show === true && d.offer.id, 'no_interstitial');
});

// ─────────────────────────────────────────────── 频控与尊重

test('同一个弹窗在冷却期内不会重复弹', () => {
  const e = engine();
  const s = signals({ justBlockedByGems: true });
  const first = e.decide(s, emptyEntitlements(), T);
  assert.equal(first.show, true);
  e.markShown('gems', T);

  // 冷却 10 分钟内
  assert.equal(e.decide(s, emptyEntitlements(), T + 5 * MIN).show, false);
  // 冷却过后可以再弹
  assert.equal(e.decide(s, emptyEntitlements(), T + 11 * MIN).show, true);
});

test('玩家关掉够多次之后永久不再打扰', () => {
  const e = engine();
  const s = signals({ interstitialsSeen: 5 });
  // no_interstitial 的 maxDismiss = 2
  for (let i = 0; i < 2; i++) {
    const d = e.decide(s, emptyEntitlements(), T + i * 24 * HOUR);
    assert.equal(d.show, true, `第 ${i + 1} 次应当还会弹`);
    e.markShown('no_interstitial', T + i * 24 * HOUR);
    e.markDismissed('no_interstitial');
  }
  const after = e.decide(s, emptyEntitlements(), T + 10 * 24 * HOUR);
  assert.equal(
    after.show === true && after.offer.id === 'no_interstitial',
    false,
    '关掉 2 次之后就该永久闭嘴了',
  );
});

test('展示次数到上限后不再弹', () => {
  const e = engine();
  const s = signals({ failsThisLevel: 4 });
  let t = T;
  for (let i = 0; i < 6; i++) { // stuck_pack maxShows = 6
    const d = e.decide(s, emptyEntitlements(), t);
    assert.equal(d.show === true && d.offer.id, 'stuck_pack', `第 ${i + 1} 次`);
    e.markShown('stuck_pack', t);
    t += 31 * MIN;
  }
  const after = e.decide(s, emptyEntitlements(), t);
  assert.equal(after.show === true && after.offer.id === 'stuck_pack', false);
});

test('高优先级弹窗被频控挡住时，会退到次优的那个', () => {
  const e = engine();
  // 卡关（100）+ 首充（80）同时成立
  const s = signals({ failsThisLevel: 3, adRevivesThisSession: 1 });
  const first = e.decide(s, emptyEntitlements(), T);
  assert.equal(first.show === true && first.offer.id, 'stuck_pack');
  e.markShown('stuck_pack', T);

  // 卡关包进冷却，此时应当弹首充而不是什么都不弹
  const second = e.decide(s, emptyEntitlements(), T + MIN);
  assert.equal(second.show, true);
  assert.equal(second.show === true && second.offer.id, 'starter');
});

// ─────────────────────────────────────────────── 商品与权益

test('钻石包推荐能覆盖缺口的最小一档', () => {
  assert.equal(OfferEngine.gemTierFor(60), 'gems_s');
  assert.equal(OfferEngine.gemTierFor(300), 'gems_s');
  assert.equal(OfferEngine.gemTierFor(301), 'gems_m');
  assert.equal(OfferEngine.gemTierFor(5000), 'gems_l');
  assert.equal(OfferEngine.gemTierFor(99999), 'gems_xl');
});

test('首档钻石包必须买得起至少 2 次复活，否则价值感立不住', () => {
  // 复活钻石梯度是 60 / 120 / 240
  assert.ok(
    (SKUS.gems_s.gems ?? 0) >= 60 + 120,
    `首档 ${SKUS.gems_s.gems} 钻应当至少够前两次复活（180 钻）`,
  );
});

test('钻石包越大单价越便宜', () => {
  const tiers = [SKUS.gems_s, SKUS.gems_m, SKUS.gems_l, SKUS.gems_xl];
  const perFen = tiers.map((s) => (s.gems ?? 0) / s.priceFen);
  for (let i = 1; i < perFen.length; i++) {
    assert.ok(perFen[i] > perFen[i - 1], `${tiers[i].id} 的性价比应当高于 ${tiers[i - 1].id}`);
  }
});

test('月卡和去广告都只免插屏，不动激励视频', () => {
  const now = 1_000_000;
  const monthly = { ...emptyEntitlements(), monthlyUntil: now + 10 * 24 * HOUR };
  const removed = { ...emptyEntitlements(), noInterstitial: true };

  assert.equal(interstitialFree(monthly, now), true);
  assert.equal(interstitialFree(removed, now), true);
  assert.equal(interstitialFree(emptyEntitlements(), now), false);

  // 权益里不存在「去掉激励视频」这种东西 —— 那是玩家自愿的收益来源
  assert.equal('rewardedFree' in monthly, false);
});

test('月卡到期后权益失效', () => {
  const now = 1_000_000;
  const ent = { ...emptyEntitlements(), monthlyUntil: now - 1 };
  assert.equal(hasMonthly(ent, now), false);
  assert.equal(interstitialFree(ent, now), false);
});

test('价格展示不出现多余小数', () => {
  assert.equal(yuan(SKUS.starter), '6');
  assert.equal(yuan(SKUS.monthly), '30');
  assert.equal(yuan(SKUS.no_interstitial), '18');
  assert.equal(yuan(SKUS.stuck_pack), '12');
});

// ───────────────────────────── 权益与广告闸门的联动

test('买了月卡之后插屏不再出，但激励视频照常可用', async () => {
  const { MockPlatform } = await import('../src/platform/mock.ts');
  const { AdManager } = await import('../src/monetize/ad-manager.ts');
  const { DEFAULT_AD_POLICY, PLACEHOLDER_AD_UNITS } = await import('../src/monetize/policy.ts');

  const platform = new MockPlatform();
  let entitled = false;
  const ads = new AdManager({
    platform,
    adUnits: PLACEHOLDER_AD_UNITS,
    policy: DEFAULT_AD_POLICY,
    bootAt: 0,
    isInterstitialFree: () => entitled,
  });
  platform.advance(DEFAULT_AD_POLICY.coldStartQuietMs + 1000);
  ads.startLevel(20);

  // 没买之前插屏是允许的
  assert.equal(ads.check('level_start').allowed, true);

  entitled = true;
  const gate = ads.check('level_start');
  assert.equal(gate.allowed, false, '买了月卡之后插屏应当不出');
  assert.equal(gate.allowed === false && gate.reason, 'entitled');

  // 关键：激励视频不受影响 —— 付费用户依然能看广告换道具，
  // 也依然在贡献广告收入
  assert.equal(ads.check('revive').allowed, true, '激励视频不该被权益去掉');
  assert.equal(ads.check('item_addPen').allowed, true);
});

test('买了去广告之后 banner 也不出', async () => {
  const { MockPlatform } = await import('../src/platform/mock.ts');
  const { AdManager } = await import('../src/monetize/ad-manager.ts');
  const { PLACEHOLDER_AD_UNITS } = await import('../src/monetize/policy.ts');

  const platform = new MockPlatform();
  const ads = new AdManager({
    platform,
    adUnits: PLACEHOLDER_AD_UNITS,
    bootAt: 0,
    isInterstitialFree: () => true,
  });
  ads.startLevel(20);
  const gate = ads.check('settle_banner');
  assert.equal(gate.allowed, false);
  assert.equal(gate.allowed === false && gate.reason, 'entitled');
});
