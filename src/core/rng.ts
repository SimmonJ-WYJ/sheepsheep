/**
 * 确定性随机数发生器（mulberry32）。
 *
 * 为什么不用 Math.random：
 * 1. 「每日挑战」要求全球玩家拿到同一副牌 —— 用 `seed = 日期` 即可，无需下发牌面。
 * 2. 服务端可以用同一个 seed 复算牌局，校验客户端上报的分数，反作弊。
 * 3. 单测可复现。
 */
export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [0, maxExclusive) 的整数 */
  int(maxExclusive: number): number;
  /** 按权重取下标，weights 不需要归一化 */
  weighted(weights: number[]): number;
  pick<T>(arr: readonly T[]): T;
  /** 返回新数组，不修改入参 */
  shuffle<T>(arr: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (maxExclusive: number): number => Math.floor(next() * maxExclusive);

  return {
    next,
    int,
    weighted(weights) {
      let total = 0;
      for (const w of weights) total += w;
      if (total <= 0) return 0;
      let r = next() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r < 0) return i;
      }
      return weights.length - 1;
    },
    pick(arr) {
      return arr[int(arr.length)];
    },
    shuffle(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    },
  };
}

/** 把 YYYY-MM-DD 之类的字符串稳定地散列成 seed。 */
export function seedFromString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
