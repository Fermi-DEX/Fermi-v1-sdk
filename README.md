# Continuum SDK

Self-contained TypeScript SDK for Fermi / Continuum. **Every call goes through
the Fermi proxy gateway** — there is no longer a direct path to the harness,
fee service, or relayer. The gateway authenticates every request with a
mandatory `x-api-key`, applies per-key rate limits, and forwards REST + gRPC +
SSE + WebSocket traffic to the right upstream.

What you get out of the box:

- gateway-authenticated **REST reads** of market, user, balance, queue,
  trades, candles, and simulation state via `ContinuumHarnessClient`,
- gateway-authenticated **gRPC writes** (perp orders + cancels) through the
  commit/reveal relayer via `ContinuumRelayerClient`,
- gateway-authenticated **fee status / deposit reports** via
  `ContinuumFeeClient`,
- typed **SSE + WebSocket stream subscribers** with `AsyncIterable` ergonomics
  and gap-free resume,
- a Mango v4 `MangoClient` bootstrap (`createMangoContext`) for direct
  on-chain reads, deposits, withdrawals, and account management — Solana RPC
  stays direct (proxy is not in the Solana RPC path).

For the full request/response inventory the gateway exposes, see
[docs/api.md](./docs/api.md).

## Authentication

The SDK refuses to construct any client without a UUID API key. Get one from
your Fermi gateway operator, then set:

```
FERMI_API_URL=https://gateway.fermi.xyz
FERMI_API_GRPC_ADDR=gateway.fermi.xyz:50052
FERMI_API_KEY=00000000-0000-0000-0000-000000000000
```

The key is sent as the `x-api-key` HTTP header (REST + SSE) or gRPC metadata.
Rate-limit hits — 429 on REST/SSE, `RESOURCE_EXHAUSTED` on gRPC — surface as
a typed `RateLimitedError` carrying `limit` / `remaining` / `retryAfter`, so
loops can back off cleanly.

Legacy env vars (`HARNESS_URL`, `RELAYER_ADDR`, `FEE_HTTP_URL`) are no longer
used; if present they emit a one-time warning and are ignored.

## Install

```bash
npm install
npm run build
```

`prepare` runs the build on install. `dist/` is not committed.

## Environment

Copy `.env.example` and fill in the gateway endpoints + your Mango account
context:

```bash
cp .env.example .env
```

Required:

- `FERMI_API_URL`, `FERMI_API_GRPC_ADDR`, `FERMI_API_KEY` — gateway endpoints
  + UUID key (mandatory)
- `CLUSTER_URL` — a Solana RPC reachable from your machine (Helius / Triton /
  your own pool). The Solana public RPC is not viable for Mango IDL fetches.
- `USER_KEYPAIR` — absolute path to a Solana keypair JSON
- `GROUP_PK` — Mango group public key
- `MANGO_ACCOUNT_PK` — Mango account to trade with (or `MANGO_ACCOUNT_NUM` to
  resolve by owner + index)

Optional:

- `CONTINUUM_DEPLOYMENT` — pick a named deployment from `src/deployments.ts`
  (e.g. `fermi-r6-mainnet`). When set, `GROUP_PK` / `PROGRAM_ID` /
  `USDC_MINT` / `FERMI_API_URL` / `FERMI_API_GRPC_ADDR` fall back to the
  deployment's values.
- `PROGRAM_ID` — override the Mango program id
- `USDC_MINT` — override the USDC mint
- `RELAYER_MAX_FEE_LAMPORTS` — relayer fee cap in lamports, or `AUTO`
- `MANGO_ACCOUNT_*` (token / serum3 / perp / perp_oo counts) — slot sizing
  for `create-mango-account`. **Fermi's Mango v4 fork disables serum3 slots;
  set `MANGO_ACCOUNT_SERUM3_COUNT=0`.**
- `COINGECKO_*` — fair-price source tuning for the quoter bot

## CLI scripts

```bash
# read deployment config from the gateway
npm run config

# bootstrap a fresh Mango account (signs an on-chain tx)
npm run create-mango-account

# move USDC between the wallet ATA and the Mango account
USDC_AMOUNT_UI=5 npm run deposit-usdc
USDC_AMOUNT_UI=5 npm run withdraw-usdc

# read account state through the gateway / directly from chain
OWNER=<wallet-pubkey> npm run portfolio
npm run onchain-portfolio

# project a proposed trade onto current state without sending
SIMULATE_OWNER=<wallet> SIMULATE_SIDE=buy SIMULATE_QUANTITY=0.1 \
  SIMULATE_PRICE=80 npm run simulate

# submit a perp order through the relayer (gRPC via the gateway)
PERP_ORDER_SIDE=bid PERP_ORDER_PRICE=80 PERP_ORDER_QUANTITY=0.01 \
  PERP_ORDER_TYPE=postOnly npm run place-order

# end-to-end reachability check (REST + gRPC + fees)
npm run smoke-check
```

A direct-enqueue order flow that bypasses the relayer and signs the Solana tx
locally lives at `src/bin/direct-orders`:

```bash
npm run direct-place-order
```

This path uses the gateway only for the optional pre-warm read; the actual
intent is enqueued on-chain via `execution_queue_v5_enqueue_direct_market` and
needs the deployment to have `directPoolsInitialized: true`.

## Programmatic usage

```ts
import {
  ContinuumHarnessClient,
  ContinuumRelayerClient,
  PerpOrderSide,
  createMangoContext,
  submitPerpOrderViaRelayer,
} from '@fermilabs/continuum-sdk';

const gatewayUrl = process.env.FERMI_API_URL!;
const gatewayGrpcAddr = process.env.FERMI_API_GRPC_ADDR!;
const apiKey = process.env.FERMI_API_KEY!;

const context = await createMangoContext({
  cluster: 'mainnet-beta',
  clusterUrl: process.env.CLUSTER_URL!,
  deployment: 'fermi-r6-mainnet',
  gatewayUrl,
  gatewayGrpcAddr,
  apiKey,
  userKeypair: process.env.USER_KEYPAIR!,
  groupPk: process.env.GROUP_PK!,
  mangoAccountPk: process.env.MANGO_ACCOUNT_PK!,
});

const harness = new ContinuumHarnessClient({ gatewayUrl, apiKey });
const relayer = new ContinuumRelayerClient({ gatewayGrpcAddr, apiKey });

const optimistic = await harness.getMarketState(0, 'optimistic');

await submitPerpOrderViaRelayer(relayer, context, {
  marketIndex: 0,
  side: PerpOrderSide.bid,
  price: 80,
  quantity: 0.01,
  maxFeeLamports: 'AUTO',
});
```

A missing or non-UUID `apiKey` throws at construction — before any network
call — so misconfiguration is caught loudly.

### Relayed v5 intents

Place-order helpers sign the current `mango-v5-user-intent-v2` digest, which
binds group, Mango account, owner, target market, payload hash, canonical
account hash, min execute slot, expiry slot, and a u64 `client_order_id`
replay nonce. The order `clientOrderId` is used as that nonce unless
`intentClientOrderId` is supplied. Cancel helpers generate a fresh random
nonce by default.

For production-like FIFO behaviour pass `expiryTimestamp: 0`; nonzero
expiries can be delayed behind earlier queue work.

## Streams

`src/streams.ts` exposes typed `AsyncIterable` subscribers for every live
channel the gateway publishes. Each one carries `x-api-key`, surfaces 429 as
`RateLimitedError`, and ends cleanly on `signal.abort()` or `.close()`.

```ts
import {
  snapshotAndStreamMarket,
  subscribeMarketEvents,
  subscribeStateStream,
  subscribeTicks,
  subscribeV2TradeStream,
} from '@fermilabs/continuum-sdk';

const common = {
  gatewayUrl: process.env.FERMI_API_URL!,
  apiKey: process.env.FERMI_API_KEY!,
};

// Tail every state event.
for await (const frame of subscribeStateStream(common)) {
  console.log(frame.event, frame.data);
}

// Per-market events with gap-free resume.
const snap = await snapshotAndStreamMarket({ ...common, market: 0 });
// snap.snapshot.bids / snap.snapshot.asks is the current book at snap.cursor
for await (const frame of subscribeMarketEvents({
  ...common,
  market: 0,
  from: snap.cursor, // resume exactly where the snapshot was taken
})) {
  // frame.event: 'order_placed' | 'order_cancelled' | 'order_filled' | 'trade' | ...
  // frame.id is the Redis stream id; persist it to resume after a restart.
}

// Redis-backed trade tail.
for await (const trade of subscribeV2TradeStream(common)) {
  console.log(trade.data); // typed StreamTrade
}

// Batched ticks over WebSocket.
for await (const batch of subscribeTicks({
  wsUrl: 'wss://gateway.fermi.xyz/ws/ticks',
  apiKey: common.apiKey,
})) {
  console.log(`got ${batch.count} ticks`);
}
```

Available subscribers:

| Function | Gateway endpoint | Notes |
|---|---|---|
| `subscribeStateStream` | `GET /state/stream` | All-market harness events |
| `subscribeFrontendStream` | `GET /state/stream/frontend` | Requires ≥1 of `owner` / `mangoAccount` / `market` |
| `subscribeTradeStream` | `GET /state/stream/trades` | Legacy harness trade tail |
| `subscribeV2TradeStream` | `GET /v2/stream/trades` | Redis-backed, lower latency |
| `subscribeMarketEvents` | `GET /v2/events/:market` | Accepts `from` / `lastEventId` for resume |
| `subscribeMarketFrontendStream` | `GET /v2/stream/frontend/:market` | UI-shaped per-market events |
| `snapshotAndStreamMarket` | `GET /v2/events/snapshot-and-stream/:market` | Atomic `(book, cursor)` for gap-free attach |
| `subscribeTicks` | `WS /ticks` (Caddy: `/ws/ticks`) | Batched ticks; defaults to native `WebSocket` (Node 22+/browser) |

The shared `Subscription<T>` shape is just `AsyncIterable<T> & { close(): void }`.

## Fees

The relayer keeps a per-wallet SOL fee ledger:

- SDK helpers accept `maxFeeLamports?: string`; pass `'AUTO'` unless you
  intentionally want a lamport cap.
- If the relayer replies `please deposit gas`, top up via
  `ContinuumFeeClient.getStatus()` (returns the deposit address + memo) and
  `depositFeeCredit()` (signs + sends the SOL transfer and reports it to
  `POST /relayer/fees-deposited`).

See [`fee_system.md`](./fee_system.md) and
[`docs/fee-path-end-to-end.md`](./docs/fee-path-end-to-end.md) for the full
sequence.

## Direct chain access

`createMangoContext` also returns:

- `context.client` — Mango v4 `MangoClient`
- `context.group` — loaded `Group`
- `context.mangoAccount` — loaded `MangoAccount`
- `context.connection` — Solana `Connection` (uses `CLUSTER_URL`, not the
  gateway)

so you can still:

- inspect full Mango state from chain,
- deposit / withdraw funds,
- create or manage Mango accounts,
- mix direct on-chain actions with gateway-routed relayer intents.

## Notes

- Solana RPC is **not** proxied. Use a real RPC provider in `CLUSTER_URL`;
  the public `api.mainnet-beta.solana.com` will rate-limit Mango's IDL
  bootstrap.
- The bundled quoter (`continuum-quoter`) is intentionally minimal; bigger
  bot operators should treat it as a starting point.
- The bootstrap scripts (`create-mango-account`, `deposit-usdc`,
  `withdraw-usdc`) are direct Mango client flows; they do not mint test
  USDC. For local harness funding use `airdropUsdc()` / `airdropDepositUsdc()`
  on `ContinuumHarnessClient` where the gateway enables them.
- For a step-by-step walkthrough see [`USAGE.md`](./USAGE.md); for build
  notes see [`docs/BUILD-SETUP.md`](./docs/BUILD-SETUP.md).
