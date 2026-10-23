# Fermi v1 SDK

TypeScript SDK for the **r9 mainnet deployment**. It supports account creation,
USDC deposits and withdrawals, relayed perp orders, state reads, fees, and streams.

The SDK bundles the r9 IDL. All account helpers use its `FermiAccount` identity.
The upstream Mango package supplies account models and transaction helpers only.
No sibling repository or private GitHub dependency is required.

## Install

Use Node.js 22 or later.

```bash
npm install
npm run validate
cp .env.fermi-r9-mainnet.example .env
```

The install hook builds `dist/`. The package version is `0.2.0`.

## Mainnet config

| Item | r9 value |
| --- | --- |
| Deployment | `fermi-r9-mainnet` |
| Program | `FRMiX94PWHbndvySq8xyRx185GvPeggUeKaLmZgVdd4` |
| Group | `2mDvxS4A6bJyR3RjLwvBWeNuFvCAaQ26ss7w1jUChRse` |
| Markets | `0`: SOL-PERP, `1`: ETH-PERP, `2`: BTC-PERP |
| REST gateway | `https://v1.fermi.trade/prod` |
| gRPC gateway | `v1.fermi.trade:443` (TLS) |

The deployment registry matches the production `/config` response on 2026-10-23.
Use `npm run config` for current fees, market parameters, and addresses.
The registry contains addresses and lot sizes, not fixed trading fees.

Set these values in `.env`:

```dotenv
FERMI_DEPLOYMENT=fermi-r9-mainnet
FERMI_API_KEY=<UUID from the gateway operator>
USER_KEYPAIR=/absolute/path/to/user-keypair.json
FERMI_ACCOUNT_PK=<r9 account public key, after account creation>
```

`CLUSTER_URL` can select your own mainnet RPC provider. The public RPC can limit
requests during account and group reads. `FERMI_ACCOUNT_NUM=0` selects the account
number for creation and owner lookup in the deposit and withdrawal CLIs.

REST, gRPC, and stream clients require a UUID API key. They send it as `x-api-key`.
Solana RPC calls use `CLUSTER_URL` directly. `FermiV1AccountClient` does not require
a gateway key. `createFermiV1Context` requires one for the combined trading flow.

The SDK ignores `HARNESS_URL`, `RELAYER_ADDR`, and `FEE_HTTP_URL`.
Use `FERMI_API_URL`, `FERMI_API_GRPC_ADDR`, and `FERMI_API_KEY` instead.

## CLI workflow

```bash
# Read service config and check reachability.
npm run config
npm run smoke-check

# Create an r9 account. This sends an on-chain transaction.
npm run create-fermi-account

# Copy fermi_account from the output into FERMI_ACCOUNT_PK in .env.
# Deposit real USDC from the wallet ATA. This sends an on-chain transaction.
USDC_AMOUNT_UI=5 npm run deposit-usdc

# Read the account through the gateway or Solana RPC.
OWNER=<wallet-public-key> npm run portfolio
npm run onchain-portfolio

# Submit a real order through the relayer.
PERP_ORDER_MARKET_INDEX=0 PERP_ORDER_SIDE=bid PERP_ORDER_PRICE=80 \
  PERP_ORDER_QUANTITY=0.01 PERP_ORDER_TYPE=postOnly npm run place-order

# Withdraw real USDC, subject to account health.
USDC_AMOUNT_UI=5 npm run withdraw-usdc
```

Account creation defaults to 1 token slot, 0 Serum3 slots, 3 perp slots, and
32 perp open-order slots. r9 disables Serum3 slots. An explicit non-zero
`FERMI_ACCOUNT_SERUM3_COUNT` causes an error.

The CLIs return `fermi_account`. They also retain `mango_account` as an alias.

## Programmatic trading

```ts
import {
  FermiV1RelayerClient,
  FermiV1StateClient,
  PerpOrderSide,
  PerpOrderType,
  cancelAllPerpOrdersViaRelayer,
  createFermiV1Context,
  submitPerpOrderViaRelayer,
} from '@fermilabs/fermi-v1-sdk';

const apiKey = process.env.FERMI_API_KEY!;
const gatewayUrl = 'https://v1.fermi.trade/prod';
const gatewayGrpcAddr = 'v1.fermi.trade:443';
const context = await createFermiV1Context({
  deployment: 'fermi-r9-mainnet',
  clusterUrl: process.env.CLUSTER_URL,
  apiKey,
  userKeypair: process.env.USER_KEYPAIR!,
  fermiAccountPk: process.env.FERMI_ACCOUNT_PK!,
});
const state = new FermiV1StateClient({ gatewayUrl, apiKey });
const relayer = new FermiV1RelayerClient({ gatewayGrpcAddr, apiKey });

try {
  console.log(await state.getMarketState(0, 'confirmed'));
  const accepted = await submitPerpOrderViaRelayer(relayer, context, {
    marketIndex: 0,
    side: PerpOrderSide.bid,
    price: 80,
    quantity: 0.01,
    orderType: PerpOrderType.postOnly,
    maxFeeLamports: 'AUTO',
  });
  console.log(accepted.sequence);
  // Acceptance precedes chain execution. Read confirmed orders to see the result.
  await cancelAllPerpOrdersViaRelayer(relayer, context, { marketIndex: 0 });
} finally {
  relayer.close();
}
```

## Account client and IDL

```ts
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  FERMI_R9_MAINNET,
  FermiV1AccountClient,
  findFermiV1AccountPda,
  loadKeypair,
} from '@fermilabs/fermi-v1-sdk';

const deployment = FERMI_R9_MAINNET;
const user = loadKeypair(process.env.USER_KEYPAIR!);
const provider = new AnchorProvider(
  new Connection(process.env.CLUSTER_URL ?? deployment.rpcUrl, 'confirmed'),
  new Wallet(user),
  { commitment: 'confirmed' },
);
const client = FermiV1AccountClient.connect(
  provider, 'mainnet-beta', new PublicKey(deployment.programId),
);
const group = await client.getGroup(new PublicKey(deployment.group));
const address = findFermiV1AccountPda(client.programId, group.publicKey, user.publicKey, 0);
const account = await client.getFermiAccountForOwner(group, user.publicKey, 0);
console.log(address.toBase58(), account?.name);

// If the account is absent, this call creates it and sends a transaction:
// await client.createFermiAccount(group, 0, 'my-account');

// Typed Anchor access uses r9 names:
// await client.fermiProgram.account.fermiAccount.fetch(address);
// client.fermiProgram.coder.accounts.decode('fermiAccount', accountData);
```

Exports include `FERMI_V1_IDL`, `FermiV1Idl`, `FermiV1Account`, and `FermiV1Group`.
The raw JSON is in `src/idl/fermi_v1.json` and the package includes it in `dist/idl/`.
The r9 source IDL snapshot predates v5 queue instructions. The SDK builds v5
instructions with the wire encoders in `src/intents.ts`.

Legacy methods such as `getMangoAccount` and `createMangoAccount` remain aliases.
They use the r9 decoder and seed. For typed raw Anchor calls, use `client.fermiProgram`.
See [the migration guide](docs/r9-migration.md) for the full name mapping.

## Fees, streams, and direct orders

The relayer fee balance is separate from USDC margin. Use `FermiV1FeeClient`
to read the current quote and deposit instructions. See [the fee guide](docs/fee-path-end-to-end.md).

The stream helpers support SSE and WebSocket feeds. Use `FERMI_API_URL` for SSE
and the gateway WebSocket URL for `subscribeTicks`. See [the usage guide](USAGE.md#streams).

The r9 direct pools were absent on mainnet at the 2026-10-23 check. Use the relayer.
The direct-order CLI and helpers reject this deployment. Direct helpers remain available for
an explicitly prepared deployment. They default to an expiry of current slot + 20.
The low-level direct builder requires a non-zero expiry.

## Documentation and checks

- [Usage guide](USAGE.md): account creation, margin, orders, fees, reads, and streams.
- [r9 migration](docs/r9-migration.md): IDL provenance, names, seeds, and compatibility.
- [Build guide](docs/BUILD-SETUP.md): standalone install and package checks.
- [State API reference](docs/api.md): endpoint and response inventory.
- [Intent reference](intent_reference.md): payloads and signed-message domains.

`npm run validate` checks types, builds the package, runs offline regression tests,
and checks the package contents. Tests use public mainnet account snapshots.
They do not send transactions.
