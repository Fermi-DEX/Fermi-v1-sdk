/**
 * Typed stream subscribers for the Continuum proxy gateway.
 *
 * Two transports:
 *
 *  • Server-Sent Events (SSE) — `/state/stream*`, `/v2/events/:market`,
 *    `/v2/stream/trades`, `/v2/stream/frontend/:market`. Auth: `x-api-key`
 *    header. Each frame is delivered as `{ event, id?, data }`. Frames whose
 *    body is JSON are surfaced as parsed objects; non-JSON bodies come back
 *    as the raw string.
 *
 *  • WebSocket — the `/ticks` channel exposed by the proxy on its WS port
 *    (default 50053 / `wss://.../ws/ticks` behind Caddy). Auth: `?api_key=`
 *    query param (the server also accepts the same header on the upgrade
 *    request).
 *
 * Every subscriber returns an `AsyncIterable` — drive it with `for await`,
 * and pass an `AbortSignal` (or call the returned `close()`) to stop.
 */

import {
  API_KEY_HEADER,
  RateLimitedError,
  readRateLimitHeaders,
  requireApiKey,
} from './auth';

/** One frame off an SSE connection. */
export type SseFrame<T = unknown> = {
  /** SSE `event:` line. Defaults to `'message'` (per spec). */
  event: string;
  /** SSE `id:` line, when present. For `/v2/events/:market` this is the Redis stream id; pass it back as `from` (or `Last-Event-ID`) to resume. */
  id?: string;
  /** Parsed JSON object if the data was JSON; otherwise the raw string. */
  data: T;
  /** The original `data:` text. */
  raw: string;
};

/** Subscribed source. Iterate with `for await`; call `close()` to stop early. */
export type Subscription<T> = AsyncIterable<T> & {
  close(): void;
};

// ── Frame parser ────────────────────────────────────────────────────

/**
 * Incremental SSE parser: feed it chunks of bytes / strings, drain it for
 * complete frames. Implements the subset of the EventSource spec the proxy
 * actually emits (no multi-line `data:`, no `retry:`).
 */
class SseParser {
  private buf = '';
  private cur: { event?: string; id?: string; data: string[] } = { data: [] };
  private readonly decoder = new TextDecoder('utf-8');

  push(chunk: Uint8Array | string): SseFrame[] {
    this.buf +=
      typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const out: SseFrame[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (line === '') {
        const frame = this.flush();
        if (frame) out.push(frame);
        continue;
      }
      // Comment / keep-alive (`:` lines) — ignore.
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      // Per spec, a single leading space after the colon is stripped.
      const value =
        colon === -1
          ? ''
          : line[colon + 1] === ' '
          ? line.slice(colon + 2)
          : line.slice(colon + 1);
      if (field === 'event') this.cur.event = value;
      else if (field === 'id') this.cur.id = value;
      else if (field === 'data') this.cur.data.push(value);
    }
    return out;
  }

  private flush(): SseFrame | undefined {
    if (this.cur.data.length === 0 && this.cur.event === undefined && this.cur.id === undefined) {
      return undefined;
    }
    const raw = this.cur.data.join('\n');
    let parsed: unknown = raw;
    if (raw.length && (raw[0] === '{' || raw[0] === '[')) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* fall through with raw string */
      }
    }
    const frame: SseFrame = {
      event: this.cur.event ?? 'message',
      id: this.cur.id,
      data: parsed,
      raw,
    };
    this.cur = { data: [] };
    return frame;
  }
}

// ── SSE subscribe primitive ─────────────────────────────────────────

type SseOptions = {
  gatewayUrl: string;
  apiKey: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  /** Forwarded as `Last-Event-ID`; v2/events also accepts it as `?from=`. */
  lastEventId?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

function buildUrl(base: string, path: string, query?: SseOptions['query']): string {
  const cleaned = base.replace(/\/+$/, '');
  const url = `${cleaned}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * Open an SSE connection and yield each frame. Throws `RateLimitedError` on
 * 429 from the gateway; everything else surfaces as a plain `Error` with the
 * status + body.
 */
function sseSubscribe<T = unknown>(opts: SseOptions): Subscription<SseFrame<T>> {
  const controller = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const url = buildUrl(opts.gatewayUrl, opts.path, opts.query);
  const headers: Record<string, string> = {
    [API_KEY_HEADER]: opts.apiKey,
    accept: 'text/event-stream',
  };
  if (opts.lastEventId) headers['last-event-id'] = opts.lastEventId;

  // Buffer + waiter implement a simple async queue so producer (chunk reader)
  // and consumer (for-await) are decoupled.
  const queue: SseFrame<T>[] = [];
  let waiter: ((v: IteratorResult<SseFrame<T>>) => void) | undefined;
  let done = false;
  let error: unknown;
  const finish = (err?: unknown) => {
    if (done) return;
    done = true;
    if (err) error = err;
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      if (err) w(Promise.reject(err) as unknown as IteratorResult<SseFrame<T>>);
      else w({ value: undefined as unknown as SseFrame<T>, done: true });
    }
  };

  const fetchImpl = opts.fetchImpl ?? fetch;
  // Connection loop runs in the background; pump frames into queue.
  (async () => {
    try {
      const resp = await fetchImpl(url, { headers, signal: controller.signal });
      if (resp.status === 429) {
        const body = await resp.text().catch(() => '');
        throw new RateLimitedError(`gateway rate limit hit on GET ${opts.path}`, {
          ...readRateLimitHeaders(resp.headers),
          body,
        });
      }
      if (!resp.ok || !resp.body) {
        const body = await resp.text().catch(() => '');
        throw new Error(`SSE GET ${opts.path} failed: HTTP ${resp.status} ${body}`);
      }
      const parser = new SseParser();
      const reader = resp.body.getReader();
      while (true) {
        const { value, done: chunkDone } = await reader.read();
        if (chunkDone) break;
        if (!value) continue;
        for (const f of parser.push(value)) {
          const frame = f as SseFrame<T>;
          if (waiter) {
            const w = waiter;
            waiter = undefined;
            w({ value: frame, done: false });
          } else {
            queue.push(frame);
          }
        }
      }
      finish();
    } catch (err) {
      // Aborts via close()/signal are expected; surface as a clean end.
      if (controller.signal.aborted) finish();
      else finish(err);
    }
  })();

  const iterator: AsyncIterator<SseFrame<T>> = {
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
      if (done) {
        return error
          ? Promise.reject(error)
          : Promise.resolve({ value: undefined as unknown as SseFrame<T>, done: true });
      }
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    return() {
      controller.abort();
      finish();
      return Promise.resolve({ value: undefined as unknown as SseFrame<T>, done: true });
    },
  };

  return {
    [Symbol.asyncIterator]: () => iterator,
    close: () => {
      controller.abort();
      finish();
    },
  };
}

// ── Typed event shapes ──────────────────────────────────────────────

/** Generic event off `/state/stream` and `/state/stream/frontend`. */
export type HarnessStateEvent = {
  event_type?: string;
  payload?: Record<string, unknown>;
  ts_ms?: number;
  [key: string]: unknown;
};

/** Per-trade frame off `/state/stream/trades` and `/v2/stream/trades`. */
export type StreamTrade = {
  market?: string;
  market_index?: number;
  trade_id?: string | number;
  ts_ms?: number;
  price_lots?: string;
  base_lots?: string;
  quote_lots?: string;
  taker_side?: 'buy' | 'sell';
  maker_owner?: string;
  taker_owner?: string;
  maker_order_id?: string;
  taker_sequence?: string | null;
  [key: string]: unknown;
};

/** Known v2 event types emitted by the Redis stream tailer. */
export type V2MarketEventType =
  | 'order_placed'
  | 'order_cancelled'
  | 'order_filled'
  | 'trade'
  | 'book_update'
  | 'resync'
  | 'backfill_error'
  | string;

/** A single frame off `/v2/events/:market`. `data` is the JSON object the gateway emits (event_type + payload + ts). */
export type V2MarketEvent = {
  event_type?: V2MarketEventType;
  payload?: Record<string, unknown>;
  ts?: string;
  [key: string]: unknown;
};

/** Atomic `(book, cursor)` pair from `/v2/events/snapshot-and-stream/:market`. */
export type MarketSnapshotAndCursor = {
  market: number;
  view: 'opt' | 'conf' | string;
  /** Redis stream id; pass this to `subscribeMarketEvents({ from })` for gap-free resume. */
  cursor: string;
  snapshot: {
    bids: Array<{ price: number; order_id: string; order: Record<string, unknown> | null }>;
    asks: Array<{ price: number; order_id: string; order: Record<string, unknown> | null }>;
  };
};

/** Single tick batch off the WebSocket `/ticks` channel. */
export type TickStreamMessage = {
  type: 'ticks';
  count: number;
  data: Array<Record<string, unknown>>;
};

// ── Public API ──────────────────────────────────────────────────────

type CommonOpts = {
  gatewayUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

/**
 * Tail the harness state stream (every market). Yields frames with the
 * gateway's `event:` line as `event`.
 */
export function subscribeStateStream(
  opts: CommonOpts,
): Subscription<SseFrame<HarnessStateEvent>> {
  requireApiKey(opts.apiKey, 'subscribeStateStream');
  return sseSubscribe<HarnessStateEvent>({ ...opts, path: '/state/stream' });
}

/**
 * Tail the frontend-tailored state stream. The gateway requires at least
 * one of `owner`, `mangoAccount`, or `market` so it can scope the feed; pass
 * the same fields a UI would use to filter.
 */
export function subscribeFrontendStream(
  opts: CommonOpts & {
    owner?: string;
    mangoAccount?: string;
    market?: number | string;
  },
): Subscription<SseFrame<HarnessStateEvent>> {
  requireApiKey(opts.apiKey, 'subscribeFrontendStream');
  if (!opts.owner && !opts.mangoAccount && opts.market === undefined) {
    throw new Error(
      'subscribeFrontendStream: at least one of owner / mangoAccount / market is required',
    );
  }
  return sseSubscribe<HarnessStateEvent>({
    ...opts,
    path: '/state/stream/frontend',
    query: {
      owner: opts.owner,
      mango_account: opts.mangoAccount,
      market: opts.market !== undefined ? String(opts.market) : undefined,
    },
  });
}

/**
 * Tail the legacy harness trade stream (`/state/stream/trades`). All markets,
 * one trade per frame.
 */
export function subscribeTradeStream(
  opts: CommonOpts,
): Subscription<SseFrame<StreamTrade>> {
  requireApiKey(opts.apiKey, 'subscribeTradeStream');
  return sseSubscribe<StreamTrade>({ ...opts, path: '/state/stream/trades' });
}

/**
 * Tail the v2 (Redis-backed) trade stream — `/v2/stream/trades`. Lower
 * latency and durable; prefer this over {@link subscribeTradeStream} where
 * available.
 */
export function subscribeV2TradeStream(
  opts: CommonOpts,
): Subscription<SseFrame<StreamTrade>> {
  requireApiKey(opts.apiKey, 'subscribeV2TradeStream');
  return sseSubscribe<StreamTrade>({ ...opts, path: '/v2/stream/trades' });
}

/**
 * Tail per-market market events from the v2 Redis stream.
 *
 * Resume semantics: if `from` is supplied (or `Last-Event-ID` is set via
 * `lastEventId`), the gateway replays bounded backfill before attaching to
 * live. Use {@link snapshotAndStreamMarket} to get a gap-free `(book,
 * cursor)` pair in one shot.
 */
export function subscribeMarketEvents(
  opts: CommonOpts & {
    market: number | string;
    /** Redis stream id to resume from. */
    from?: string;
    /** Equivalent to `Last-Event-ID`. Server treats this the same as `from`. */
    lastEventId?: string;
  },
): Subscription<SseFrame<V2MarketEvent>> {
  requireApiKey(opts.apiKey, 'subscribeMarketEvents');
  return sseSubscribe<V2MarketEvent>({
    ...opts,
    path: `/v2/events/${encodeURIComponent(String(opts.market))}`,
    query: { from: opts.from },
    lastEventId: opts.lastEventId,
  });
}

/**
 * Tail per-market frontend stream (`/v2/stream/frontend/:market`). Same SSE
 * frame shape as {@link subscribeMarketEvents} but pre-filtered for UI.
 */
export function subscribeMarketFrontendStream(
  opts: CommonOpts & { market: number | string },
): Subscription<SseFrame<V2MarketEvent>> {
  requireApiKey(opts.apiKey, 'subscribeMarketFrontendStream');
  return sseSubscribe<V2MarketEvent>({
    ...opts,
    path: `/v2/stream/frontend/${encodeURIComponent(String(opts.market))}`,
  });
}

/**
 * One-shot `(book, cursor)` snapshot from `/v2/events/snapshot-and-stream/:market`.
 * Feed `cursor` into {@link subscribeMarketEvents}({ from }) to resume without
 * dropping or duplicating events.
 */
export async function snapshotAndStreamMarket(
  opts: CommonOpts & { market: number | string },
): Promise<MarketSnapshotAndCursor> {
  requireApiKey(opts.apiKey, 'snapshotAndStreamMarket');
  const url = buildUrl(
    opts.gatewayUrl,
    `/v2/events/snapshot-and-stream/${encodeURIComponent(String(opts.market))}`,
  );
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resp = await fetchImpl(url, {
    headers: { [API_KEY_HEADER]: opts.apiKey },
    signal: opts.signal,
  });
  if (resp.status === 429) {
    const body = await resp.text().catch(() => '');
    throw new RateLimitedError('gateway rate limit hit on snapshot-and-stream', {
      ...readRateLimitHeaders(resp.headers),
      body,
    });
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(
      `snapshot-and-stream failed: HTTP ${resp.status} ${body}`,
    );
  }
  return (await resp.json()) as MarketSnapshotAndCursor;
}

// ── WebSocket: /ticks ───────────────────────────────────────────────

export type TickStreamOptions = {
  /**
   * Full WebSocket URL — e.g. `wss://v1.fermi.trade/ws/ticks` (Caddy-fronted)
   * or `ws://localhost:50053/ticks` (direct). The gateway accepts the key as
   * a query param or via the standard `authorization` header.
   */
  wsUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  /** Inject a WebSocket implementation. Defaults to globalThis.WebSocket (Node 22+ or browser). */
  webSocketImpl?: typeof WebSocket;
};

/**
 * Subscribe to the proxy's batched tick stream over WebSocket. Yields one
 * `TickStreamMessage` per server-sent batch (default ~10/s, batched at the
 * gateway by `BATCH_INTERVAL_MS`). Iteration ends cleanly when the socket
 * closes or `signal` aborts.
 */
export function subscribeTicks(
  opts: TickStreamOptions,
): Subscription<TickStreamMessage> {
  requireApiKey(opts.apiKey, 'subscribeTicks');
  const WS = opts.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) {
    throw new Error(
      'subscribeTicks: no WebSocket available. Pass webSocketImpl (e.g. `ws` package) or run on Node 22+ / a browser.',
    );
  }

  const url = new URL(opts.wsUrl);
  if (!url.searchParams.has('api_key')) {
    url.searchParams.set('api_key', opts.apiKey);
  }
  const socket = new WS(url.toString());

  const queue: TickStreamMessage[] = [];
  let waiter: ((v: IteratorResult<TickStreamMessage>) => void) | undefined;
  let done = false;
  let error: unknown;
  const finish = (err?: unknown) => {
    if (done) return;
    done = true;
    if (err) error = err;
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      if (err) w(Promise.reject(err) as unknown as IteratorResult<TickStreamMessage>);
      else w({ value: undefined as unknown as TickStreamMessage, done: true });
    }
  };
  const close = () => {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    finish();
  };
  if (opts.signal) {
    if (opts.signal.aborted) close();
    else opts.signal.addEventListener('abort', close, { once: true });
  }

  socket.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : ev.data?.toString?.();
    if (!raw) return;
    let parsed: TickStreamMessage;
    try {
      parsed = JSON.parse(raw) as TickStreamMessage;
    } catch {
      return;
    }
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w({ value: parsed, done: false });
    } else {
      queue.push(parsed);
    }
  });
  socket.addEventListener('error', () => {
    finish(new Error('ticks websocket errored'));
  });
  socket.addEventListener('close', () => finish());

  const iterator: AsyncIterator<TickStreamMessage> = {
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
      if (done) {
        return error
          ? Promise.reject(error)
          : Promise.resolve({ value: undefined as unknown as TickStreamMessage, done: true });
      }
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    return() {
      close();
      return Promise.resolve({ value: undefined as unknown as TickStreamMessage, done: true });
    },
  };

  return {
    [Symbol.asyncIterator]: () => iterator,
    close,
  };
}
