# Continuum SDK

Self-contained TypeScript SDK for:

- reading optimistic or confirmed state from the Continuum harness,
- submitting perp intents to the relayer over gRPC,
- interacting directly with Mango on-chain state through `@blockworks-foundation/mango-v4`,
- running a minimal remote quoter bot from another machine.

This package is intentionally separate from the deployment repo. It assumes the relayer and harness are already running somewhere reachable over the network.

For build and environment setup, keep the existing repo docs in reach:

- [Build And Setup Notes](./docs/BUILD-SETUP.md)
- [Full Harness API Reference](./docs/api.md)
- [Relayer Fee System](./fee_system.md)

## What It Covers

- Harness reads via `ContinuumHarnessClient`
- Relayer submits via `ContinuumRelayerClient`
- Mango bootstrap via `createMangoContext`
- High-level helpers:
  - `submitPerpOrderViaRelayer`
  - `submitPerpOrderDirect`
  - `cancelPerpOrderByClientIdViaRelayer`
  - `cancelAllPerpOrdersViaRelayer`
- Minimal bot runtime:
  - `RelayerPerpQuoterBot`
  - `continuum-quoter`

The harness API surface is included directly in this repo at [docs/api.md](./docs/api.md).

## Install

```bash
npm install
npm run build
```

When consumed directly from Git, `npm install` runs the package `prepare` hook
and builds `dist/` locally. `dist/` is intentionally not committed.

## Bootstrap Scripts

Create a Mango account for the configured owner:

```bash
npm run create-mango-account
```

Deposit USDC from the configured wallet ATA into Mango:

```bash
npm run deposit-usdc
```

The create script uses `GROUP_PK`, `USER_KEYPAIR`, and optional sizing env vars such as
`MANGO_ACCOUNT_NUM` and `MANGO_ACCOUNT_NAME`. The deposit script uses the same base env,
resolves the Mango account from `MANGO_ACCOUNT_PK` or `MANGO_ACCOUNT_NUM`, and deposits
`USDC_AMOUNT_UI` using `USDC_MINT` if set or the group's perp-settlement mint otherwise.

## Direct Order Scripts

The SDK now includes a dedicated folder for direct enqueue order flows at
[src/bin/direct-orders](./src/bin/direct-orders/README.md).

Place a direct perp order with the on-chain v5 direct market path:

```bash
npm run direct-place-order
```

Or via the packaged bin:

```bash
npx continuum-direct-place-order
```

The direct flow uses `execution_queue_v5_enqueue_direct_market`, derives the
queue authority / v5 queue / direct pool PDAs from `GROUP_PK` + `PERP_MARKET_INDEX`,
and optionally registers the owner lane against `HARNESS_URL` before submit.

Perp intent helpers build the canonical execution-queue account list as fixed
dispatch accounts followed by grouped health sections:
`banks`, `bank_oracles`, `perp_markets`, `perp_oracles`, Serum/OpenBook open
orders, then fallback oracles. The helper includes every configured perp market
in sorted market-index order. Bots should use the SDK helper output directly and
must not interleave `perp_market, oracle` pairs.

For a local smoke template that places and then cancels through direct v5
fallback, see [examples/direct-v5-smoketest.ts](./examples/direct-v5-smoketest.ts).

## Remote Quoter Setup

Copy `.env.example` and fill in the actual remote endpoints and account keys:

```bash
cp .env.example .env
```

Required values:

- `CLUSTER_URL`: Solana RPC URL reachable from the client machine
- `USER_KEYPAIR`: absolute path to the user keypair JSON, or raw JSON
- `GROUP_PK`: Mango group public key
- `MANGO_ACCOUNT_PK`: Mango account to trade with
- `RELAYER_ADDR`: gRPC relayer address, for example `host:9090`

Optional:

- `HARNESS_URL`: Continuum harness base URL, for example `http://host:9091`
- `PROGRAM_ID`: override Mango program id
- `EXECUTION_QUEUE_PK`: legacy/default queue address; current v5 helpers derive the per-market queue PDA from `PROGRAM_ID`, `GROUP_PK`, and `marketIndex`
- `RELAYER_MAX_FEE_LAMPORTS`: relayer fee cap in lamports, or `AUTO`
- `COINGECKO_*`: fair-price source tuning

Run the quoter:

```bash
npx continuum-quoter
```

Or during development:

```bash
npx ts-node src/bin/run-quoter.ts
```

## Programmatic Usage

```ts
import {
  ContinuumHarnessClient,
  ContinuumRelayerClient,
  PerpOrderSide,
  createMangoContext,
  submitPerpOrderViaRelayer,
} from '@fermilabs/continuum-sdk';

const context = await createMangoContext({
  cluster: 'devnet',
  clusterUrl: process.env.CLUSTER_URL!,
  userKeypair: process.env.USER_KEYPAIR!,
  groupPk: process.env.GROUP_PK!,
  mangoAccountPk: process.env.MANGO_ACCOUNT_PK!,
  programId: process.env.PROGRAM_ID,
});

const harness = new ContinuumHarnessClient(process.env.HARNESS_URL!);
const relayer = new ContinuumRelayerClient(process.env.RELAYER_ADDR!);

const optimistic = await harness.getMarketState(0, 'optimistic');

await submitPerpOrderViaRelayer(relayer, context, {
  marketIndex: 0,
  side: PerpOrderSide.bid,
  price: 120,
  quantity: 0.01,
  maxFeeLamports: 'AUTO',
});
```

For relayed v5 intents, the SDK signs the current `mango-v5-user-intent-v2`
digest. That digest binds group, Mango account, owner, target market, payload
hash, canonical account hash, min execute slot, expiry slot, and a u64
`client_order_id` replay nonce. Place-order helpers use the order
`clientOrderId` as that nonce unless `intentClientOrderId` is supplied; cancel
helpers generate a fresh random nonce by default.

## Relayer Fees

The relayer now uses a separate internal SOL fee ledger per wallet.

- SDK helpers accept `maxFeeLamports?: string`
- use `maxFeeLamports: 'AUTO'` unless you intentionally want a lamport cap
- if the relayer replies with `please deposit gas`, transfer SOL to the
  relayer's `deposit_address` and then call `POST /fees-deposited`

See [fee_system.md](./fee_system.md) for the exact client flow, supported
formats, and endpoint details.

## Direct Chain Interactions

The SDK keeps direct Mango access available through the returned context:

- `context.client`
- `context.group`
- `context.mangoAccount`
- `context.connection`

That means the remote client can still:

- inspect full Mango state from chain,
- deposit funds,
- create or manage Mango accounts,
- combine direct on-chain actions with relayer-submitted intents.

Those direct actions use the upstream `@blockworks-foundation/mango-v4` client.
The bundled direct-order scripts also layer the SDK's direct-enqueue builders on
top for one-shot order placement without the relayer.

## Notes

- The bundled quoter is intentionally minimal. The larger in-repo bot has more operational behaviors, startup funding logic, and deployment-specific assumptions.
- This SDK keeps the harness read path and relayer write path separate so external users can script their own strategies cleanly.
- For production-like FIFO testing, use `expiryTimestamp: 0`; nonzero order expiries can be delayed behind earlier queue work.
- The bootstrap scripts are direct Mango client flows. They do not mint test USDC; for local harness funding use `ContinuumHarnessClient.airdropUsdc()` or `airdropDepositUsdc()` where available.
