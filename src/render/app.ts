import type { CanvasHost } from './host.ts';
import type { HitRegions, ViewModel } from './scene.ts';
import { ITEM_ORDER, draw } from './scene.ts';
import { hitTest } from './layout.ts';

import { createRng, seedFromString } from '../core/rng.ts';
import { makeLevel } from '../core/levels.ts';
import { SortGame } from '../core/game.ts';
import type { ItemKind } from '../core/types.ts';

import type { PlatformAdapter } from '../platform/adapter.ts';
import { AdManager } from '../monetize/ad-manager.ts';
import { DEFAULT_AD_POLICY, PLACEHOLDER_AD_UNITS } from '../monetize/policy.ts';
import type { AdPolicy, AdUnitIds } from '../monetize/policy.ts';
import { ReviveController } from '../monetize/revive.ts';
import { ItemShop } from '../monetize/item-shop.ts';
import { GemLedger } from '../monetize/economy.ts';
import { OfferEngine, emptyOfferState } from '../monetize/offers.ts';
import { emptyEntitlements, interstitialFree } from '../monetize/iap.ts';

/**
 * 把游戏核心、变现层和渲染层串起来。
 *
 * 这一层是唯一知道「按了什么会发生什么」的地方；
 * `scene.ts` 只负责画，`core/` 只负责规则，`monetize/` 只负责钱。
 */

export interface AppOptions {
  host: CanvasHost;
  platform: PlatformAdapter;
  adUnits?: AdUnitIds;
  policy?: AdPolicy;
  startLevel?: number;
  /**
   * 没有版号时把内购整体关掉 —— 传 'unavailable' 即可，
   * 所有充值弹窗和按钮一个都不会出现。见 docs/06。
   */
  forcePaymentUnavailable?: boolean;
}

export class App {
  private host: CanvasHost;
  private platform: PlatformAdapter;
  private ads: AdManager;
  private wallet: GemLedger;
  private revive: ReviveController;
  private shop: ItemShop;
  private offers: OfferEngine;
  private entitlements = emptyEntitlements();

  private game!: SortGame;
  private levelId: number;
  private selected: number | null = null;
  private hinted: [number, number] | null = null;
  private toast: { text: string; at: number } | null = null;
  private busy: string | null = null;
  private hits: HitRegions = { pens: [], items: [], overlayButtons: [] };
  /** 本关失败次数，喂给充值触发引擎 */
  private failsThisLevel = 0;
  private adRevivesThisSession = 0;
  private adsWatchedTotal = 0;
  private interstitialsSeen = 0;
  private pendingOffer: string | null = null;

  constructor(opts: AppOptions) {
    this.host = opts.host;
    this.platform = opts.platform;
    this.levelId = opts.startLevel ?? 1;

    const bootAt = this.platform.now();
    this.ads = new AdManager({
      platform: this.platform,
      adUnits: opts.adUnits ?? PLACEHOLDER_AD_UNITS,
      policy: opts.policy ?? DEFAULT_AD_POLICY,
      bootAt,
      isInterstitialFree: () => interstitialFree(this.entitlements, this.platform.now()),
      onEvent: (e) => {
        if (e.outcome?.granted) this.adsWatchedTotal++;
        if (e.placement === 'level_start' && e.outcome?.granted) this.interstitialsSeen++;
      },
    });

    this.wallet = new GemLedger(this.platform.storage, () => this.platform.now());
    this.revive = new ReviveController(this.ads, this.wallet);
    this.shop = new ItemShop(this.ads, this.wallet);
    this.offers = new OfferEngine(
      {
        availability: opts.forcePaymentUnavailable
          ? 'unavailable'
          : this.platform.paymentAvailability(),
      },
      bootAt,
      emptyOfferState(),
    );

    this.startLevel(this.levelId);
    this.host.onTap((x, y) => this.onTap(x, y));
    this.host.onFrame(() => this.render());
  }

  // ─────────────────────────────────────────────── 关卡

  private startLevel(id: number): void {
    this.levelId = Math.max(1, id);
    this.game = new SortGame({
      level: makeLevel(this.levelId),
      rng: createRng(seedFromString(`lv${this.levelId}-${this.platform.now()}`)),
      now: () => this.platform.now(),
    });
    this.ads.startLevel(this.levelId);
    this.revive.startLevel();
    this.selected = null;
    this.hinted = null;
    this.failsThisLevel = 0;
  }

  // ─────────────────────────────────────────────── 输入

  private onTap(x: number, y: number): void {
    if (this.busy) return;

    // 弹窗优先吃掉点击
    if (this.hits.overlayButtons.length > 0) {
      const i = hitTest(
        this.hits.overlayButtons.map((b) => b.rect),
        x,
        y,
      );
      if (i >= 0) void this.onOverlayButton(this.hits.overlayButtons[i].id);
      return;
    }
    if (this.game.status !== 'playing') return;

    // 道具
    const ii = hitTest(
      this.hits.items.map((b) => b.rect),
      x,
      y,
    );
    if (ii >= 0) {
      void this.onItem(this.hits.items[ii].kind);
      return;
    }

    // 栏位
    const pi = hitTest(this.hits.pens, x, y);
    if (pi >= 0) this.onPen(pi);
  }

  private onPen(i: number): void {
    this.hinted = null;

    if (this.selected === null) {
      if (this.game.pens[i].length > 0) this.selected = i;
      return;
    }
    if (this.selected === i) {
      this.selected = null;
      return;
    }

    const from = this.selected;
    const r = this.game.move(from, i);
    this.selected = null;

    if (!r.ok) {
      // 落点不合法：如果点的是另一群羊就改成选中它，手感更顺
      if (this.game.pens[i].length > 0) this.selected = i;
      return;
    }

    if (r.shipped !== null) {
      this.toast = { text: r.combo > 1 ? `${r.combo} 连击! +${r.gained}` : `+${r.gained}`, at: this.host.now() };
    }
    if (this.game.status === 'won') {
      this.onWin();
    } else if (this.game.status === 'lost') {
      this.failsThisLevel++;
    }
  }

  private onWin(): void {
    // 评星换钻石
    const stars = this.game.stars();
    if (stars > 0) this.wallet.earn('level_stars', stars);
  }

  private async onItem(kind: ItemKind): Promise<void> {
    const state = this.shop.buttonState(this.game, kind);
    if (state === 'locked') return;

    if (state === 'free') {
      this.shop.useFree(this.game, kind);
    } else if (state === 'ad') {
      this.busy = '正在播放激励视频…';
      const r = await this.shop.useByAd(this.game, kind);
      this.busy = null;
      if (!r.ok) this.toast = { text: '未发放', at: this.host.now() };
    } else {
      const before = this.wallet.diamonds();
      const r = this.shop.useByDiamond(this.game, kind);
      if (!r.ok && before === this.wallet.diamonds()) {
        // 钻石不够 —— 这是充值弹窗最该出现的时刻
        this.maybeOffer(true);
        return;
      }
    }

    if (kind === 'hint') {
      const h = this.game.hint();
      if (h) this.hinted = [h.from, h.to];
    }
  }

  private async onOverlayButton(id: string): Promise<void> {
    if (id === 'next') {
      this.startLevel(this.levelId + 1);
      return;
    }
    if (id === 'retry') {
      this.startLevel(this.levelId);
      return;
    }
    if (id === 'revive-ad') {
      this.busy = '正在播放激励视频…';
      const r = await this.revive.reviveByAd(this.game);
      this.busy = null;
      if (r.ok) {
        this.adRevivesThisSession++;
        this.toast = { text: `+${r.pens} 个空栏位`, at: this.host.now() };
        this.maybeOffer(false);
      }
      return;
    }
    if (id === 'revive-gem') {
      const r = this.revive.reviveByDiamond(this.game);
      if (!r.ok) this.maybeOffer(true);
      return;
    }
    if (id === 'offer-close') {
      if (this.pendingOffer) this.offers.markDismissed(this.pendingOffer as never);
      this.pendingOffer = null;
      return;
    }
    if (id === 'offer-buy') {
      // 真机上这里调 tt 的虚拟支付；demo 里只关掉弹窗。
      // 支付成功后必须由**服务端**校验收据再发货，见 docs/06。
      this.pendingOffer = null;
      this.toast = { text: '（demo 不接支付）', at: this.host.now() };
      return;
    }
  }

  /** 在自然断点问一次触发引擎该不该弹充值。绝不在游戏进行中弹。 */
  private maybeOffer(blockedByGems: boolean): void {
    if (this.pendingOffer) return;
    const d = this.offers.decide(
      {
        totalDays: 1,
        streakDays: 1,
        adsWatchedTotal: this.adsWatchedTotal,
        adRevivesThisSession: this.adRevivesThisSession,
        interstitialsSeen: this.interstitialsSeen,
        gems: this.wallet.diamonds(),
        levelId: this.levelId,
        failsThisLevel: this.failsThisLevel,
        justBlockedByGems: blockedByGems,
      },
      this.entitlements,
      this.platform.now(),
    );
    if (d.show) {
      this.pendingOffer = d.offer.id;
      this.offers.markShown(d.offer.id, this.platform.now());
    }
  }

  // ─────────────────────────────────────────────── 渲染

  private render(): void {
    this.game.tickTimeout();
    const vm = this.buildViewModel();
    this.hits = draw(this.host.ctx, vm, this.host);
  }

  private buildViewModel(): ViewModel {
    const g = this.game;
    const run = this.selected !== null ? g.topRunOf(this.selected) : null;

    const droppable: number[] = [];
    if (this.selected !== null) {
      for (let i = 0; i < g.penCount; i++) {
        if (i !== this.selected && g.canMove(this.selected, i)) droppable.push(i);
      }
    }

    const toastAge = this.toast ? this.host.now() - this.toast.at : Infinity;
    if (toastAge > 800) this.toast = null;

    return {
      levelName: g.level.name,
      remaining: g.remaining,
      score: g.score,
      gems: this.wallet.diamonds(),
      moves: g.moves,
      parMoves: g.parMoves,
      pens: g.pens,
      capacity: g.penCapacity,
      selected: this.selected,
      liftCount: run?.count ?? 0,
      droppable,
      hinted: this.hinted,
      unsolvable: g.status === 'playing' && !g.isSolvable(),
      items: ITEM_ORDER.map((kind) => ({
        kind,
        state: this.shop.buttonState(g, kind),
        count: g.itemCount(kind),
      })),
      overlay: this.buildOverlay(),
      toast: this.toast ? { text: this.toast.text, ageMs: toastAge } : null,
      busy: this.busy,
    };
  }

  private buildOverlay(): ViewModel['overlay'] {
    // 充值弹窗优先级最高（只在自然断点被 maybeOffer 打开）
    if (this.pendingOffer) {
      return {
        emoji: '🎁',
        title: '给你留了个礼包',
        desc: `触发：${this.pendingOffer}。真机上这里接抖音虚拟支付。`,
        buttons: [
          { id: 'offer-buy', label: '看看', primary: true },
          { id: 'offer-close', label: '不用了', primary: false },
        ],
      };
    }

    const g = this.game;
    if (g.status === 'won') {
      return {
        emoji: '🎉',
        title: '全部出栏！',
        desc: `用了 ${g.moves} 步（最优 ${g.parMoves} 步）`,
        stars: g.stars(),
        buttons: [
          { id: 'next', label: '下一关', primary: true },
          { id: 'retry', label: '重玩本关', primary: false },
        ],
      };
    }
    if (g.status === 'lost') {
      const offer = this.revive.offer();
      const buttons: { id: string; label: string; primary: boolean }[] = [];
      let desc = offer.kind === 'none' ? offer.reason : '';

      if (offer.kind === 'ad') {
        desc = `看一段视频，给你 ${offer.extraPens} 个空栏位，并保证接下来打得通。`;
        buttons.push({ id: 'revive-ad', label: '📺 看广告继续', primary: true });
      } else if (offer.kind === 'diamond') {
        desc = `花 ${offer.cost} 💎 换 ${offer.extraPens} 个空栏位？`;
        buttons.push({ id: 'revive-gem', label: `💎 ${offer.cost} 复活`, primary: true });
      }
      buttons.push({ id: 'retry', label: '重玩本关', primary: false });
      return { emoji: '😵', title: '羊圈塞满了', desc, buttons };
    }
    return null;
  }
}
