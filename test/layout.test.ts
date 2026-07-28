import test from 'node:test';
import assert from 'node:assert/strict';

import {
  animalRect,
  hitTest,
  layoutBoard,
  layoutRow,
  rectsOverlap,
} from '../src/render/layout.ts';
import type { Rect } from '../src/render/layout.ts';

/**
 * 布局是真机上最难调的东西 —— 这些断言把它变成可以在 Node 里验的数学。
 * 覆盖的屏幕尺寸从最窄的小屏到平板。
 */
const SCREENS = [
  { name: 'iPhone SE', w: 320, h: 568 },
  { name: '常见竖屏', w: 390, h: 844 },
  { name: '大屏', w: 430, h: 932 },
  { name: '平板窄边', w: 600, h: 900 },
];

/** 关卡跨度：品种 3~9、空栏 1~3 → 栏位 4~12 */
const PEN_COUNTS = [4, 5, 6, 7, 8, 9, 10, 11, 12];

function area(w: number, h: number): { x: number; y: number; w: number; h: number } {
  return { x: 12, y: 100, w: w - 24, h: Math.round(h * 0.52) };
}

test('所有屏幕 × 所有栏位数：栏位互不重叠', () => {
  for (const s of SCREENS) {
    for (const n of PEN_COUNTS) {
      const L = layoutBoard({ penCount: n, capacity: 4, ...area(s.w, s.h) });
      for (let i = 0; i < L.pens.length; i++) {
        for (let j = i + 1; j < L.pens.length; j++) {
          assert.equal(
            rectsOverlap(L.pens[i], L.pens[j]),
            false,
            `${s.name} ${n} 栏：第 ${i} 和第 ${j} 栏重叠了`,
          );
        }
      }
    }
  }
});

test('所有屏幕 × 所有栏位数：不超出可用区域左右边界', () => {
  for (const s of SCREENS) {
    for (const n of PEN_COUNTS) {
      const a = area(s.w, s.h);
      const L = layoutBoard({ penCount: n, capacity: 4, ...a });
      for (const p of L.pens) {
        assert.ok(p.x >= a.x - 1, `${s.name} ${n} 栏：第 ${p.index} 栏左边越界 (${p.x} < ${a.x})`);
        assert.ok(
          p.x + p.w <= a.x + a.w + 1,
          `${s.name} ${n} 栏：第 ${p.index} 栏右边越界 (${p.x + p.w} > ${a.x + a.w})`,
        );
      }
    }
  }
});

test('所有屏幕 × 所有栏位数：竖直方向塞得进可用高度', () => {
  for (const s of SCREENS) {
    for (const n of PEN_COUNTS) {
      const a = area(s.w, s.h);
      const L = layoutBoard({ penCount: n, capacity: 4, ...a });
      assert.ok(
        L.bounds.h <= a.h + 1,
        `${s.name} ${n} 栏：总高 ${L.bounds.h} 超出可用 ${a.h}`,
      );
    }
  }
});

test('栏位窄到看不清时自动换行', () => {
  const a = area(390, 844);
  const single = layoutBoard({ penCount: 5, capacity: 4, ...a });
  const wrapped = layoutBoard({ penCount: 11, capacity: 4, ...a });

  const rowsOf = (pens: { y: number }[]): number => new Set(pens.map((p) => p.y)).size;
  assert.equal(rowsOf(single.pens), 1, '5 栏应当单排');
  assert.ok(rowsOf(wrapped.pens) >= 2, '11 栏在 390px 宽上必须换行，否则每栏窄到看不清');
  assert.ok(wrapped.pens[0].w >= 30, `换行后栏宽 ${wrapped.pens[0].w} 仍然太窄`);
});

test('最后一排不满时居中，不是靠左堆着', () => {
  const a = area(390, 844);
  // 9 栏 → 两排 5 + 4，第二排应当整体居中
  const L = layoutBoard({ penCount: 9, capacity: 4, ...a });
  const rows = new Map<number, typeof L.pens>();
  for (const p of L.pens) {
    const arr = rows.get(p.y) ?? [];
    arr.push(p);
    rows.set(p.y, arr);
  }
  const [firstRow, lastRow] = [...rows.values()];
  assert.ok(lastRow.length < firstRow.length, '这个用例的最后一排应当不满');

  const centerOf = (r: typeof L.pens): number =>
    (r[0].x + r[r.length - 1].x + r[r.length - 1].w) / 2;
  assert.ok(
    Math.abs(centerOf(firstRow) - centerOf(lastRow)) <= 2,
    `两排应当同一中轴：${centerOf(firstRow)} vs ${centerOf(lastRow)}`,
  );
});

test('羊在栏位内从下往上排，且不越出栏位', () => {
  const a = area(390, 844);
  const L = layoutBoard({ penCount: 6, capacity: 4, ...a });
  const pen = L.pens[0];

  const rects = [0, 1, 2, 3].map((i) => animalRect(pen, L, i, 4));
  // 下标 0 是栏底 → y 最大
  for (let i = 1; i < rects.length; i++) {
    assert.ok(rects[i].y < rects[i - 1].y, `下标 ${i} 应当在 ${i - 1} 上方`);
  }
  for (const r of rects) {
    assert.ok(r.y >= pen.y, '羊不该越出栏位顶部');
    assert.ok(r.y + r.h <= pen.y + pen.h + 1, '羊不该越出栏位底部');
    assert.ok(r.x >= pen.x && r.x + r.w <= pen.x + pen.w, '羊不该越出栏位左右');
  }
});

test('满栏的羊互不重叠', () => {
  const a = area(320, 568); // 最窄的屏
  const L = layoutBoard({ penCount: 12, capacity: 4, ...a });
  for (const pen of L.pens) {
    const rects = [0, 1, 2, 3].map((i) => animalRect(pen, L, i, 4));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        assert.equal(rectsOverlap(rects[i], rects[j]), false, `第 ${pen.index} 栏内羊重叠`);
      }
    }
  }
});

test('命中测试能选中正确的栏位', () => {
  const a = area(390, 844);
  const L = layoutBoard({ penCount: 7, capacity: 4, ...a });
  for (const p of L.pens) {
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    assert.equal(hitTest(L.pens, cx, cy), p.index, `第 ${p.index} 栏中心点命中错了`);
  }
  // 区域外
  assert.equal(hitTest(L.pens, 5, 5), -1);
});

test('栏位之间的缝隙不会误命中', () => {
  const a = area(390, 844);
  const L = layoutBoard({ penCount: 5, capacity: 4, ...a });
  const gapX = (L.pens[0].x + L.pens[0].w + L.pens[1].x) / 2;
  const cy = L.pens[0].y + L.pens[0].h / 2;
  assert.equal(hitTest(L.pens, gapX, cy), -1, '缝隙里不该命中任何栏位');
});

test('一行按钮等分且不重叠', () => {
  const row: Rect = { x: 10, y: 500, w: 370, h: 56 };
  const btns = layoutRow(row, 5, 6);
  assert.equal(btns.length, 5);
  for (let i = 1; i < btns.length; i++) {
    assert.ok(btns[i].x >= btns[i - 1].x + btns[i - 1].w, '按钮重叠了');
    assert.equal(btns[i].w, btns[0].w, '按钮应当等宽');
  }
  const last = btns[btns.length - 1];
  assert.ok(last.x + last.w <= row.x + row.w + 1, '按钮排超出容器');
});

test('容量变化时栏位高度跟着变（为将来的容量 5 留好余地）', () => {
  const a = area(390, 844);
  const c4 = layoutBoard({ penCount: 6, capacity: 4, ...a });
  const c5 = layoutBoard({ penCount: 6, capacity: 5, ...a });
  assert.ok(c5.pens[0].h >= c4.pens[0].h, '容量更大时栏位应当更高或至少不更矮');
  assert.ok(c5.bounds.h <= a.h + 1, '容量 5 也不能超出可用高度');
});
