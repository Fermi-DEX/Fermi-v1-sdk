# Fermi v1 SDK

Self-contained TypeScript SDK for Fermi v1. **Every call goes through
the Fermi v1 gateway**. The gateway authenticates every request with a
mandatory `x-api-key`, applies per-key rate limits, and forwards REST + gRPC +
SSE + WebSocket traffic to the right upstream.

What you get out of the box:

- gateway-authenticated **REST reads** of market, user, balance, queue,
  trades, candles, and simulation state via `FermiV1StateClient`,
- gateway-authenticated **gRPC writes** (perp orders + cancels) through the
  commit/reveal relayer via `FermiV1RelayerClient`,
- gateway-authenticated **fee status / deposit reports** via
  `FermiV1FeeClient`,
- typed **SSE + WebSocket stream subscribers** with `AsyncIterable` ergonomics
  and gap-free resume,
- a Fermi v1 account bootstrap (`createFermiV1Context`) for direct
  on-chain reads, deposits, withdrawals, and account management — Solana RPC
  stays direct (proxy is not in the Solana RPC path).

For the full request/response inventory the gateway exposes, see
[docs/api.md](./docs/api.md).

## Authentication

The SDK refuses to construct any client without a UUID API key. Get one from
your Fermi gateway operator, then set:

```
FERMI_API_KEY=00000000-0000-0000-0000-000000000000
```

Unless overridden, the SDK uses the production gateway defaults:
`FERMI_API_URL=https://v1.fermi.trade/prod` and
`FERMI_API_GRPC_ADDR=v1.fermi.trade:443`.

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

Copy `.env.example` and fill in your API key, wallet path, and Fermi v1 account
selector:

```bash
cp .env.example .env
```

Required user-specific values:

- `FERMI_API_KEY` — UUID gateway key (mandatory)
- `USER_KEYPAIR` — absolute path to a Solana keypair JSON
- `FERMI_ACCOUNT_PK` — Fermi v1 account to trade with (or `FERMI_ACCOUNT_NUM` to
  resolve by owner + index when a CLI supports owner/index lookup)

Defaulted mainnet values:

- `FERMI_API_URL=https://v1.fermi.trade/prod`
- `FERMI_API_GRPC_ADDR=v1.fermi.trade:443`
- `CLUSTER=mainnet-beta`
- `CLUSTER_URL=https://api.mainnet-beta.solana.com`
- `FERMI_DEPLOYMENT=fermi-r6-mainnet`
- `GROUP_PK=87qUKYQoK1f9gYQjYzw5NcRo7wx6VmfhTGJ7JenoeYAA`
- `PROGRAM_ID=FRMiKrj2hQGvcZQtSDdiFRZ4cmaTjuc1QVkM2B5ShUvA`
- `USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

Optional:

- `FERMI_DEPLOYMENT` — pick a named deployment from `src/deployments.ts`
  (defaults to `fermi-r6-mainnet`). `GROUP_PK` / `PROGRAM_ID` / `USDC_MINT` /
  `FERMI_API_URL` / `FERMI_API_GRPC_ADDR` fall back to the deployment's
  values.
- `CLUSTER_URL` — override the default Solana RPC with a provider endpoint
  such as Helius, Triton, or your own pool.
- `PROGRAM_ID` — override the Fermi v1 program id
- `USDC_MINT` — override the USDC mint
- `RELAYER_MAX_FEE_LAMPORTS` — relayer fee cap in lamports, or `AUTO`
- `FERMI_ACCOUNT_*` (token / serum3 / perp / perp_oo counts) — slot sizing
  for `create-fermi-account`. **Fermi v1 disables serum3 slots;
  set `FERMI_ACCOUNT_SERUM3_COUNT=0`.**
- `COINGECKO_*` — fair-price source tuning for the quoter bot

## CLI scripts

```bash
# read deployment config from the gateway
npm run config

# bootstrap a fresh Fermi v1 account (signs an on-chain tx)
npm run create-fermi-account

# move USDC between the wallet ATA and the Fermi v1 account
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
  FermiV1StateClient,
  FermiV1RelayerClient,
  PerpOrderSide,
  createFermiV1Context,
  submitPerpOrderViaRelayer,
} from '@fermilabs/fermi-v1-sdk';

const gatewayUrl = process.env.FERMI_API_URL ?? 'https://v1.fermi.trade/prod';
const gatewayGrpcAddr = process.env.FERMI_API_GRPC_ADDR ?? 'v1.fermi.trade:443';
const apiKey = process.env.FERMI_API_KEY!;

const context = await createFermiV1Context({
  cluster: 'mainnet-beta',
  clusterUrl: process.env.CLUSTER_URL!,
  deployment: 'fermi-r6-mainnet',
  gatewayUrl,
  gatewayGrpcAddr,
  apiKey,
  userKeypair: process.env.USER_KEYPAIR!,
  groupPk: process.env.GROUP_PK!,
  fermiAccountPk: process.env.FERMI_ACCOUNT_PK!,
});

const harness = new FermiV1StateClient({ gatewayUrl, apiKey });
const relayer = new FermiV1RelayerClient({ gatewayGrpcAddr, apiKey });

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

Place-order helpers sign the current `fermi-v1-user-intent-v2` digest, which
binds group, Fermi v1 account, owner, target market, payload hash, canonical
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
} from '@fermilabs/fermi-v1-sdk';

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
| `subscribeFrontendStream` | `GET /state/stream/frontend` | Requires ≥1 of `owner` / `fermiAccount` / `market` |
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
  `FermiV1FeeClient.getStatus()` (returns the deposit address + memo) and
  `depositFeeCredit()` (signs + sends the SOL transfer and reports it to
  `POST /relayer/fees-deposited`).

See [`fee_system.md`](./fee_system.md) and
[`docs/fee-path-end-to-end.md`](./docs/fee-path-end-to-end.md) for the full
sequence.

## Direct chain access

`createFermiV1Context` also returns:

- `context.client` — Fermi v1 account client
- `context.group` — loaded `Group`
- `context.fermiAccount` — loaded `Fermi v1 account`
- `context.connection` — Solana `Connection` (uses `CLUSTER_URL`, not the
  gateway)

so you can still:

- inspect full Fermi v1 state from chain,
- deposit / withdraw funds,
- create or manage Fermi v1 accounts,
- mix direct on-chain actions with gateway-routed relayer intents.

## Notes

- Solana RPC is **not** proxied. Use a real RPC provider in `CLUSTER_URL`;
  the public `api.mainnet-beta.solana.com` will rate-limit Fermi v1's IDL
  bootstrap.
- The bundled quoter (`fermi-v1-quoter`) is intentionally minimal; bigger
  bot operators should treat it as a starting point.
- The bootstrap scripts (`create-fermi-account`, `deposit-usdc`,
  `withdraw-usdc`) are direct Fermi v1 client flows; they do not mint test
  USDC. For local harness funding use `airdropUsdc()` / `airdropDepositUsdc()`
  on `FermiV1StateClient` where the gateway enables them.
- For a step-by-step walkthrough see [`USAGE.md`](./USAGE.md); for build
  notes see [`docs/BUILD-SETUP.md`](./docs/BUILD-SETUP.md).
