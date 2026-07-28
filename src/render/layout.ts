/**
 * 布局计算 —— 纯函数，不碰 canvas。
 *
 * 单独抽出来是为了**能测**：栏位排布和命中测试是最容易出错的地方
 * （尤其栏位多到要换行、以及不同屏幕比例），而这些在真机上调试极其痛苦。
 * 这里全部是可以在 Node 里断言的数学。
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PenRect extends Rect {
  index: number;
}

export interface BoardLayout {
  pens: PenRect[];
  /** 一只羊的宽高。 */
  animalW: number;
  animalH: number;
  /** 羊之间的竖直间隙。 */
  animalGap: number;
  /** 栏位内边距。 */
  penPad: number;
  /** 整个棋盘的包围盒，用于居中和碰撞排查。 */
  bounds: Rect;
}

export interface LayoutInput {
  penCount: number;
  capacity: number;
  /** 可用区域 */
  x: number;
  y: number;
  w: number;
  h: number;
}

const GAP_X = 8;
const GAP_Y = 12;
const PEN_PAD = 5;
const ANIMAL_GAP = 3;

/**
 * 把 N 个栏位排进给定区域。
 *
 * 排布策略：优先单排；单排会让每个栏位窄于可读下限时换成两排。
 * 竖屏手机上 7 个以上栏位单排必然过窄，所以换行是必须的而不是可选的。
 */
export function layoutBoard(input: LayoutInput): BoardLayout {
  const { penCount, capacity } = input;
  const rows = chooseRows(penCount, input.w, input.h, capacity);
  const perRow = Math.ceil(penCount / rows);

  // 先按宽度算出栏位宽，再由此推出羊的尺寸
  const penW = Math.floor((input.w - GAP_X * (perRow - 1)) / perRow);
  const animalW = Math.max(14, penW - PEN_PAD * 2);

  // 高度反过来约束：rows 排必须塞进可用高度
  const maxPenH = Math.floor((input.h - GAP_Y * (rows - 1)) / rows);
  const animalH = Math.max(
    12,
    Math.min(
      Math.round(animalW * 0.82),
      Math.floor((maxPenH - PEN_PAD * 2 - ANIMAL_GAP * (capacity - 1)) / capacity),
    ),
  );
  const penH = animalH * capacity + ANIMAL_GAP * (capacity - 1) + PEN_PAD * 2;

  const pens: PenRect[] = [];
  for (let i = 0; i < penCount; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    // 最后一排可能不满，单独居中
    const inThisRow = Math.min(perRow, penCount - row * perRow);
    const rowW = inThisRow * penW + (inThisRow - 1) * GAP_X;
    const rowX = input.x + Math.round((input.w - rowW) / 2);
    pens.push({
      index: i,
      x: rowX + col * (penW + GAP_X),
      y: input.y + row * (penH + GAP_Y),
      w: penW,
      h: penH,
    });
  }

  const totalH = rows * penH + (rows - 1) * GAP_Y;
  return {
    pens,
    animalW,
    animalH,
    animalGap: ANIMAL_GAP,
    penPad: PEN_PAD,
    bounds: { x: input.x, y: input.y, w: input.w, h: totalH },
  };
}

/** 栏位太窄就没法看清里面的动物，这是可读下限。 */
const MIN_PEN_W = 44;

function chooseRows(penCount: number, w: number, h: number, capacity: number): number {
  for (let rows = 1; rows <= 3; rows++) {
    const perRow = Math.ceil(penCount / rows);
    const penW = (w - GAP_X * (perRow - 1)) / perRow;
    if (penW < MIN_PEN_W) continue;
    // 这个排数下需要的高度
    const animalH = Math.min(penW * 0.82, (h / rows - PEN_PAD * 2) / capacity);
    const penH = animalH * capacity + ANIMAL_GAP * (capacity - 1) + PEN_PAD * 2;
    if (penH * rows + GAP_Y * (rows - 1) <= h) return rows;
  }
  return penCount > 6 ? 2 : 1;
}

/** 一只羊在栏位里的矩形。`idx` 0 是栏底，画的时候栏底在下方。 */
export function animalRect(
  pen: PenRect,
  layout: BoardLayout,
  idx: number,
  capacity: number,
): Rect {
  const { animalW, animalH, animalGap, penPad } = layout;
  // 栏口在上：下标越大越靠上
  const slotFromBottom = idx;
  const y =
    pen.y + pen.h - penPad - animalH - slotFromBottom * (animalH + animalGap);
  void capacity;
  return { x: pen.x + Math.round((pen.w - animalW) / 2), y, w: animalW, h: animalH };
}

export function hitTest(rects: readonly Rect[], x: number, y: number): number {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
  }
  return -1;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 一行按钮等分排布。 */
export function layoutRow(area: Rect, count: number, gap: number): Rect[] {
  const w = Math.floor((area.w - gap * (count - 1)) / count);
  const out: Rect[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: area.x + i * (w + gap), y: area.y, w, h: area.h });
  }
  return out;
}
