import { PublicKey } from '@solana/web3.js';
import {
  API_KEY_HEADER,
  RateLimitedError,
  readRateLimitHeaders,
  requireApiKey,
} from './auth';

export type QueueView = 'optimistic' | 'confirmed';

export type HarnessApiError = {
  status: number;
  message: string;
  body: string;
};

export type HarnessHealth = {
  ok: boolean;
  mode?: string;
  backend?: string;
  instance_id?: string;
  pid?: number;
  intents_total?: number;
  divergences_total?: number;
  markets_total?: number;
  users_total?: number;
  queue_views_total?: number;
  sse_clients?: number;
  airdrop_enabled?: boolean;
  airdrop_deposit_enabled?: boolean;
  generated_ts_ms?: number;
  [key: string]: unknown;
};

export type HarnessLiveness = {
  ok: boolean;
  ts_ms: number;
};

export type OpenOrderSummary = {
  order_id?: string;
  owner?: string;
  mango_account?: string;
  market?: string;
  side?: 'bid' | 'ask' | string;
  price_lots?: string;
  base_lots?: string;
  quote_lots?: string;
  client_order_id?: string;
  sequence?: string;
  status?: string;
  [key: string]: unknown;
};

export type MarketState = {
  market: string;
  bids: Array<{ price_lots: string; base_lots: string; [key: string]: unknown }>;
  asks: Array<{ price_lots: string; base_lots: string; [key: string]: unknown }>;
  open_orders: OpenOrderSummary[];
  watermarks?: {
    optimistic_seq?: string;
    confirmed_seq?: string;
    last_slot?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type UserState = {
  owner: string;
  mango_accounts?: string[];
  open_orders?: OpenOrderSummary[];
  per_market?: Array<Record<string, unknown>>;
  margin_summary?: Record<string, unknown>;
  [key: string]: unknown;
};

export type QueueState = {
  market: string;
  pending_count?: number;
  processed_count?: number;
  failed_count?: number;
  skipped_count?: number;
  last_processed_sequence?: string;
  lag_slots?: string;
  unmatched_processed_count?: number;
  [key: string]: unknown;
};

export type UserBalances = Record<string, unknown>;
export type MarketTrade = Record<string, unknown>;
export type MarketCandle = Record<string, unknown>;
export type EngineSnapshot = Record<string, unknown>;
export type HarnessStateFullMarket = Record<string, unknown>;

export type HarnessConfigToken = {
  token_index: number;
  symbol: string;
  mint: string;
  bank: string;
  vault: string;
  oracle: string;
  mint_info?: string;
  token_program?: string;
  decimals?: number;
  [key: string]: unknown;
};

export type HarnessConfigMarket = {
  market_index: number;
  name: string;
  base_symbol?: string;
  quote_symbol?: string;
  perp_market: string;
  bids: string;
  asks: string;
  event_queue: string;
  oracle: string;
  base_decimals?: number;
  quote_decimals?: number;
  base_lot_size?: string;
  quote_lot_size?: string;
  execution_queue?: {
    address: string;
    direct_pool?: string;
    layout_version?: number;
    capacity?: number;
    replay_cache_capacity?: number;
    bytes?: number;
    soft_limit?: number;
    gap_wait_slots?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type HarnessDeploymentConfig = {
  version: number;
  generated_ts_ms?: number;
  mode?: string;
  cluster?: string;
  rpc_url?: string;
  program_id: string;
  group: string;
  group_num?: number;
  authority_state?: string;
  ctm_signer?: string;
  admins?: Record<string, string>;
  queue_mode?: string;
  address_lookup_tables?: string[];
  tokens?: Record<string, HarnessConfigToken>;
  markets: HarnessConfigMarket[];
  endpoints?: Record<string, string>;
  [key: string]: unknown;
};

export type HarnessAirdropRequest = {
  owner: string;
  ui_amount?: number;
};

export type HarnessAirdropResponse = {
  ok: boolean;
  owner: string;
  mint?: string;
  destination_token_account?: string;
  ui_amount?: number;
  raw_amount?: string;
  tx_signature?: string;
  [key: string]: unknown;
};

export type HarnessAirdropDepositRequest = {
  owner: string;
  mango_account?: string;
};

export type HarnessAirdropDepositResponse = {
  ok: boolean;
  owner: string;
  mango_account?: string;
  group?: string;
  mint?: string;
  ui_amount?: number;
  raw_amount?: string;
  unsafe_deposit_tx_signature?: string;
  execution_path?: string;
  [key: string]: unknown;
};

export type RelayIntentAcceptedRequest = Record<string, unknown>;

export type SimulateTradeRequest = {
  kind?: 'perp_place_order';
  market?: string | number;
  market_index?: number;
  side: 'buy' | 'sell' | 'bid' | 'ask' | 'long' | 'short';
  quantity: number;
  price?: number | null;
  order_type?: 'limit' | 'market' | 'ioc' | 'postonly' | 'postonlyslide';
  reduce_only?: boolean;
};

export type SimulateRequest = {
  owner: PublicKey | string;
  mango_account?: PublicKey | string;
  trade: SimulateTradeRequest;
};

export type SimulateMarginSnapshot = {
  equity_ui_quote: number;
  init_health_ui_quote: number;
  maint_health_ui_quote: number;
  init_health_ratio: number;
  maint_health_ratio: number;
};

export type SimulateResponse = {
  view: 'optimistic';
  owner: string;
  mango_account: string;
  cached_age_ms: number;
  snapshot_age_ms: number | null;
  optimistic_overlay_applied: boolean;
  optimistic_markets_applied: string[];
  trade: {
    kind: 'perp_place_order';
    market: string;
    market_index: number;
    side: 'buy' | 'sell';
    quantity_ui: number;
    base_lots: string;
    price_ui: number;
    price_source: 'caller' | 'oracle';
    order_type: string;
    reduce_only: boolean;
  };
  before: SimulateMarginSnapshot;
  after: SimulateMarginSnapshot;
  delta: {
    equity_ui_quote: number;
    init_health_ui_quote: number;
    maint_health_ui_quote: number;
  };
  would_reject: boolean;
  reject_reasons: string[];
  warnings: string[];
  compute_ms: number;
};

export type SimulateWarmRequest = {
  owner: PublicKey | string;
  mango_account?: PublicKey | string;
};

export type SimulateWarmResponse = {
  owner: string;
  group: string;
  cached_mango_accounts: string[];
  cache_ttl_ms: number;
  load_ms: number;
};

type MarketListItem = {
  market: string;
  view: QueueView;
  data: MarketState;
  [key: string]: unknown;
};

type HarnessMarketsResponse = {
  items: MarketListItem[];
};

type HarnessMarketStateResponse = {
  view: QueueView;
  market: string;
  data: MarketState;
  [key: string]: unknown;
};

type HarnessTradesResponse = {
  view: QueueView;
  data: MarketTrade[];
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function toBase58(value?: PublicKey | string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value instanceof PublicKey ? value.toBase58() : value;
}

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const entries = Object.entries(query).filter(([, value]) => value !== undefined);
  if (!entries.length) {
    return path;
  }
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    params.set(key, value!);
  }
  return `${path}?${params.toString()}`;
}

export type ContinuumHarnessClientOptions = {
  /** Continuum proxy gateway REST base URL, e.g. `https://gateway.fermi.xyz`. */
  gatewayUrl: string;
  /** UUID API key — sent on every request as `x-api-key`. Required. */
  apiKey: string;
  fetchImpl?: typeof fetch;
};

export class ContinuumHarnessClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly _fetch: typeof fetch;

  constructor(opts: ContinuumHarnessClientOptions) {
    if (!opts || !opts.gatewayUrl) {
      throw new Error('ContinuumHarnessClient: gatewayUrl is required');
    }
    this.apiKey = requireApiKey(opts.apiKey, 'ContinuumHarnessClient');
    this.baseUrl = normalizeBaseUrl(opts.gatewayUrl);
    this._fetch = opts.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const response = await this._fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        [API_KEY_HEADER]: this.apiKey,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(headers || {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (response.status === 429) {
      const info = readRateLimitHeaders(response.headers);
      throw new RateLimitedError(
        `gateway rate limit hit on ${method} ${path}`,
        { ...info, body: text },
      );
    }
    if (!response.ok) {
      const err: HarnessApiError = {
        status: response.status,
        message: `harness request failed ${method} ${path}`,
        body: text,
      };
      throw err;
    }
    return text.length ? (JSON.parse(text) as T) : (undefined as T);
  }

  async healthz(): Promise<HarnessHealth> {
    return await this.request<HarnessHealth>('GET', '/healthz');
  }

  async livez(): Promise<HarnessLiveness> {
    return await this.request<HarnessLiveness>('GET', '/livez');
  }

  async getConfig(): Promise<HarnessDeploymentConfig> {
    return await this.request<HarnessDeploymentConfig>('GET', '/config');
  }

  async getBootstrap(): Promise<HarnessDeploymentConfig> {
    return await this.request<HarnessDeploymentConfig>('GET', '/state/bootstrap');
  }

  async getMarkets(params?: {
    markets?: Array<string | number>;
    view?: QueueView;
    depth?: number;
    book?: 'summary' | 'full';
  }): Promise<MarketListItem[]> {
    const response = await this.request<HarnessMarketsResponse>(
      'GET',
      withQuery('/state/markets', {
        view: params?.view ?? 'optimistic',
        depth: params?.depth !== undefined ? String(Math.max(1, Math.floor(params.depth))) : undefined,
        book: params?.book,
        markets: params?.markets?.length
          ? params.markets.map((market) => String(market)).join(',')
          : undefined,
      }),
    );
    return response.items;
  }

  async getMarketStateDetails(
    market: string | number,
    params?: { view?: QueueView; depth?: number },
  ): Promise<HarnessMarketStateResponse> {
    return await this.request<HarnessMarketStateResponse>(
      'GET',
      withQuery(`/state/markets/${encodeURIComponent(String(market))}`, {
        view: params?.view ?? 'optimistic',
        depth: params?.depth !== undefined ? String(Math.max(1, Math.floor(params.depth))) : undefined,
      }),
    );
  }

  async getMarketState(
    market: string | number,
    view: QueueView = 'optimistic',
  ): Promise<MarketState> {
    const response = await this.getMarketStateDetails(market, { view });
    return response.data;
  }

  async getUserState(
    owner: PublicKey | string,
    view: QueueView = 'optimistic',
  ): Promise<UserState> {
    const ownerPk = toBase58(owner)!;
    const response = await this.request<{ view: QueueView; data: UserState }>(
      'GET',
      withQuery(`/state/users/${encodeURIComponent(ownerPk)}`, { view }),
    );
    return response.data;
  }

  async getOrders(params: {
    market: string | number;
    owner?: PublicKey | string;
    view?: QueueView;
  }): Promise<OpenOrderSummary[]> {
    const response = await this.request<{
      view: QueueView;
      market: string;
      owner: string | null;
      data: OpenOrderSummary[];
    }>(
      'GET',
      withQuery(`/state/orders/${encodeURIComponent(String(params.market))}`, {
        view: params.view ?? 'optimistic',
        owner: toBase58(params.owner),
      }),
    );
    return response.data;
  }

  async getQueueState(market: string | number): Promise<QueueState> {
    const response = await this.request<{ market: string; data: QueueState }>(
      'GET',
      `/state/queue/${encodeURIComponent(String(market))}`,
    );
    return response.data;
  }

  async getBalances(
    owner: PublicKey | string,
    view: QueueView = 'optimistic',
  ): Promise<UserBalances> {
    const ownerPk = toBase58(owner)!;
    const response = await this.request<{ view: QueueView; data: UserBalances }>(
      'GET',
      withQuery(`/state/balances/${encodeURIComponent(ownerPk)}`, { view }),
    );
    return response.data;
  }

  async queryTrades(params: {
    market?: string | number;
    owner?: PublicKey | string;
    view?: QueueView;
    limit?: number;
  }): Promise<MarketTrade[]> {
    const response = await this.request<HarnessTradesResponse>(
      'GET',
      withQuery('/state/trades', {
        view: params.view ?? 'optimistic',
        market: params.market !== undefined ? String(params.market) : undefined,
        owner: toBase58(params.owner),
        limit: params.limit !== undefined ? String(Math.max(0, Math.floor(params.limit))) : undefined,
      }),
    );
    return response.data;
  }

  async getTrades(params: {
    market: string | number;
    view?: QueueView;
    limit?: number;
  }): Promise<MarketTrade[]> {
    const response = await this.request<{
      view: QueueView;
      market: string;
      data: MarketTrade[];
    }>(
      'GET',
      withQuery(`/state/trades/${encodeURIComponent(String(params.market))}`, {
        view: params.view ?? 'optimistic',
        limit: params.limit !== undefined ? String(Math.max(0, Math.floor(params.limit))) : undefined,
      }),
    );
    return response.data;
  }

  async getCandles(params: {
    market: string | number;
    view?: QueueView;
    resolutionSec?: number;
    limit?: number;
  }): Promise<MarketCandle[]> {
    const response = await this.request<{
      view: QueueView;
      market: string;
      data: MarketCandle[];
    }>(
      'GET',
      withQuery(`/state/candles/${encodeURIComponent(String(params.market))}`, {
        view: params.view ?? 'optimistic',
        resolution_sec:
          params.resolutionSec !== undefined ? String(Math.max(1, Math.floor(params.resolutionSec))) : undefined,
        limit: params.limit !== undefined ? String(Math.max(0, Math.floor(params.limit))) : undefined,
      }),
    );
    return response.data;
  }

  async getFullState(view: QueueView = 'optimistic'): Promise<EngineSnapshot> {
    return await this.request<EngineSnapshot>('GET', withQuery('/state/full', { view }));
  }

  async getFullStateForMarket(
    market: string | number,
    view: QueueView = 'optimistic',
  ): Promise<HarnessStateFullMarket> {
    return await this.request<HarnessStateFullMarket>(
      'GET',
      withQuery('/state/full', { market: String(market), view }),
    );
  }

  /**
   * Submit a relay intent through the proxy. The gateway exposes this as
   * `POST /relay/submit-intent`; auth is the x-api-key header already set by
   * `request()` (plus the proxy's own wallet-auth gate where applicable).
   */
  async submitRelayIntent(
    intent: RelayIntentAcceptedRequest,
  ): Promise<{ ok: boolean; key: string }> {
    return await this.request<{ ok: boolean; key: string }>(
      'POST',
      '/relay/submit-intent',
      intent,
    );
  }

  /** @deprecated renamed to {@link submitRelayIntent}. */
  async ingestRelayIntent(
    intent: RelayIntentAcceptedRequest,
  ): Promise<{ ok: boolean; key: string }> {
    return this.submitRelayIntent(intent);
  }

  async airdropUsdc(
    params: HarnessAirdropRequest,
  ): Promise<HarnessAirdropResponse> {
    return await this.request<HarnessAirdropResponse>('POST', '/airdrop', params);
  }

  async airdropDepositUsdc(
    params: HarnessAirdropDepositRequest,
  ): Promise<HarnessAirdropDepositResponse> {
    return await this.request<HarnessAirdropDepositResponse>(
      'POST',
      '/airdrop-deposit',
      params,
    );
  }

  /**
   * @deprecated Internal admin path; the proxy gateway does not expose
   * `/admin/replay`. Only usable against a direct-harness deployment.
   */
  async adminReplay(): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>('POST', '/admin/replay', {});
  }

  // Prefetch a user's MangoAccount(s) into the harness's in-process simulate
  // cache. Pair with simulate() for sub-ms hot-path responses while a UI is
  // tracking a live quantity input. Cache TTL is reported in the response.
  async simulateWarm(
    params: SimulateWarmRequest,
  ): Promise<SimulateWarmResponse> {
    return await this.request<SimulateWarmResponse>('POST', '/simulate/warm', {
      owner: toBase58(params.owner)!,
      mango_account: toBase58(params.mango_account),
    });
  }

  // Project a proposed trade onto the optimistic harness state and return
  // before/after margin numbers plus a rejection flag. Reads cache only —
  // call simulateWarm() (or any /state/users/<owner> endpoint) first.
  async simulate(params: SimulateRequest): Promise<SimulateResponse> {
    return await this.request<SimulateResponse>('POST', '/simulate', {
      owner: toBase58(params.owner)!,
      mango_account: toBase58(params.mango_account),
      trade: params.trade,
    });
  }
}
