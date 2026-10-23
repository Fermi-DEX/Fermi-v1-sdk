# Relayer fees

The relayer uses a SOL fee ledger for each `(user_owner, mango_account)` pair.
This balance is separate from USDC margin and the wallet's SOL balance.
The transport retains `mango_account` for compatibility.

## Gateway config

```dotenv
FERMI_API_URL=https://v1.fermi.trade/prod
FERMI_API_GRPC_ADDR=v1.fermi.trade:443
FERMI_API_KEY=<UUID>
RELAYER_MAX_FEE_LAMPORTS=AUTO
```

REST fee routes use the gateway URL and `x-api-key`.
The SDK ignores the old `FEE_HTTP_URL` and `RELAYER_ADDR` variables.

## Read status and deposit

The following example sends a real SOL transaction only if the balance is low.
Choose the deposit amount for your own trading activity.

```ts
import {
  FermiV1FeeClient,
  createFermiV1Context,
  depositFeeCredit,
} from '@fermilabs/fermi-v1-sdk';

const apiKey = process.env.FERMI_API_KEY!;
const context = await createFermiV1Context({
  deployment: 'fermi-r9-mainnet',
  clusterUrl: process.env.CLUSTER_URL,
  apiKey,
  userKeypair: process.env.USER_KEYPAIR!,
  fermiAccountPk: process.env.FERMI_ACCOUNT_PK!,
});
const fees = new FermiV1FeeClient({
  gatewayUrl: 'https://v1.fermi.trade/prod',
  apiKey,
});
const status = await fees.getStatus({
  userOwner: context.user.publicKey,
  fermiAccount: context.fermiAccount.publicKey,
  group: context.group.publicKey,
  market: 0,
});
console.log(status.deposit, status.fee_account, status.quote);

if (status.fee_account.available_balance_lamports < 10 * status.quote.quoted_fee_lamports) {
  await depositFeeCredit({
    connection: context.connection,
    payer: context.user,
    userOwner: context.user.publicKey,
    fermiAccount: context.fermiAccount.publicKey,
    lamports: 100_000_000,
    depositAddress: status.deposit.deposit_address,
    feeClient: fees,
    sourceChain: 'solana-mainnet',
  });
}
```

`depositFeeCredit` sends the memo and SOL transfer. It then reports the signature
to `/relayer/fees-deposited`. The helper's legacy `sourceChain` default is
`solana-devnet`, so mainnet callers must supply their chain label explicitly.

## Manual deposit

1. Read the current status through `getStatus`.
2. Use the exact returned deposit address and memo.
3. Put the memo instruction before the SOL transfer.
4. Send the transaction from the owner wallet.
5. Report the confirmed transfer through `reportDeposit`.

```ts
await fees.reportDeposit({
  source_chain: 'solana-mainnet',
  source_tx_signature: signature,
  instruction_index: 1,
  user_owner: context.user.publicKey.toBase58(),
  mango_account: context.fermiAccount.publicKey.toBase58(),
  amount_lamports: 100_000_000,
  deposit_address: status.deposit.deposit_address,
  memo: status.deposit.memo,
});
```

`instruction_index: 1` applies to the two-instruction memo/transfer transaction.
If you add instructions, use the actual transfer index.
Duplicate reports use the transaction signature and instruction index for deduplication.

## Submit and recover

Use `maxFeeLamports: 'AUTO'` in order and cancellation helpers.
An explicit integer string caps the fee in lamports.
The fee preference is outside the signed intent digest.

If the relayer returns `please deposit gas`, read the status again.
Deposit to the returned address and report the signature.
Then submit a fresh intent.

Concurrent intents can reserve fee balance before settlement.
Use the available balance from the latest status response.
Trading fees and relayer SOL fees are separate. `/config` supplies the current market fees.
