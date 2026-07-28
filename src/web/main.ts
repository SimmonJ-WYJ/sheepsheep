/**
 * 浏览器 Demo。
 *
 * 用途是把玩法、可解性保证、广告复活/道具流程跑给人看，不是最终美术。
 * 抖音正式包建议用 Cocos Creator 3.x 渲染，但 src/core 和 src/monetize
 * 可以原样搬过去（纯 TS，无 DOM 依赖）。
 *
 * 交互：点一个栏位选中 → 点另一个栏位放下。再点自己取消。
 *
 * 用法：npm run dev
 */

import { createRng, seedFromString } from '../core/rng.ts';
import { makeLevel } from '../core/levels.ts';
import { SortGame } from '../core/game.ts';
import type { ItemKind } from '../core/types.ts';
import { MockPlatform } from '../platform/mock.ts';
import { AdManager } from '../monetize/ad-manager.ts';
import { DEFAULT_AD_POLICY, PLACEHOLDER_AD_UNITS } from '../monetize/policy.ts';
import { LocalWallet, ReviveController } from '../monetize/revive.ts';
import { ItemShop } from '../monetize/item-shop.ts';

/**
 * 品种外观。
 *
 * **每个品种必须同时有独立的颜色和独立的动物** ——
 * 第一版全用 🐑/🐏/🐐 轮换配浅色底，到第 60 关有 8 个品种时
 * 「浅绿的羊」和「青色的羊」根本分不出来，纯靠颜色区分对色弱用户也不友好。
 * 换成一眼能认出的农场动物，颜色只作为辅助。
 */
const BREEDS: { color: string; face: string }[] = [
  { color: '#fdf3dc', face: '🐑' },
  { color: '#ffd166', face: '🐤' },
  { color: '#5aa9e6', face: '🐮' },
  { color: '#ef8a87', face: '🐷' },
  { color: '#7ac74f', face: '🐸' },
  { color: '#b07de0', face: '🐰' },
  { color: '#ff9f45', face: '🦊' },
  { color: '#3fc1c9', face: '🐴' },
  { color: '#e07a9f', face: '🦙' },
];

// Demo 里把静默期和新手关关掉，否则点半天看不到广告流程。
const DEMO_POLICY = { ...DEFAULT_AD_POLICY, coldStartQuietMs: 0, newUserQuietLevels: 0 };

const platform = new MockPlatform({ endedRate: 1, errorRate: 0 });
platform.now = () => Date.now(); // MockPlatform 的时钟不会自己走，挂上真实时间

const ads = new AdManager({
  platform,
  adUnits: PLACEHOLDER_AD_UNITS,
  policy: DEMO_POLICY,
  bootAt: 0,
  onEvent: (e) =>
    log(
      e.blocked
        ? `· 广告被频控挡下：${e.placement} (${e.blocked})`
        : `· 广告 ${e.placement} → ${JSON.stringify(e.outcome)}`,
    ),
});
const wallet = new LocalWallet(300);
const revive = new ReviveController(ads, wallet);
const shop = new ItemShop(ads, wallet);

const hashLevel = Number(new URLSearchParams(location.hash.slice(1)).get('level'));
let levelId = Number.isFinite(hashLevel) && hashLevel > 0 ? hashLevel : 1;
let game: SortGame;
/** 当前选中的栏位（拿起了一群羊）。 */
let selected: number | null = null;
/** 提示高亮的一步。 */
let hinted: { from: number; to: number } | null = null;
/** 上一步刚落下的栏位，用于播放落地动画。 */
let justLanded: number | null = null;

const $ = (id: string): HTMLElement => document.getElementById(id)!;

function log(msg: string): void {
  const el = $('log');
  el.textContent = `${msg}\n${el.textContent}`.split('\n').slice(0, 10).join('\n');
}

function startLevel(id: number): void {
  levelId = Math.max(1, id);
  game = new SortGame({
    level: makeLevel(levelId),
    rng: createRng(seedFromString(`demo-${levelId}-${Date.now()}`)),
  });
  ads.startLevel(levelId);
  revive.startLevel();
  selected = null;
  hinted = null;
  justLanded = null;
  $('overlay').classList.remove('show');
  log(`— 第 ${levelId} 关：${game.remaining} 只羊 / ${game.penCount} 栏 / 最优 ${game.parMoves} 步 —`);
  render();
}

// -------------------------------------------------------------------- 渲染

function render(): void {
  renderHud();
  renderPens();
  renderItems();
  renderWarn();
  if (game.status !== 'playing') renderOverlay();
}

function renderHud(): void {
  $('level-chip').textContent = game.level.name;
  $('left').textContent = String(game.remaining);
  $('score').textContent = String(game.score);
  $('gems').textContent = String(wallet.diamonds());
}

function renderPens(): void {
  const host = $('pens');
  host.innerHTML = '';

  // 栏位多的时候自动换行成两排，避免手机上被压得又细又高
  const perRow = game.penCount <= 6 ? game.penCount : Math.ceil(game.penCount / 2);
  host.style.gridTemplateColumns = `repeat(${perRow}, 1fr)`;

  const run = selected !== null ? game.topRunOf(selected) : null;

  for (let i = 0; i < game.penCount; i++) {
    const pen = game.pens[i];
    const el = document.createElement('div');
    el.className = 'pen';
    // 高度固定成容量，空栏位也占位 —— 否则栏位会随羊数抖动
    el.style.minHeight = `${game.penCapacity * 37 + 14}px`;

    if (pen.length === 0) el.classList.add('empty');
    if (selected === i) el.classList.add('selected');
    if (selected !== null && selected !== i && game.canMove(selected, i)) {
      el.classList.add('droppable');
    }
    if (hinted && (hinted.from === i || hinted.to === i)) el.classList.add('hinted');

    const topRunCount = run && selected === i ? run.count : 0;

    pen.forEach((breed, idx) => {
      const s = document.createElement('div');
      s.className = 'sheep';
      // 栏口那一群一起抬起，让「会被整群赶走」这件事看得见
      if (idx >= pen.length - topRunCount) s.classList.add('lifted');
      if (justLanded === i && idx === pen.length - 1) s.classList.add('landing');
      const look = BREEDS[breed % BREEDS.length];
      s.style.background = look.color;
      s.textContent = look.face;
      el.appendChild(s);
    });

    el.onclick = () => onPenClick(i);
    host.appendChild(el);
  }
  justLanded = null;
}

const ITEM_META: Record<ItemKind, { glyph: string; label: string }> = {
  undo: { glyph: '↩️', label: '撤销' },
  addPen: { glyph: '🚧', label: '加栏' },
  hint: { glyph: '💡', label: '提示' },
  dog: { glyph: '🐕', label: '牧羊犬' },
  sort: { glyph: '🔄', label: '重排' },
};

function renderItems(): void {
  const host = $('items');
  host.innerHTML = '';
  for (const kind of Object.keys(ITEM_META) as ItemKind[]) {
    const state = shop.buttonState(game, kind);
    const meta = ITEM_META[kind];
    const btn = document.createElement('button');
    btn.className = `item ${state}`;
    btn.disabled = state === 'locked' || game.status !== 'playing';

    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = meta.glyph;
    const label = document.createElement('span');
    label.textContent = meta.label;
    btn.append(glyph, label);

    if (state !== 'locked') {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent =
        state === 'free' ? String(game.itemCount(kind)) : state === 'ad' ? '📺' : '💎';
      btn.appendChild(badge);
    }

    btn.onclick = () => onItem(kind, state);
    host.appendChild(btn);
  }
}

/**
 * 无解提示条。
 *
 * 局面已经赢不了的时候**主动告诉玩家**，而不是让他继续白点十几下才发现完了 ——
 * 这是《羊了个羊》最气人的地方之一，我们有求解器，没有理由不说。
 */
function renderWarn(): void {
  const el = $('warn');
  if (game.status === 'playing' && !game.isSolvable()) {
    el.textContent = '⚠️ 这个局面已经打不通了 —— 用「撤销」退回去，或者「重排」换一个保证有解的局面。';
    el.classList.add('show');
  } else {
    el.classList.remove('show');
  }
}

function flashCombo(n: number, gained: number): void {
  const el = $('combo');
  el.textContent = n > 1 ? `${n} 连击! +${gained}` : `+${gained}`;
  el.classList.remove('pop');
  void el.offsetWidth; // 强制重排，让动画能重播
  el.classList.add('pop');
}

// -------------------------------------------------------------------- 交互

function onPenClick(i: number): void {
  if (game.status !== 'playing') return;
  hinted = null;

  if (selected === null) {
    if (game.pens[i].length === 0) return; // 空栏没东西可拿
    selected = i;
    render();
    return;
  }
  if (selected === i) {
    selected = null; // 再点一次取消
    render();
    return;
  }

  const from = selected;
  const r = game.move(from, i);
  selected = null;

  if (!r.ok) {
    // 落点不合法：如果点的是另一群羊，就改成选中它，手感更顺
    if (game.pens[i].length > 0) selected = i;
    render();
    return;
  }

  justLanded = i;
  if (r.shipped !== null) {
    flashCombo(r.combo, r.gained);
    animateShipped(i);
  }
  render();
}

/** 出栏动画：先让那一栏的羊跑走，再重绘。 */
function animateShipped(penIndex: number): void {
  const penEl = $('pens').children[penIndex];
  if (!penEl) return;
  for (const s of Array.from(penEl.children)) s.classList.add('leaving');
}

async function onItem(kind: ItemKind, state: string): Promise<void> {
  selected = null;

  if (state === 'free') {
    shop.useFree(game, kind);
  } else if (state === 'ad') {
    log(`正在播放激励视频…（${ITEM_META[kind].label}）`);
    const r = await shop.useByAd(game, kind);
    if (r.ok && r.fallback) log('广告没填充上，按策略照样发放');
    else if (!r.ok) log(`未发放：${r.reason}`);
  } else if (state === 'diamond') {
    const r = shop.useByDiamond(game, kind);
    if (!r.ok) log(`购买失败：${r.reason}`);
  }

  // 提示道具要把结果画出来
  if (kind === 'hint') {
    const h = game.hint();
    if (h) {
      hinted = { from: h.from, to: h.to };
      log(`提示：把第 ${h.from + 1} 栏栏口的 ${h.count} 只赶到第 ${h.to + 1} 栏`);
    }
  }
  render();
}

// -------------------------------------------------------------------- 结算

function renderOverlay(): void {
  const ov = $('overlay');
  ov.classList.add('show');
  const sheet = $('sheet');
  sheet.innerHTML = '';

  const emoji = document.createElement('div');
  emoji.className = 'big-emoji';
  const title = document.createElement('h2');
  const desc = document.createElement('p');

  if (game.status === 'won') {
    emoji.textContent = '🎉';
    const stars = document.createElement('div');
    stars.className = 'stars';
    stars.textContent = '⭐'.repeat(game.stars()) + '☆'.repeat(3 - game.stars());
    title.textContent = '全部出栏！';
    desc.textContent = `用了 ${game.moves} 步（最优 ${game.parMoves} 步）· 得分 ${game.score}`;
    sheet.append(emoji, stars, title, desc);
    addBtn(sheet, '下一关', () => startLevel(levelId + 1));
    addBtn(sheet, '重玩本关', () => startLevel(levelId), true);
    return;
  }

  emoji.textContent = '😵';
  title.textContent = '羊圈塞满了';
  const offer = revive.offer();

  if (offer.kind === 'ad') {
    desc.textContent = `第 ${offer.attempt} 次复活：看一段视频，给你 ${offer.extraPens} 个空栏位，并保证接下来打得通。`;
    sheet.append(emoji, title, desc);
    addBtn(sheet, '📺 看广告继续', async () => {
      const r = await revive.reviveByAd(game);
      if (r.ok) {
        log(`广告复活成功，+${r.pens} 个空栏位${r.fallback ? '（兜底发放）' : ''}`);
        $('overlay').classList.remove('show');
        render();
      } else {
        log('复活失败');
      }
    });
  } else if (offer.kind === 'diamond') {
    desc.textContent = `广告复活次数用完了。花 ${offer.cost} 💎 换 ${offer.extraPens} 个空栏位？`;
    sheet.append(emoji, title, desc);
    addBtn(sheet, `💎 ${offer.cost} 复活`, () => {
      const r = revive.reviveByDiamond(game);
      if (r.ok) {
        $('overlay').classList.remove('show');
        render();
      } else {
        log('钻石不足');
      }
    });
  } else {
    desc.textContent = offer.reason;
    sheet.append(emoji, title, desc);
  }

  addBtn(sheet, '重玩本关', () => startLevel(levelId), true);
}

function addBtn(parent: HTMLElement, text: string, fn: () => void, ghost = false): void {
  const b = document.createElement('button');
  b.className = ghost ? 'btn ghost' : 'btn';
  b.textContent = text;
  b.onclick = fn;
  parent.appendChild(b);
}

// -------------------------------------------------------------------- 绑定

$('toggle-nofill').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  platform.behaviour.errorRate = on ? 1 : 0;
  log(on ? '已模拟「广告无填充」—— 奖励应当照样发放' : '广告恢复正常');
});
$('btn-restart').addEventListener('click', () => startLevel(levelId));
$('btn-prev').addEventListener('click', () => startLevel(levelId - 1));
$('btn-next').addEventListener('click', () => startLevel(levelId + 1));

startLevel(levelId);
