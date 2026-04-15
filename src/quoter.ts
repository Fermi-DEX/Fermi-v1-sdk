import { PerpOrderSide, PerpOrderType } from '@blockworks-foundation/mango-v4';
import { MangoContext } from './context';
import { ContinuumHarnessClient, MarketState } from './harness';
import { ContinuumRelayerClient } from './relayerClient';
import {
  cancelPerpOrderByClientIdViaRelayer,
  submitPerpOrderViaRelayer,
} from './trading';

export type FairPriceProvider = () => Promise<number>;

export type RelayerPerpQuoterBotConfig = {
  marketIndex: number;
  side: PerpOrderSide;
  spreadBps: number;
  size: number;
  intervalMs: number;
  orderType?: PerpOrderType;
  maxQuoteQuantity?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

export class CoinGeckoFairPriceProvider {
  private cachedPrice: number | null = null;
  private lastFetchMs = 0;

  constructor(
    private readonly assetId: string,
    private readonly vsCurrency: string,
    private readonly refreshMs = 10_000,
    private readonly apiBase = 'https://api.coingecko.com/api/v3',
  ) {}

  async get(): Promise<number> {
    const now = Date.now();
    if (this.cachedPrice !== null && now - this.lastFetchMs < this.refreshMs) {
      return this.cachedPrice;
    }

    const url =
      `${this.apiBase}/simple/price?ids=${encodeURIComponent(this.assetId)}` +
      `&vs_currencies=${encodeURIComponent(this.vsCurrency)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`coingecko request failed: ${response.status}`);
    }
    const body = (await response.json()) as Record<string, Record<string, number>>;
    const price = body[this.assetId]?.[this.vsCurrency];
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      throw new Error('coingecko returned an invalid fair price');
    }

    this.cachedPrice = price;
    this.lastFetchMs = now;
    return price;
  }
}

export class RelayerPerpQuoterBot {
  private lastClientOrderId: number | null = null;
  private running = false;

  constructor(
    private readonly context: MangoContext,
    private readonly relayer: ContinuumRelayerClient,
    private readonly harness: ContinuumHarnessClient | null,
    private readonly fairPriceProvider: FairPriceProvider,
    private readonly config: RelayerPerpQuoterBotConfig,
  ) {}

  private log(message: string, fields?: Record<string, unknown>): void {
    this.config.log?.(message, fields);
  }

  private computeQuotePrice(fairPrice: number): number {
    const multiplier =
      this.config.side === PerpOrderSide.bid
        ? 1 - this.config.spreadBps / 10_000
        : 1 + this.config.spreadBps / 10_000;
    return fairPrice * multiplier;
  }

  private summarizeTopOfBook(market: MarketState | null): Record<string, unknown> {
    return {
      best_bid_price_lots: market?.bids?.[0]?.price_lots ?? null,
      best_ask_price_lots: market?.asks?.[0]?.price_lots ?? null,
      open_orders: market?.open_orders?.length ?? null,
      optimistic_seq: market?.watermarks?.optimistic_seq ?? null,
      confirmed_seq: market?.watermarks?.confirmed_seq ?? null,
    };
  }

  async tick(): Promise<void> {
    const fairPrice = await this.fairPriceProvider();
    const quotePrice = this.computeQuotePrice(fairPrice);
    const marketState = this.harness
      ? await this.harness.getMarketState(this.config.marketIndex, 'optimistic')
      : null;

    if (this.lastClientOrderId !== null) {
      await cancelPerpOrderByClientIdViaRelayer(this.relayer, this.context, {
        marketIndex: this.config.marketIndex,
        clientOrderId: this.lastClientOrderId,
      });
    }

    const clientOrderId = Date.now();
    const response = await submitPerpOrderViaRelayer(this.relayer, this.context, {
      marketIndex: this.config.marketIndex,
      side: this.config.side,
      price: quotePrice,
      quantity: this.config.size,
      maxQuoteQuantity: this.config.maxQuoteQuantity,
      clientOrderId,
      orderType: this.config.orderType ?? PerpOrderType.postOnlySlide,
    });
    this.lastClientOrderId = clientOrderId;

    this.log('quote_submitted', {
      side: this.config.side === PerpOrderSide.bid ? 'bid' : 'ask',
      fairPrice,
      quotePrice,
      size: this.config.size,
      clientOrderId,
      relayerSequence: response.sequence,
      relayerTxSignature: response.tx_signature,
      ...this.summarizeTopOfBook(marketState),
    });
  }

  async run(): Promise<void> {
    if (this.running) {
      throw new Error('quoter is already running');
    }
    this.running = true;

    while (this.running) {
      const startedAt = Date.now();
      try {
        await this.tick();
      } catch (err) {
        const message = err instanceof Error ? err.message : `${err}`;
        this.log('quote_tick_failed', { error: message });
      }
      const elapsed = Date.now() - startedAt;
      const sleepMs = Math.max(0, this.config.intervalMs - elapsed);
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  stop(): void {
    this.running = false;
  }
}
