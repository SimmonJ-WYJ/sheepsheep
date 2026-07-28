/**
 * 浏览器 Demo。
 *
 * 用途是把「保证有解」「递减复活」「道具换广告」这几条设计跑给人看，
 * 不是最终美术。抖音正式包建议用 Cocos Creator 3.x 渲染，
 * 但核心逻辑（src/core、src/monetize）可以原样搬过去。
 *
 * 用法：npm run dev 之后浏览器打开 http://localhost:5173/src/web/
 */

import { createRng, seedFromString } from '../core/rng.ts';
import { makeLevel } from '../core/levels.ts';
import { SheepGame } from '../core/game.ts';
import type { ItemKind, Tile } from '../core/types.ts';
import { MockPlatform } from '../platform/mock.ts';
import { AdManager } from '../monetize/ad-manager.ts';
import { DEFAULT_AD_POLICY, PLACEHOLDER_AD_UNITS } from '../monetize/policy.ts';
import { LocalWallet, ReviveController } from '../monetize/revive.ts';
import { ItemShop } from '../monetize/item-shop.ts';

const ICONS = ['🌿', '🍎', '🥕', '🌻', '🍄', '🌰', '🍇', '🌾', '🫐', '🍋', '🥬', '🌶️'];
const TILE_PX = 34;

// Demo 里把静默期和新手关关掉，否则点半天看不到广告流程。
const DEMO_POLICY = {
  ...DEFAULT_AD_POLICY,
  coldStartQuietMs: 0,
  newUserQuietLevels: 0,
};

const platform = new MockPlatform({ endedRate: 1, errorRate: 0 });
// MockPlatform 的时钟不会自己走，这里挂上真实时间，冷却才有意义。
platform.now = () => Date.now();

const ads = new AdManager({
  platform,
  adUnits: PLACEHOLDER_AD_UNITS,
  policy: DEMO_POLICY,
  bootAt: 0,
  onEvent: (e) => log(e.blocked ? `[广告被拦] ${e.placement} — ${e.blocked}` : `[广告] ${e.placement} — ${JSON.stringify(e.outcome)}`),
});
const wallet = new LocalWallet(300);
const revive = new ReviveController(ads, wallet);
const shop = new ItemShop(ads, wallet);

// 支持 #level=50 直达某一关，方便调试和给人演示特定关卡
const hashLevel = Number(new URLSearchParams(location.hash.slice(1)).get('level'));
let levelId = Number.isFinite(hashLevel) && hashLevel > 0 ? hashLevel : 12;
let game: SheepGame;

const $ = (id: string): HTMLElement => document.getElementById(id)!;

function log(msg: string): void {
  const el = $('log');
  el.textContent = `${msg}\n${el.textContent}`.split('\n').slice(0, 14).join('\n');
}

function startLevel(id: number): void {
  levelId = id;
  game = new SheepGame({ level: makeLevel(id), rng: createRng(seedFromString(`demo-${id}-${Date.now()}`)) });
  ads.startLevel(id);
  revive.startLevel();
  $('overlay').style.display = 'none';
  log(`— 第 ${id} 关开始，共 ${game.tiles.length} 张牌 —`);
  render();
}

function tileLabel(t: Tile): string {
  return t.special === 'wild' ? '⭐' : (ICONS[t.icon % ICONS.length] ?? '?');
}

function render(): void {
  renderBoard();
  renderSlot();
  renderHud();
  renderItems();
  if (game.status !== 'playing') renderOverlay();
}

function renderBoard(): void {
  const board = $('board');
  board.innerHTML = '';

  let maxX = 0;
  let maxY = 0;
  for (const t of game.tiles) {
    maxX = Math.max(maxX, t.x);
    maxY = Math.max(maxY, t.y);
  }
  board.style.height = `${(maxY / 2 + 2) * TILE_PX + 20}px`;
  const offset = Math.max(0, (board.clientWidth - (maxX / 2 + 2) * TILE_PX) / 2);

  for (const t of [...game.tiles].sort((a, b) => a.layer - b.layer)) {
    if (t.state !== 'stack') continue;
    const free = game.canPick(t.id);
    const el = document.createElement('div');
    el.className = `tile${free ? ' free' : ''}${game.isRevealed(t.id) ? ' xray' : ''}`;
    el.style.left = `${offset + (t.x / 2) * TILE_PX}px`;
    el.style.top = `${(t.y / 2) * TILE_PX}px`;
    el.style.zIndex = String(t.layer + 1);
    // 被压住的牌默认看不清内容，这正是玩家要用「透视」的理由
    el.textContent = free || game.isRevealed(t.id) ? tileLabel(t) : '';
    if (free) el.onclick = () => onPick(t.id);
    board.appendChild(el);
  }
}

function renderSlot(): void {
  const slot = $('slot');
  slot.innerHTML = '';
  // 用了「+1 卡槽」之后格数会变，列数跟着走
  slot.style.gridTemplateColumns = `repeat(${game.slotCapacity}, 1fr)`;
  for (let i = 0; i < game.slotCapacity; i++) {
    const t = game.slot[i];
    const el = document.createElement('div');
    el.className = `cell${t ? ' filled' : ''}`;
    el.textContent = t ? tileLabel(t) : '';
    slot.appendChild(el);
  }
}

function renderHud(): void {
  $('hud').textContent =
    `第 ${levelId} 关 · 剩 ${game.remaining} 张 · 得分 ${game.score} · 连击 ${game.combo} · 💎 ${wallet.diamonds()}`;
}

const ITEM_LABEL: Record<ItemKind, string> = {
  undo: '↩ 撤销',
  pop3: '⬆ 移出',
  shuffle: '🔀 洗牌',
  xray: '👁 透视',
  slot: '➕ 卡槽',
};

function renderItems(): void {
  const bar = $('items');
  bar.innerHTML = '';
  for (const kind of Object.keys(ITEM_LABEL) as ItemKind[]) {
    const state = shop.buttonState(game, kind);
    const btn = document.createElement('button');
    const n = game.itemCount(kind);
    const suffix =
      state === 'free' ? ` ×${n}` : state === 'ad' ? ' 📺' : state === 'diamond' ? ' 💎' : '';
    btn.textContent = ITEM_LABEL[kind] + suffix;
    btn.className = state;
    btn.disabled = state === 'locked' || game.status !== 'playing';
    btn.onclick = () => onItem(kind, state);
    bar.appendChild(btn);
  }
}

function onPick(id: number): void {
  const r = game.pick(id);
  if (r.ok && r.cleared.length > 0 && r.combo > 1) log(`${r.combo} 连击！+${r.gained}`);
  render();
}

async function onItem(kind: ItemKind, state: string): Promise<void> {
  if (state === 'free') {
    shop.useFree(game, kind);
  } else if (state === 'ad') {
    log(`正在播放激励视频…（${ITEM_LABEL[kind]}）`);
    const r = await shop.useByAd(game, kind);
    if (r.ok && r.fallback) log('广告没填充上，按策略照样发放');
    else if (!r.ok) log(`未发放：${r.reason}`);
  } else if (state === 'diamond') {
    shop.useByDiamond(game, kind);
  }
  render();
}

function renderOverlay(): void {
  const ov = $('overlay');
  ov.style.display = 'flex';
  const box = $('overlay-box');
  box.innerHTML = '';

  const title = document.createElement('h2');
  title.textContent = game.status === 'won' ? '🎉 通关！' : '💀 卡槽满了';
  box.appendChild(title);

  if (game.status === 'won') {
    addBtn(box, '下一关', () => startLevel(levelId + 1));
    addBtn(box, '重玩本关', () => startLevel(levelId));
    return;
  }

  const offer = revive.offer();
  if (offer.kind === 'ad') {
    const p = document.createElement('p');
    p.textContent = `第 ${offer.attempt} 次复活：看一段视频，帮你清掉 ${offer.tilesCleared} 张`;
    box.appendChild(p);
    addBtn(box, '📺 看广告继续', async () => {
      const r = await revive.reviveByAd(game);
      if (r.ok) {
        log(`广告复活成功，清掉 ${r.tiles} 张${r.fallback ? '（兜底发放）' : ''}`);
        $('overlay').style.display = 'none';
        render();
      }
    });
  } else if (offer.kind === 'diamond') {
    const p = document.createElement('p');
    p.textContent = `广告复活次数用完了。花 ${offer.cost} 💎 清掉 ${offer.tilesCleared} 张？`;
    box.appendChild(p);
    addBtn(box, `💎 ${offer.cost} 复活`, () => {
      if (revive.reviveByDiamond(game).ok) {
        $('overlay').style.display = 'none';
        render();
      } else {
        log('钻石不足');
      }
    });
  } else {
    const p = document.createElement('p');
    p.textContent = offer.reason;
    box.appendChild(p);
  }

  addBtn(box, '重玩本关', () => startLevel(levelId));
}

function addBtn(parent: HTMLElement, text: string, fn: () => void): void {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = 'big';
  b.onclick = fn;
  parent.appendChild(b);
}

// 调试开关：模拟广告无填充，验证兜底逻辑
$('toggle-nofill').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  platform.behaviour.errorRate = on ? 1 : 0;
  log(on ? '已模拟「广告无填充」' : '广告恢复正常');
});

$('btn-hint').addEventListener('click', () => {
  const h = game.hint();
  if (!h) {
    log('已经偏离最优路径了 —— 用「洗牌」重算一条');
    return;
  }
  log(`提示：点 ${tileLabel(h)}`);
  const el = [...document.querySelectorAll<HTMLElement>('.tile')].find(
    (n) => n.style.left === `${(h.x / 2) * TILE_PX}px`,
  );
  el?.classList.add('hint');
  setTimeout(() => el?.classList.remove('hint'), 1200);
});

$('btn-restart').addEventListener('click', () => startLevel(levelId));
$('btn-prev').addEventListener('click', () => startLevel(Math.max(1, levelId - 1)));
$('btn-next').addEventListener('click', () => startLevel(levelId + 1));

startLevel(levelId);
