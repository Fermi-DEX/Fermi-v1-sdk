import { PublicKey } from '@solana/web3.js';

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

export class ContinuumHarnessClient {
  constructor(
    readonly baseUrl: string,
    readonly opts?: {
      relayIngestBearerToken?: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private get fetchImpl(): typeof fetch {
    return this.opts?.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const response = await this.fetchImpl(`${normalizeBaseUrl(this.baseUrl)}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(headers || {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
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

  async ingestRelayIntent(
    intent: RelayIntentAcceptedRequest,
  ): Promise<{ ok: boolean; key: string }> {
    const headers: Record<string, string> = {};
    if (this.opts?.relayIngestBearerToken) {
      headers.Authorization = `Bearer ${this.opts.relayIngestBearerToken}`;
    }
    return await this.request<{ ok: boolean; key: string }>(
      'POST',
      '/ingest/relay-intent',
      intent,
      headers,
    );
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

  async adminReplay(): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>('POST', '/admin/replay', {});
  }
}
