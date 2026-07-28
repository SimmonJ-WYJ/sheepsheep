/**
 * Canvas 宿主抽象。
 *
 * 抖音小游戏没有 DOM，只有一块 canvas 和 `tt.*`。但我们**不能只写抖音版** ——
 * 那样每改一行渲染都要打包上传真机才能看，开发效率会低到不可接受，
 * 而且没法在 CI 里验证。
 *
 * 所以渲染层只依赖下面这个接口，两个实现：
 *   - `createDouyinHost()` —— 真机
 *   - `createBrowserHost()` —— 开发和自动化验证
 *
 * 同一套绘制代码两边都跑，浏览器里看到的就是真机上的样子。
 */

/** 我们实际用到的 2D context 方法，只声明这些，方便 mock。 */
export interface Ctx2D {
  canvas: { width: number; height: number };
  fillStyle: string | CanvasGradient;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  save(): void;
  restore(): void;
  scale(x: number, y: number): void;
  translate(x: number, y: number): void;
  rotate(a: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(t: string, x: number, y: number): void;
  measureText(t: string): { width: number };
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient;
  setLineDash(d: number[]): void;
}

export interface CanvasHost {
  readonly name: string;
  ctx: Ctx2D;
  /** 逻辑宽高（不含 DPR 放大）。绘制代码只用这两个数。 */
  width: number;
  height: number;
  /** 顶部安全区（状态栏 / 刘海）。 */
  safeTop: number;
  /** 底部安全区。 */
  safeBottom: number;
  /** 点击/触摸。坐标已经换算成逻辑坐标。 */
  onTap(cb: (x: number, y: number) => void): void;
  /** 每帧回调，dt 单位毫秒。 */
  onFrame(cb: (dt: number) => void): void;
  now(): number;
}

// ───────────────────────────────────────── 浏览器

export function createBrowserHost(canvas: HTMLCanvasElement): CanvasHost {
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  const ctx = canvas.getContext('2d') as unknown as Ctx2D;

  const resize = (): void => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    host.width = w;
    host.height = h;
  };

  const host: CanvasHost = {
    name: 'browser',
    ctx,
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    safeTop: 0,
    safeBottom: 0,
    onTap(cb) {
      const handle = (cx: number, cy: number): void => {
        const r = canvas.getBoundingClientRect();
        cb(cx - r.left, cy - r.top);
      };
      canvas.addEventListener('click', (e) => handle(e.clientX, e.clientY));
      canvas.addEventListener(
        'touchstart',
        (e) => {
          const t = e.changedTouches[0];
          if (t) handle(t.clientX, t.clientY);
          e.preventDefault();
        },
        { passive: false },
      );
    },
    onFrame(cb) {
      let last = performance.now();
      const loop = (t: number): void => {
        cb(t - last);
        last = t;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    },
    now: () => Date.now(),
  };

  resize();
  globalThis.addEventListener?.('resize', resize);
  // 每帧把 DPR 缩放重新压上去（save/restore 会被绘制代码用掉）
  const origOnFrame = host.onFrame;
  host.onFrame = (cb) =>
    origOnFrame((dt) => {
      ctx.save();
      ctx.scale(dpr, dpr);
      cb(dt);
      ctx.restore();
    });
  return host;
}

// ───────────────────────────────────────── 抖音小游戏

interface TTSystemInfo {
  windowWidth: number;
  windowHeight: number;
  pixelRatio?: number;
  safeArea?: { top: number; bottom: number; height: number };
  screenHeight?: number;
}

interface TTCanvasHostApi {
  createCanvas(): { width: number; height: number; getContext(t: '2d'): unknown };
  getSystemInfoSync(): TTSystemInfo;
  onTouchStart(cb: (e: { touches: { clientX: number; clientY: number }[] }) => void): void;
}

/**
 * 抖音小游戏宿主。
 *
 * 注意 `tt.createCanvas()` **第一次调用返回的是上屏 canvas**（和微信小游戏一致），
 * 之后再调返回的是离屏 canvas。所以整个程序只能调一次，
 * 这也是为什么 host 必须是单例创建。
 */
export function createDouyinHost(): CanvasHost {
  const tt = (globalThis as { tt?: TTCanvasHostApi }).tt;
  if (!tt) throw new Error('不在抖音小游戏环境中');

  const info = tt.getSystemInfoSync();
  const dpr = info.pixelRatio ?? 1;
  const canvas = tt.createCanvas();
  canvas.width = Math.round(info.windowWidth * dpr);
  canvas.height = Math.round(info.windowHeight * dpr);
  const ctx = canvas.getContext('2d') as Ctx2D;

  const safeTop = info.safeArea?.top ?? 0;
  const safeBottom = info.safeArea
    ? Math.max(0, (info.screenHeight ?? info.windowHeight) - info.safeArea.bottom)
    : 0;

  return {
    name: 'douyin',
    ctx,
    width: info.windowWidth,
    height: info.windowHeight,
    safeTop,
    safeBottom,
    onTap(cb) {
      tt.onTouchStart((e) => {
        const t = e.touches?.[0];
        if (t) cb(t.clientX, t.clientY);
      });
    },
    onFrame(cb) {
      let last = Date.now();
      const loop = (): void => {
        const t = Date.now();
        ctx.save();
        ctx.scale(dpr, dpr);
        cb(t - last);
        ctx.restore();
        last = t;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    },
    now: () => Date.now(),
  };
}
