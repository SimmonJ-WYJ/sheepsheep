import type { Ctx2D } from './host.ts';
import type { Rect } from './layout.ts';
import { T, font } from './theme.ts';

/**
 * 底层绘制原语。
 *
 * canvas 没有 box-shadow，「黏土厚度」靠三层手工画出来：
 *   1. 底部垫一层深色（假投影）
 *   2. 主体用竖直渐变（上亮下暗）
 *   3. 顶部压一条半透明白（高光）
 * 这三层是整套视觉的全部秘密，别的地方都在复用。
 */

export function roundRect(ctx: Ctx2D, r: Rect, radius: number): void {
  const rad = Math.min(radius, r.w / 2, r.h / 2);
  ctx.beginPath();
  ctx.moveTo(r.x + rad, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, rad);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, rad);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, rad);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, rad);
  ctx.closePath();
}

export function fillRound(ctx: Ctx2D, r: Rect, radius: number, color: string): void {
  roundRect(ctx, r, radius);
  ctx.fillStyle = color;
  ctx.fill();
}

export function strokeRound(
  ctx: Ctx2D,
  r: Rect,
  radius: number,
  color: string,
  width = 2,
  dash?: number[],
): void {
  roundRect(ctx, r, radius);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.stroke();
  if (dash) ctx.setLineDash([]);
}

/** 黏土块：假投影 + 渐变主体 + 顶部高光。 */
export function clay(
  ctx: Ctx2D,
  r: Rect,
  radius: number,
  top: string,
  bottom: string,
  lift = 3,
): void {
  // 1. 假投影
  fillRound(ctx, { ...r, y: r.y + lift }, radius, 'rgba(0,0,0,0.16)');
  // 2. 主体渐变
  roundRect(ctx, r, radius);
  const g = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fill();
  // 3. 顶部高光
  const hi: Rect = { x: r.x + 3, y: r.y + 2, w: r.w - 6, h: Math.max(3, r.h * 0.22) };
  fillRound(ctx, hi, radius * 0.7, 'rgba(255,255,255,0.28)');
}

/** 内凹（栏位这种「槽」）：上暗下亮，和 clay 相反。 */
export function groove(ctx: Ctx2D, r: Rect, radius: number): void {
  fillRound(ctx, { ...r, y: r.y + 3 }, radius, 'rgba(0,0,0,0.14)');
  roundRect(ctx, r, radius);
  const g = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
  g.addColorStop(0, T.woodDeep);
  g.addColorStop(0.18, T.woodDark);
  g.addColorStop(1, T.wood);
  ctx.fillStyle = g;
  ctx.fill();
  // 内壁阴影
  const inner: Rect = { x: r.x + 2, y: r.y + 2, w: r.w - 4, h: Math.max(4, r.h * 0.1) };
  fillRound(ctx, inner, radius * 0.6, 'rgba(0,0,0,0.2)');
}

export function text(
  ctx: Ctx2D,
  s: string,
  x: number,
  y: number,
  opts: {
    size?: number;
    weight?: number | string;
    color?: string;
    align?: CanvasTextAlign;
    baseline?: CanvasTextBaseline;
  } = {},
): void {
  ctx.font = font(opts.size ?? 14, opts.weight ?? 400);
  ctx.fillStyle = opts.color ?? T.ink;
  ctx.textAlign = opts.align ?? 'left';
  ctx.textBaseline = opts.baseline ?? 'alphabetic';
  ctx.fillText(s, x, y);
}

/** 胶囊标签（HUD 用）。返回实际宽度，方便水平排布。 */
export function chip(
  ctx: Ctx2D,
  x: number,
  y: number,
  h: number,
  label: string,
  opts: { bg?: string; color?: string; size?: number; padX?: number } = {},
): number {
  const size = opts.size ?? 13;
  const padX = opts.padX ?? 11;
  ctx.font = font(size, 600);
  const w = Math.ceil(ctx.measureText(label).width) + padX * 2;
  const r: Rect = { x, y, w, h };
  fillRound(ctx, { ...r, y: r.y + 2 }, h / 2, 'rgba(0,0,0,0.10)');
  fillRound(ctx, r, h / 2, opts.bg ?? T.card);
  text(ctx, label, x + w / 2, y + h / 2, {
    size,
    weight: 600,
    color: opts.color ?? T.ink,
    align: 'center',
    baseline: 'middle',
  });
  return w;
}

/** 背景：天空到草地的渐变。 */
export function background(ctx: Ctx2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, T.sky1);
  g.addColorStop(0.55, T.sky2);
  g.addColorStop(1, T.grass);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}
