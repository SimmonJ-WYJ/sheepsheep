import type { Ctx2D } from './host.ts';
import type { BoardLayout, PenRect, Rect } from './layout.ts';
import { animalRect, layoutBoard, layoutRow } from './layout.ts';
import { BREEDS, T, font } from './theme.ts';
import { background, chip, clay, fillRound, groove, strokeRound, text } from './draw.ts';
import type { ItemKind, Pens } from '../core/types.ts';

/**
 * 一帧的绘制 + 命中区域。
 *
 * 设计上刻意做成**无状态的纯绘制**：`draw()` 只读 ViewModel，
 * 顺手把这一帧的命中区域记在 `HitRegions` 里给输入层用。
 * 这样「画出来的」和「点得到的」永远一致，不会出现按钮挪了位置但点击区没跟上的经典 bug。
 */

export const ITEM_ORDER: ItemKind[] = ['undo', 'addPen', 'hint', 'dog', 'sort'];

const ITEM_META: Record<ItemKind, { glyph: string; label: string }> = {
  undo: { glyph: '↩️', label: '撤销' },
  addPen: { glyph: '🚧', label: '加栏' },
  hint: { glyph: '💡', label: '提示' },
  dog: { glyph: '🐕', label: '牧羊犬' },
  sort: { glyph: '🔄', label: '重排' },
};

export type ItemButtonState = 'free' | 'ad' | 'diamond' | 'locked';

export interface OverlayButton {
  id: string;
  label: string;
  primary: boolean;
}

export interface ViewModel {
  levelName: string;
  remaining: number;
  score: number;
  gems: number;
  moves: number;
  parMoves: number;
  pens: Pens;
  capacity: number;
  /** 选中的栏位下标，null 表示没选 */
  selected: number | null;
  /** 栏口那一群的只数（选中时才有意义） */
  liftCount: number;
  /** 可以落脚的栏位 */
  droppable: number[];
  /** 提示高亮的两个栏位 */
  hinted: [number, number] | null;
  /** 局面已经赢不了了 —— 顶部要挂警告条 */
  unsolvable: boolean;
  items: { kind: ItemKind; state: ItemButtonState; count: number }[];
  /** 结算 / 复活弹窗 */
  overlay: {
    emoji: string;
    title: string;
    desc: string;
    stars?: number;
    buttons: OverlayButton[];
  } | null;
  /** 飘字（连击 / 得分） */
  toast: { text: string; ageMs: number } | null;
  /** 正在播广告的遮罩 */
  busy: string | null;
}

export interface HitRegions {
  pens: PenRect[];
  items: { kind: ItemKind; rect: Rect }[];
  overlayButtons: { id: string; rect: Rect }[];
}

const HUD_H = 30;
const WARN_H = 40;
const ITEM_H = 58;

export function draw(
  ctx: Ctx2D,
  vm: ViewModel,
  view: { width: number; height: number; safeTop: number; safeBottom: number },
): HitRegions {
  const { width: W, height: H } = view;
  const hits: HitRegions = { pens: [], items: [], overlayButtons: [] };

  background(ctx, W, H);

  const pad = 14;
  let y = view.safeTop + 12;

  // ── HUD
  drawHud(ctx, vm, pad, y, W - pad * 2);
  y += HUD_H + 12;

  // ── 无解警告条
  if (vm.unsolvable) {
    const r: Rect = { x: pad, y, w: W - pad * 2, h: WARN_H };
    fillRound(ctx, r, 12, '#ffe0b2');
    text(ctx, '⚠️ 这个局面打不通了 —— 撤销，或者重排', r.x + 12, r.y + r.h / 2, {
      size: 12.5,
      weight: 600,
      color: '#8a4b00',
      baseline: 'middle',
    });
    y += WARN_H + 10;
  }

  // ── 道具栏固定在底部，棋盘用剩下的空间
  const itemsY = H - view.safeBottom - ITEM_H - 14;
  const boardArea: Rect = { x: pad, y, w: W - pad * 2, h: Math.max(120, itemsY - y - 14) };

  const L = layoutBoard({
    penCount: vm.pens.length,
    capacity: vm.capacity,
    ...boardArea,
  });
  // 棋盘略偏上（0.35 而不是居中的 0.5）——
  // 完全居中时上下都是大片空白，构图会「飘」；偏上一点重心更稳，
  // 底部留出的空间正好给道具栏和拇指。
  const offsetY = Math.max(0, Math.round((boardArea.h - L.bounds.h) * 0.35));
  for (const p of L.pens) p.y += offsetY;

  drawBoard(ctx, vm, L);
  hits.pens = L.pens;

  // ── 道具栏
  const itemRects = layoutRow({ x: pad, y: itemsY, w: W - pad * 2, h: ITEM_H }, vm.items.length, 7);
  vm.items.forEach((it, i) => {
    drawItem(ctx, it, itemRects[i]);
    hits.items.push({ kind: it.kind, rect: itemRects[i] });
  });

  // ── 飘字
  if (vm.toast) drawToast(ctx, vm.toast, W, H);

  // ── 弹窗
  if (vm.overlay) {
    hits.overlayButtons = drawOverlay(ctx, vm.overlay, W, H);
  } else if (vm.busy) {
    fillRound(ctx, { x: 0, y: 0, w: W, h: H }, 0, T.overlay);
    text(ctx, vm.busy, W / 2, H / 2, {
      size: 16,
      weight: 700,
      color: T.white,
      align: 'center',
      baseline: 'middle',
    });
  }

  return hits;
}

function drawHud(ctx: Ctx2D, vm: ViewModel, x: number, y: number, w: number): void {
  let cx = x;
  cx += chip(ctx, cx, y, HUD_H, vm.levelName, { bg: T.accent, color: '#4a2c00' }) + 7;
  cx += chip(ctx, cx, y, HUD_H, `🐑 ${vm.remaining}`) + 7;
  chip(ctx, cx, y, HUD_H, `${vm.score} 分`);
  // 钻石靠右
  ctx.font = font(13, 600);
  const gemLabel = `💎 ${vm.gems}`;
  const gw = Math.ceil(ctx.measureText(gemLabel).width) + 22;
  chip(ctx, x + w - gw, y, HUD_H, gemLabel);
}

function drawBoard(ctx: Ctx2D, vm: ViewModel, L: BoardLayout): void {
  const droppable = new Set(vm.droppable);

  for (const pen of L.pens) {
    const i = pen.index;
    const contents = vm.pens[i] ?? [];
    const isSel = vm.selected === i;

    // 选中的栏位整体抬起
    const box: Rect = isSel ? { ...pen, y: pen.y - 5 } : pen;
    groove(ctx, box, 14);

    if (isSel) strokeRound(ctx, box, 14, T.accent, 3);
    else if (droppable.has(i)) strokeRound(ctx, box, 14, T.moss, 2.5, [6, 5]);
    else if (vm.hinted && (vm.hinted[0] === i || vm.hinted[1] === i)) {
      strokeRound(ctx, box, 14, T.accent, 2.5, [7, 5]);
    }

    // 空栏标记 —— 空栏位是这个游戏唯一的硬通货，视觉上要明确
    if (contents.length === 0) {
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(11, box.w * 0.18), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      continue;
    }

    const liftFrom = isSel ? contents.length - vm.liftCount : Infinity;
    contents.forEach((breed, idx) => {
      const base = animalRect({ ...pen, y: box.y }, L, idx, vm.capacity);
      const lifted = idx >= liftFrom;
      const r: Rect = lifted
        ? { x: base.x - 2, y: base.y - 8, w: base.w + 4, h: base.h + 4 }
        : base;
      drawAnimal(ctx, r, breed, lifted);
    });
  }
}

function drawAnimal(ctx: Ctx2D, r: Rect, breed: number, lifted: boolean): void {
  const look = BREEDS[breed % BREEDS.length];
  clay(ctx, r, Math.min(11, r.h * 0.34), lighten(look.color, 0.22), look.color, lifted ? 4 : 2);
  if (lifted) strokeRound(ctx, r, Math.min(11, r.h * 0.34), T.accent, 2.5);
  ctx.font = font(Math.round(r.h * 0.62), 400);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000';
  ctx.fillText(look.face, r.x + r.w / 2, r.y + r.h / 2 + 1);
}

function drawItem(
  ctx: Ctx2D,
  it: { kind: ItemKind; state: ItemButtonState; count: number },
  r: Rect,
): void {
  const meta = ITEM_META[it.kind];
  const locked = it.state === 'locked';

  ctx.globalAlpha = locked ? 0.42 : 1;
  clay(ctx, r, 14, T.white, T.card, 3);

  ctx.font = font(Math.min(20, r.w * 0.42), 400);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000';
  ctx.fillText(meta.glyph, r.x + r.w / 2, r.y + r.h * 0.36);

  text(ctx, meta.label, r.x + r.w / 2, r.y + r.h * 0.76, {
    size: Math.min(11, r.w * 0.2),
    weight: 600,
    color: T.ink,
    align: 'center',
    baseline: 'middle',
  });

  // 角标：剩余次数 / 广告 / 钻石
  if (!locked) {
    const badge =
      it.state === 'free' ? String(it.count) : it.state === 'ad' ? '📺' : '💎';
    const bg = it.state === 'free' ? '#4caf50' : it.state === 'ad' ? '#ff7043' : '#42a5f5';
    const br: Rect = { x: r.x + r.w - 17, y: r.y - 6, w: 20, h: 17 };
    fillRound(ctx, br, 8.5, bg);
    text(ctx, badge, br.x + br.w / 2, br.y + br.h / 2, {
      size: 10.5,
      weight: 700,
      color: T.white,
      align: 'center',
      baseline: 'middle',
    });
  }
  ctx.globalAlpha = 1;
}

function drawToast(ctx: Ctx2D, toast: { text: string; ageMs: number }, W: number, H: number): void {
  const t = Math.min(1, toast.ageMs / 800);
  const rise = -46 * t;
  ctx.globalAlpha = t < 0.25 ? t / 0.25 : 1 - Math.max(0, (t - 0.6) / 0.4);
  const scale = t < 0.3 ? 0.6 + (t / 0.3) * 0.55 : 1.05 - (t - 0.3) * 0.07;

  ctx.save();
  ctx.translate(W / 2, H * 0.34 + rise);
  ctx.scale(scale, scale);
  text(ctx, toast.text, 0, 3, {
    size: 30,
    weight: 800,
    color: T.accentDark,
    align: 'center',
    baseline: 'middle',
  });
  text(ctx, toast.text, 0, 0, {
    size: 30,
    weight: 800,
    color: T.accent,
    align: 'center',
    baseline: 'middle',
  });
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawOverlay(
  ctx: Ctx2D,
  ov: NonNullable<ViewModel['overlay']>,
  W: number,
  H: number,
): { id: string; rect: Rect }[] {
  fillRound(ctx, { x: 0, y: 0, w: W, h: H }, 0, T.overlay);

  const sheetW = Math.min(320, W - 44);
  const btnH = 50;
  const bodyH = 128 + (ov.stars !== undefined ? 34 : 0);
  const sheetH = bodyH + ov.buttons.length * (btnH + 9) + 18;
  const sheet: Rect = {
    x: (W - sheetW) / 2,
    y: (H - sheetH) / 2,
    w: sheetW,
    h: sheetH,
  };
  clay(ctx, sheet, 24, T.white, T.card, 6);

  let cy = sheet.y + 30;
  ctx.font = font(46, 400);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000';
  ctx.fillText(ov.emoji, sheet.x + sheet.w / 2, cy + 8);
  cy += 52;

  if (ov.stars !== undefined) {
    const s = '⭐'.repeat(ov.stars) + '☆'.repeat(Math.max(0, 3 - ov.stars));
    text(ctx, s, sheet.x + sheet.w / 2, cy, {
      size: 22,
      align: 'center',
      baseline: 'middle',
      color: T.accent,
    });
    cy += 32;
  }

  text(ctx, ov.title, sheet.x + sheet.w / 2, cy, {
    size: 20,
    weight: 800,
    align: 'center',
    baseline: 'middle',
  });
  cy += 26;

  // 描述可能较长，做简单折行
  for (const line of wrap(ctx, ov.desc, sheet.w - 40, 13)) {
    text(ctx, line, sheet.x + sheet.w / 2, cy, {
      size: 13,
      color: T.inkSoft,
      align: 'center',
      baseline: 'middle',
    });
    cy += 19;
  }
  cy += 8;

  const out: { id: string; rect: Rect }[] = [];
  for (const b of ov.buttons) {
    const r: Rect = { x: sheet.x + 20, y: cy, w: sheet.w - 40, h: btnH };
    if (b.primary) clay(ctx, r, 15, '#ffc766', T.accent, 4);
    else clay(ctx, r, 15, '#f0f0ea', '#e2e4dc', 3);
    text(ctx, b.label, r.x + r.w / 2, r.y + r.h / 2, {
      size: 15,
      weight: 700,
      color: b.primary ? '#4a2c00' : T.ink,
      align: 'center',
      baseline: 'middle',
    });
    out.push({ id: b.id, rect: r });
    cy += btnH + 9;
  }
  return out;
}

/** 按宽度折行。中文没有空格，所以是逐字测量。 */
function wrap(ctx: Ctx2D, s: string, maxW: number, size: number): string[] {
  ctx.font = font(size, 400);
  const lines: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (ctx.measureText(cur + ch).width > maxW && cur) {
      lines.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4);
}

function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) + Math.round(255 * amount));
  const g = Math.min(255, ((n >> 8) & 255) + Math.round(255 * amount));
  const b = Math.min(255, (n & 255) + Math.round(255 * amount));
  return `rgb(${r},${g},${b})`;
}
