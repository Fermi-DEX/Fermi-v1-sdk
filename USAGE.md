# Fermi v1 SDK usage

This guide uses `fermi-r9-mainnet`. Account creation, deposits, withdrawals,
fee deposits, and order submission use real funds and send transactions.

## 1. Install and configure

```bash
npm install
cp .env.fermi-r9-mainnet.example .env
```

Set `FERMI_API_KEY` to the UUID from the gateway operator.
Set `USER_KEYPAIR` to your wallet file.
Use `CLUSTER_URL` for your mainnet RPC provider.

The deployment preset supplies the program, group, USDC mint, and gateway URLs.
If your `.env` comes from r6, replace its program and group values.
Old environment values override the new preset.

| Variable | Purpose |
| --- | --- |
| `FERMI_DEPLOYMENT=fermi-r9-mainnet` | Select the r9 preset |
| `CLUSTER=mainnet-beta` | Select the Solana cluster |
| `CLUSTER_URL` | Select the Solana RPC endpoint |
| `FERMI_API_URL=https://v1.fermi.trade/prod` | REST and SSE gateway |
| `FERMI_API_GRPC_ADDR=v1.fermi.trade:443` | gRPC gateway with TLS |
| `FERMI_API_KEY` | UUID for gateway clients |
| `USER_KEYPAIR` | Wallet file for on-chain actions and intent signatures |
| `FERMI_ACCOUNT_NUM=0` | Account number for creation and deposit/withdrawal lookup |
| `FERMI_ACCOUNT_PK` | r9 account address for the trading context and portfolio CLI |

The SDK ignores `HARNESS_URL`, `RELAYER_ADDR`, and `FEE_HTTP_URL`.

## 2. Read the current config

```bash
npm run config
npm run smoke-check
```

`config` reads `/config`. The response includes program and group addresses,
market indices, lot sizes, oracles, and current fees. `CONFIG_SOURCE=bootstrap`
selects `/state/bootstrap` instead.

`smoke-check` checks RPC, REST, fees, and gRPC reachability. It submits an invalid
intent as a connectivity probe. It does not place an order.

## 3. Create an account

The wallet needs SOL for rent and transaction fees.

```bash
FERMI_ACCOUNT_NAME=my-account npm run create-fermi-account
```

Copy `fermi_account` from the output into `FERMI_ACCOUNT_PK` in `.env`.
The output also contains the transaction signature and a legacy `mango_account` alias.
If the account number already exists, the command stops with its address.

Default capacities are 1 token, 0 Serum3, 3 perps, and 32 perp open orders.
The `FERMI_ACCOUNT_TOKEN_COUNT`, `FERMI_ACCOUNT_PERP_COUNT`, and
`FERMI_ACCOUNT_PERP_OO_COUNT` variables override these values.
`FERMI_ACCOUNT_SERUM3_COUNT` must remain `0`.

The r9 account uses the `FermiAccount` PDA seed and discriminator.
An r6 account address cannot identify an r9 account.

## 4. Deposit USDC

The wallet must hold real mainnet USDC in its associated token account.

```bash
USDC_AMOUNT_UI=5 npm run deposit-usdc
```

Amounts use UI units. `5` means 5 USDC. The command uses `FERMI_ACCOUNT_PK` when
present. Otherwise, it derives the account from the wallet and `FERMI_ACCOUNT_NUM`.
It does not create a missing trading account or mint USDC.

Read the resulting balance:

```bash
OWNER=<wallet-public-key> npm run portfolio
npm run onchain-portfolio
```

`portfolio` reads gateway state. `onchain-portfolio` reads Solana RPC.
The latter requires `FERMI_ACCOUNT_PK`.

## 5. Fund relayer fees

USDC margin does not fund the relayer fee balance. The relayer uses a separate
SOL ledger for each owner/account pair.

Construct `FermiV1FeeClient` with `{ gatewayUrl, apiKey }`.
Call `getStatus({ userOwner, fermiAccount })` for the deposit address, memo,
current quote, and available balance. Use the exact returned address and memo.

The [fee guide](docs/fee-path-end-to-end.md) contains the deposit sequence.
`depositFeeCredit` sends a SOL transaction and reports its signature to the gateway.
Set `sourceChain: 'solana-mainnet'` for mainnet deposits.

## 6. Simulate and submit an order

A simulation does not send a transaction:

```bash
SIMULATE_OWNER=<wallet-public-key> SIMULATE_MARKET=SOL-PERP \
  SIMULATE_SIDE=buy SIMULATE_QUANTITY=0.01 SIMULATE_PRICE=80 npm run simulate
```

The script warms the simulation cache before the read.
A simulation result does not guarantee later execution.

This command submits a real relayed order:

```bash
PERP_ORDER_MARKET_INDEX=0 PERP_ORDER_SIDE=bid PERP_ORDER_PRICE=80 \
  PERP_ORDER_QUANTITY=0.01 PERP_ORDER_TYPE=postOnly \
  PERP_ORDER_MAX_FEE_LAMPORTS=AUTO npm run place-order
```

Market indices are `0` for SOL, `1` for ETH, and `2` for BTC.
Price and quantity use UI units. Supported order types include `limit`, `ioc`,
`postOnly`, `market`, and `postOnlySlide`.

The relayer returns acceptance before the queue executes the order.
Read the confirmed order book and account orders for the execution result.
`optimistic` state can include an accepted intent that later fails on-chain.

Programmatic cancellation uses the same context and relayer:

```ts
import {
  cancelAllPerpOrdersViaRelayer,
  cancelPerpOrderByClientIdViaRelayer,
} from '@fermilabs/fermi-v1-sdk';

await cancelPerpOrderByClientIdViaRelayer(relayer, context, {
  marketIndex: 0,
  clientOrderId: 123n,
  maxFeeLamports: 'AUTO',
});
await cancelAllPerpOrdersViaRelayer(relayer, context, { marketIndex: 0 });
```

The [README](README.md#programmatic-trading) contains a complete context example.
Relayed intents default to `minExecuteSlot=0` and `expiresAtSlot=0`.
These defaults differ from the required finite expiry on the direct path.

## 7. Withdraw USDC

```bash
USDC_AMOUNT_UI=5 WITHDRAW_ALLOW_BORROW=false npm run withdraw-usdc
```

The command returns USDC to the owner ATA. It creates the ATA if it is absent.
Account health and outstanding positions can limit the withdrawal.
A failed withdrawal does not establish that the account has no USDC balance.

## Streams

```ts
import { snapshotAndStreamMarket, subscribeMarketEvents } from '@fermilabs/fermi-v1-sdk';

const common = {
  gatewayUrl: 'https://v1.fermi.trade/prod',
  apiKey: process.env.FERMI_API_KEY!,
};
const snapshot = await snapshotAndStreamMarket({ ...common, market: 0 });
const stream = subscribeMarketEvents({ ...common, market: 0, from: snapshot.cursor });
try {
  for await (const frame of stream) {
    console.log(frame.id, frame.event, frame.data);
  }
} finally {
  stream.close();
}
```

The snapshot includes a cursor for subsequent stream reads.
Store the cursor for reconnects. The stream clients send `x-api-key`.
Rate limits surface as `RateLimitedError`.

| Helper | Endpoint |
| --- | --- |
| `subscribeStateStream` | `/state/stream` |
| `subscribeFrontendStream` | `/state/stream/frontend` |
| `subscribeTradeStream` | `/state/stream/trades` |
| `subscribeV2TradeStream` | `/v2/stream/trades` |
| `subscribeMarketEvents` | `/v2/events/:market` |
| `subscribeMarketFrontendStream` | `/v2/stream/frontend/:market` |
| `snapshotAndStreamMarket` | `/v2/events/snapshot-and-stream/:market` |
| `subscribeTicks` | Gateway WebSocket URL, supplied as `wsUrl` |

## Direct orders and custom deployments

The r9 mainnet direct pools were absent at the 2026-10-23 check.
The direct-order CLI and helpers reject this preset. Use the relayer for mainnet.

For a prepared custom deployment, set its group, program, RPC, and cluster explicitly.
Build the context without the r9 deployment selector. Custom groups require an
explicit `programId`. The SDK does not fall back to a Mango program ID.

The direct helpers default to `currentSlot + 20` for the intent expiry.
The low-level builder requires an explicit non-zero `expiresAtSlot`.
A longer expiry can exceed the replay window. The program permits a TTL up to
5,400 slots, so client expiry policy matters.

## Common errors

| Error | Action |
| --- | --- |
| Invalid account discriminator | Use this SDK's client and an r9 account address |
| Deployment/program/group mismatch | Replace stale `.env` overrides with the r9 values |
| Account missing for owner and number | Create the r9 account before deposit or trading |
| Non-zero Serum3 capacity | Set `FERMI_ACCOUNT_SERUM3_COUNT=0` |
| Unknown group without program ID | Supply the custom deployment's `programId` |
| `please deposit gas` | Read the relayer fee status and fund that ledger |
| HTTP 429 or gRPC `RESOURCE_EXHAUSTED` | Respect the retry delay and reduce the request rate |
| Direct pools not initialized | Submit through the relayer |

See [the migration guide](docs/r9-migration.md) for raw IDL and transport name differences.

## Trigger orders and FLP

Use [the trigger-order guide](docs/trigger-orders.md) for signed SL/TP brackets,
status reads and cancellation. Use [the FLP guide](docs/flp.md) for vault
instructions, pricing accounts, metadata and current admin/recovery operations.
The service must enable trigger and FLP metadata routes before those reads work.
