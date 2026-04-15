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
- `EXECUTION_QUEUE_PK`: execution queue public key
- `RELAYER_ADDR`: gRPC relayer address, for example `host:9090`

Optional:

- `HARNESS_URL`: Continuum harness base URL, for example `http://host:9091`
- `PROGRAM_ID`: override Mango program id
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
  executionQueuePk: process.env.EXECUTION_QUEUE_PK!,
});

const harness = new ContinuumHarnessClient(process.env.HARNESS_URL!);
const relayer = new ContinuumRelayerClient(process.env.RELAYER_ADDR!);

const optimistic = await harness.getMarketState(0, 'optimistic');

await submitPerpOrderViaRelayer(relayer, context, {
  marketIndex: 0,
  side: PerpOrderSide.bid,
  price: 120,
  quantity: 0.01,
  baseFee: 'AUTO',
});
```

## Relayer Fees

The relayer now uses a separate internal SOL fee ledger per wallet.

- SDK helpers accept `baseFee?: string`
- use `baseFee: 'AUTO'` unless you intentionally want a hard cap
- if the relayer replies with `please deposit gas`, transfer SOL to the
  relayer's `deposit_address` and then call `POST /relay/deposit-fees`

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

## Notes

- The bundled quoter is intentionally minimal. The larger in-repo bot has more operational behaviors, startup funding logic, and deployment-specific assumptions.
- This SDK keeps the harness read path and relayer write path separate so external users can script their own strategies cleanly.
- The bootstrap scripts are direct Mango client flows. They do not mint test USDC; for local harness funding use `ContinuumHarnessClient.airdropUsdc()` or `airdropDepositUsdc()` where available.
