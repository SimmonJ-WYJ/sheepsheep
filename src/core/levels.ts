import type { LevelConfig, LayerSpec } from './types.ts';

/**
 * 难度曲线。
 *
 * 《羊了个羊》只有两关：第 1 关幼儿园，第 2 关通过率 <0.1%。
 * 落差本身是它的传播引擎，但代价是没有中段 —— 玩家在第 2 关卡死后就流失了，
 * 没有任何「我在变强」的反馈。
 *
 * 这里铺一条连续曲线，把那个落差保留下来，但只放在特定位置（见 SPIKE_LEVELS），
 * 让它成为「话题关」而不是「劝退墙」：
 *
 *   1-3    教学：卡槽 7 格，牌少，图标 3~4 种，几乎不可能输
 *   4-10   入门：加层数，图标到 6 种
 *   11-25  进阶：牌河出现，卡槽压力开始要规划
 *   26-60  熟练：限时进场，maxOpenGroups 逼近 capacity-1
 *   61+    大师：程序化生成，缓慢逼近上限
 *
 * 每 10 关插一个「尖峰关」，难度陡增 —— 这是留给短视频传播的素材位。
 */

/** 尖峰关：难度显著高于邻居，用来制造「XX 关我卡了三天」的话题。 */
const SPIKE_LEVELS = new Set([10, 20, 35, 50, 66, 88]);

function layers(count: number, base: number, shrink: number): LayerSpec[] {
  const out: LayerSpec[] = [];
  for (let i = 0; i < count; i++) {
    const w = Math.max(4, base - i * shrink);
    const h = Math.max(4, base - i * shrink);
    out.push({
      width: w,
      height: h,
      // 每层比下层少 ~25%，形成金字塔
      count: Math.max(3, Math.round(((w / 2) * (h / 2)) * 0.55)),
      offsetX: (i % 2) * 1,
      offsetY: (i % 2) * 1,
    });
  }
  return out;
}

/** 线性插值 + clamp。 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

export function makeLevel(id: number): LevelConfig {
  const spike = SPIKE_LEVELS.has(id);
  // t 从 0 平滑走到 1（第 80 关封顶），尖峰关额外前移 0.25 的进度。
  const t = Math.min(1, (id - 1) / 79 + (spike ? 0.25 : 0));

  const slotCapacity = 7;
  const layerCount = Math.round(lerp(2, 7, t));
  const gridBase = Math.round(lerp(8, 14, t));

  // maxOpenGroups 是真正的难度旋钮：越接近上限(=capacity-2=5)，越要求提前规划。
  // 用 t^1.5 让它在中后段才开始明显上抬，避免中段就把普通玩家挡在门外。
  const maxOpenGroups = Math.round(lerp(2, slotCapacity - 2, Math.pow(t, 1.5)));

  // 图标种类越多越难凑；种类少则容易「意外提前消除」。
  // 封顶 9 —— 实测再往上加，普通玩家通过率会断崖式下跌（见 tools/balance.ts）。
  const iconCount = Math.round(lerp(3, 9, t));

  const timeLimitSec = id >= 26 ? Math.round(lerp(300, 150, (id - 26) / 54)) : 0;

  return {
    id,
    name: spike ? `第 ${id} 关 · 尖峰` : `第 ${id} 关`,
    slotCapacity,
    timeLimitSec,
    layout: {
      layers: layers(layerCount, gridBase, 2),
      river: id >= 11 ? { stacks: Math.round(lerp(3, 8, t)), depth: Math.round(lerp(2, 4, t)) } : undefined,
    },
    difficulty: {
      maxOpenGroups,
      // 前期偏向「补齐」（好打），后期偏向「开新组」（卡槽吃紧）
      weightNewGroup: lerp(1, 4.5, t),
      weightGrow: 3,
      weightComplete: lerp(6, 2.5, t),
      iconCount,
      // 万能牌默认关闭，见 docs/02 的「特殊牌」小节
      wildCount: 0,
    },
    freeItems: {
      // 前 5 关道具管够，先把使用习惯养出来，之后再收紧、由广告补给
      undo: id <= 5 ? 5 : 1,
      pop3: id <= 5 ? 3 : 1,
      shuffle: id <= 5 ? 3 : 1,
      xray: id <= 5 ? 3 : 1,
      slot: 0,
    },
  };
}

/** 每日挑战：全服同一副牌，用日期做 seed。 */
export function makeDailyLevel(dateKey: string): LevelConfig {
  const level = makeLevel(45);
  return { ...level, id: -1, name: `每日挑战 · ${dateKey}`, timeLimitSec: 240 };
}
