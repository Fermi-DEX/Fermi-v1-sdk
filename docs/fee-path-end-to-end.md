# Relayer Fee Path End To End

This guide is the client-side sequence for using relayer fees from
`cont-sdk-fresh`. The fee path is separate from Fermi v1 margin and separate from
the signed user-intent digest.

## Ports And URLs

For the current Fermi v1 service layout:

| Purpose | Default port | Client setting |
| ------- | ------------ | -------------- |
| Relayer gRPC intent submit | `9090` | `RELAYER_ADDR=host:9090` |
| Harness state reads | `9091` | `HARNESS_URL=http://host:9091` |
| HTTP bridge, if used | `9092` | bridge-specific |
| Execution-engine HTTP, including fees | `9093` | `FEE_HTTP_URL=http://host:9093` |

Do not point `FEE_HTTP_URL` at the gRPC relayer port. `/fees/status` and
`/fees-deposited` are HTTP routes on the execution-engine server.

## Recommended Client Defaults

Use these defaults for production-like devnet and mainnet testing:

```bash
RELAYER_MAX_FEE_LAMPORTS=AUTO
BOT_MAX_FEE_LAMPORTS=AUTO
FEE_HTTP_URL=http://<core-host>:9093
```

`AUTO` lets the relayer apply its current quote. An explicit integer cap is
supported, but cap rejections can interrupt market making during queue pressure.

## End-To-End Flow

1. Build a Fermi v1 context from the trading wallet and Fermi v1 account.
2. Query `/fees/status` before the first submit.
3. If the available fee balance is low, deposit SOL to the returned
   `deposit.deposit_address` with the exact returned memo.
4. Report the deposit through `/fees-deposited`.
5. Submit relayed intents with `maxFeeLamports: 'AUTO'`.
6. If a submit is rejected for insufficient fees, refresh status, top up, and
   retry with a new intent nonce or helper-generated nonce.

```ts
import {
  FermiV1FeeClient,
  FermiV1RelayerClient,
  PerpOrderSide,
  createFermiV1Context,
  depositFeeCredit,
  submitPerpOrderViaRelayer,
} from '@fermilabs/fermi-v1-sdk';

const context = await createFermiV1Context({
  cluster: 'devnet',
  clusterUrl: process.env.CLUSTER_URL!,
  userKeypair: process.env.USER_KEYPAIR!,
  groupPk: process.env.GROUP_PK!,
  fermiAccountPk: process.env.FERMI_ACCOUNT_PK!,
  programId: process.env.PROGRAM_ID,
});

const fees = new FermiV1FeeClient(process.env.FEE_HTTP_URL!);
const relayer = new FermiV1RelayerClient(process.env.RELAYER_ADDR!);

const status = await fees.getStatus({
  userOwner: context.user.publicKey,
  fermiAccount: context.fermiAccount.publicKey,
  group: context.group.publicKey,
  market: 0,
});

if (
  status.fee_account.available_balance_lamports <
  10 * status.quote.quoted_fee_lamports
) {
  await depositFeeCredit({
    connection: context.connection,
    payer: context.user,
    userOwner: context.user.publicKey,
    fermiAccount: context.fermiAccount.publicKey,
    lamports: 100_000_000,
    feeClient: fees,
  });
}

await submitPerpOrderViaRelayer(relayer, context, {
  marketIndex: 0,
  side: PerpOrderSide.bid,
  price: 120,
  quantity: 0.01,
  expiryTimestamp: 0,
  maxFeeLamports: 'AUTO',
});
```

## Manual Deposit Transaction

Use the one-shot `depositFeeCredit()` helper when possible. If a client needs
to build and send the transaction itself, the transaction must contain:

| Index | Instruction |
| ----- | ----------- |
| `0` | SPL Memo v2 with `fee_credit:v1:<user_owner>:<fermi_account>` |
| `1` | `SystemProgram.transfer` from `user_owner` to `deposit.deposit_address` |

Then call:

```ts
await fees.reportDeposit({
  source_chain: 'solana-devnet',
  source_tx_signature: signature,
  instruction_index: 1,
  user_owner: context.user.publicKey.toBase58(),
  fermi_account: context.fermiAccount.publicKey.toBase58(),
  amount_lamports: 100_000_000,
  deposit_address: status.deposit.deposit_address,
  memo: status.deposit.memo,
});
```

`/fees-deposited` is idempotent on transaction signature plus instruction
index, so reporting the same confirmed deposit again is safe.

## Operational Gotchas

- Fermi v1 USDC deposits do not fund relayer fees. The fee ledger is a separate
  SOL-denominated relayer balance.
- The relayer does not charge the wallet's live on-chain SOL balance directly;
  it only debits the internal fee ledger.
- `maxFeeLamports` is not signed into the Fermi v1 user-intent message. Changing
  it cannot cause signature verification failure.
- Keep one `(user_owner, fermi_account)` pair per bot identity. Fee balances
  are keyed by that pair.
- In concurrent bots, treat `available_balance_lamports` as a moving value
  because in-flight intents can reserve fee balance before they settle.
- On `base fee too low`, retry with `AUTO` or a higher cap.
- On `please deposit gas` or `insufficient fees`, refresh status, top up, call
  `/fees-deposited`, then resubmit.
