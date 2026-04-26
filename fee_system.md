# Relayer Fee System

This document describes how external clients interact with the Continuum
relayer's fee ledger through `cont-sdk-fresh`. The SDK helpers live in
`src/fees.ts` and re-export through the package root.

The fee system is external to the signed core Mango intent. Users sign the
canonical Mango execution-queue intent message; fee preferences are sent only
to the relayer.

## Overview

The relayer maintains an off-chain SOL-denominated fee balance per
`(user_owner, mango_account)` pair. Every intent the relayer accepts debits
that balance by the current quoted fee. When an account's balance is
exhausted, further submits are rejected until the wallet tops up.

Balances accrue in two ways:

- **Sponsored seed** - on first interaction with a wallet, the relayer grants
  a default sponsored balance (100,000,000 lamports = 0.1 SOL by default;
  configured via `CTM_FEE_SPONSORED_SEED_LAMPORTS`).
- **Paid credit** - the client transfers SOL to the relayer's fee-deposit
  address with a canonical memo, then calls `POST /fees-deposited` to have
  the relayer scan that tx and apply credit.

The ledger lives server-side at `CTM_FEE_STATE_PATH` (default
`/tmp/ctm-fee-state.json`) with an append-only journal at
`CTM_FEE_JOURNAL_PATH` (default `/tmp/ctm-fee-journal.jsonl`). The relayer
persists state after every change, so restarts retain balances.

## Relayer Fee Preference

`SubmitIntentRequest` carries fee preference fields:

```proto
string base_fee = 11;
string max_fee_lamports = 16;
```

For clients:

- preferred gRPC / SDK field: `max_fee_lamports` / `maxFeeLamports`
- legacy gRPC / SDK alias: `base_fee` / `baseFee`
- HTTP bridge field, when exposed: `max_fee_lamports`

For most clients, use:

```text
AUTO
```

That means:

- the relayer computes the current internal quote for the target queue
- the request is accepted if the wallet has enough internal fee balance
- the relayer debits exactly its current quote, not an arbitrary client bid

If you need a cap, send an integer lamport amount instead:

```text
25000
```

Interpretation:

- `AUTO` means no client-side cap
- an integer value means "accept only if the current relayer quote is at or
  below this lamport amount"

If the cap is too low, the relayer rejects the request with a
`base fee too low requested=<...> required=<...>` class error.

Do not sign `max_fee_lamports` into the core user-intent digest. It is a
relayer-local admission preference.

## Enforcement Modes

Set server-side via `CTM_FEE_ENFORCEMENT_MODE`:

- `enforce` (default) - debit the ledger, reject intents with insufficient
  balance.
- `shadow` - compute and log fees but do not reject.
- `disabled` - skip fee logic entirely.

Clients see the current mode in `FeeStatus.enforcement_mode` and in the
`deposit.enforcement_mode` field of the response.

## Endpoints

The execution-engine HTTP server binds to `CTM_EXECUTION_ENGINE_HTTP_BIND_ADDR`
(devnet default `0.0.0.0:9093`).

### `GET /fees/status`

Query params (URL-encoded):

| Name              | Required | Notes                                                    |
| ----------------- | -------- | -------------------------------------------------------- |
| `user_owner`      | yes      | Wallet pubkey (base58).                                  |
| `mango_account`   | yes      | Mango account pubkey (base58).                           |
| `market`          | no       | Perp market index. Alias: `market_index`. Default: 0.    |
| `group`           | no       | Mango group pubkey. Used to derive the queue quote.      |
| `execution_queue` | no       | Per-market queue PDA. If present, the quote reflects it. |

Response body (`FeeStatus`):

```json
{
  "ok": true,
  "user_owner": "...",
  "mango_account": "...",
  "enforcement_mode": "enforce",
  "fee_account": {
    "mango_account": "...",
    "user_owner": "...",
    "sponsored_seed_total_lamports": 100000000,
    "sponsored_seed_remaining_lamports": 32475000,
    "paid_credit_total_lamports": 0,
    "paid_credit_remaining_lamports": 0,
    "reserved_lamports": 73000,
    "debited_lamports_total": 67525000,
    "available_balance_lamports": 32402000,
    "daily_quota_limit": null,
    "daily_quota_used": 67525000,
    "status": "active"
  },
  "quote": {
    "market_index": 1,
    "quoted_fee_lamports": 73000,
    "service_base_lamports": 25000,
    "chain_cost_lamports": 48000,
    "queue_pressure_multiplier_bps": 10000,
    "bg_pressure_multiplier_bps": 10000,
    "applied_multiplier_bps": 10000,
    "queue_count": 62,
    "queue_soft_limit": 900,
    "queue_head_available": true,
    "normal_max_fee_lamports": 10000000,
    "emergency_max_fee_lamports": 25000000
  },
  "deposit": {
    "deposit_address": "CyJSpqonriELcXeSQXnZ17AQsb77ZsHWFdttMmBstq8s",
    "memo": "fee_credit:v1:<user_owner>:<mango_account>",
    "crediting_path": "/fees-deposited",
    "enforcement_mode": "enforce"
  },
  "recent_entries": []
}
```

A wallet that has never interacted with the relayer will have a fee account
auto-created on first `/fees/status` query.

### `POST /fees-deposited`

Body (`FeeDepositCreditRequest`):

```json
{
  "source_chain": "solana-devnet",
  "source_tx_signature": "<signature of the deposit tx>",
  "instruction_index": 1,
  "user_owner": "...",
  "mango_account": "...",
  "amount_lamports": 100000000,
  "deposit_address": "CyJSpqonriELcXeSQXnZ17AQsb77ZsHWFdttMmBstq8s",
  "memo": "fee_credit:v1:<user_owner>:<mango_account>",
  "observed_at_ms": 1777020802538
}
```

Headers:

- `Content-Type: application/json`
- `Authorization: <CTM_FEE_ADMIN_TOKEN>` - only if the relayer was started
  with that env set; otherwise the endpoint is open.

Semantics:

- Idempotent on `source_tx_signature` + `instruction_index`. Repeated calls
  return `duplicate: true` with the current snapshot.
- The relayer fetches the tx from chain, verifies the transfer at
  `instruction_index` went to `deposit_address` from `user_owner` for exactly
  `amount_lamports`, and confirms a memo instruction carrying `memo`.
- On success, returns the updated `FeeAccount` plus the latest ledger rows.

Error responses:

- `400 Bad Request` - validation failed (bad pubkey, memo mismatch, tx
  doesn't contain the described transfer, etc).
- `401 Unauthorized` - admin token required and missing/invalid.
- `503 Service Unavailable` - fee service is disabled.

## Fee Account Lifecycle

Every intent the relayer admits flows through the ledger:

1. **Reserve** at intent admission - `reservation_hold` entry,
   `reserved_lamports += quote`.
2. **Debit** at settle (after commit tx lands) - `intent_debit` entry,
   `reserved_lamports -= quote`, `debited_lamports_total += quote`, charged
   first against `sponsored_seed_remaining`, then `paid_credit_remaining`.
3. **Release** if the intent is rejected post-reservation -
   `reservation_release`, `reserved_lamports -= quote`.

`available_balance_lamports` is always
`sponsored_seed_remaining + paid_credit_remaining - reserved`. This is the
quantity the admission check compares against.

## Quote Breakdown

`quoted_fee_lamports = service_base_lamports + chain_cost_lamports`, scaled by
`applied_multiplier_bps / 10000` (bps to ratio). The multiplier is derived from
queue pressure and background-submitter pressure; at idle both are `10000`
(1.0x).

Defaults (devnet):

- `service_base_lamports` = 25,000 (`CTM_FEE_SERVICE_BASE_LAMPORTS`)
- `chain_cost_lamports` = 48,000 =
  `submit_CU_estimate * chain_cost_mul_bps / 10000`
- Hard caps: `normal_max_fee_lamports=10,000,000`,
  `emergency_max_fee_lamports=25,000,000` (rare-spike ceiling).

Under quiet conditions a 73,000-lamport fee is approximately 0.000073 SOL.

## Deposit Tx Structure

The deposit tx must contain exactly two instructions in this order:

| Index | Program                                       | Purpose                             |
| ----- | --------------------------------------------- | ----------------------------------- |
| 0     | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` | Memo v2 carrying attribution string |
| 1     | `11111111111111111111111111111111` (System)   | `SystemProgram.transfer` to deposit |

The memo string is:

```text
fee_credit:v1:<user_owner>:<mango_account>
```

`FeeDepositCreditRequest.instruction_index` must be `1` (the transfer ix).
The relayer will validate that the transfer's `from` matches `user_owner`,
`to` matches the configured deposit address, and the tx contains a memo
instruction whose UTF-8 data matches `memo` exactly.

## SDK Usage

For the complete client runbook, including which service port to use, startup
preflight, top-up, submit, and retry behavior, see
[docs/fee-path-end-to-end.md](./docs/fee-path-end-to-end.md).

Import from the SDK root:

```ts
import {
  ContinuumFeeClient,
  buildFeeDepositInstructions,
  buildFeeDepositMemo,
  depositFeeCredit,
} from '@fermilabs/continuum-sdk';
```

### Check balance and current quote

```ts
const fees = new ContinuumFeeClient('http://127.0.0.1:9093');
const status = await fees.getStatus({
  userOwner: wallet.publicKey,
  mangoAccount,
  market: 1,
});
console.log('available:', status.fee_account.available_balance_lamports);
console.log('next intent cost:', status.quote.quoted_fee_lamports);
```

### Submit intents with a fee preference

The high-level trading helpers accept `maxFeeLamports?: string`. `baseFee` is
kept as a legacy alias.

```ts
await submitPerpOrderViaRelayer(relayer, context, {
  marketIndex: 0,
  side: PerpOrderSide.bid,
  price: 120,
  quantity: 0.01,
  maxFeeLamports: 'AUTO',
});
```

With an explicit cap:

```ts
await submitPerpOrderViaRelayer(relayer, context, {
  marketIndex: 0,
  side: PerpOrderSide.bid,
  price: 120,
  quantity: 0.01,
  maxFeeLamports: '25000',
});
```

The same fee preference applies to:

- `cancelPerpOrderByClientIdViaRelayer`
- `cancelAllPerpOrdersViaRelayer`

### Deposit (one-shot)

```ts
const fees = new ContinuumFeeClient('http://127.0.0.1:9093');
const resp = await depositFeeCredit({
  connection,
  payer, // Keypair - also the user_owner signer
  userOwner: payer.publicKey,
  mangoAccount,
  lamports: 100_000_000, // 0.1 SOL
  feeClient: fees,
  // optional: depositAddress if you want to skip the /fees/status preflight
  // optional: adminToken if CTM_FEE_ADMIN_TOKEN is set on the relayer
});
console.log('credited:', resp.fee_account.paid_credit_remaining_lamports);
```

### Deposit (manual - build, sign, send, report yourself)

```ts
// 1. Discover the deposit address.
const status = await fees.getStatus({ userOwner, mangoAccount });
const depositAddress = status.deposit.deposit_address;

// 2. Build the two required instructions.
const { instructions, memo, transferInstructionIndex } =
  buildFeeDepositInstructions({
    payer: payer.publicKey,
    userOwner,
    mangoAccount,
    depositAddress,
    lamports: 100_000_000,
  });

// 3. Sign and send.
const tx = new Transaction().add(...instructions);
const sig = await sendAndConfirmTransaction(connection, tx, [payer]);

// 4. Tell the relayer to credit it.
const resp = await fees.reportDeposit({
  source_chain: 'solana-devnet',
  source_tx_signature: sig,
  instruction_index: transferInstructionIndex, // always 1
  user_owner: userOwner.toBase58(),
  mango_account: mangoAccount.toBase58(),
  amount_lamports: 100_000_000,
  deposit_address: depositAddress,
  memo,
});
```

## Raw Relayer Request Example

```json
{
  "group": "<group>",
  "execution_queue": "<queue>",
  "market": "0",
  "max_fee_lamports": "AUTO",
  "payload_b64": "<payload>",
  "remaining_accounts": [],
  "min_execute_slot": "0",
  "expires_at_slot": "0",
  "user_owner": "<wallet>",
  "mango_account": "<mango_account>",
  "client_order_id": "1775489806394",
  "user_signature_b64": "<signature>"
}
```

## Error Handling

Relevant errors bots should expect from the relayer's intent-submit path when
fees are enforced:

- `insufficient fees: need=<N> available=<M>` or `please deposit gas` -
  deposit more SOL and call `/fees-deposited`.
- `base fee too low requested=<N> required=<M>` - retry with `AUTO` or a
  higher cap.
- `fee ledger disabled` - `CTM_FEE_ENFORCEMENT_MODE=disabled` on the relayer;
  no action needed on client.
- transport / RPC errors - retry according to your normal networking policy.

From `/fees/status` / `/fees-deposited`:

- `400` - malformed request (bad pubkey, missing params, tx doesn't match
  declared deposit).
- `401` - admin token required and missing or wrong.
- `503` - fee service disabled.
- `500` - internal error (ledger write failure, etc).

## Client Guidance

- Call `/fees/status` on startup so you know the current quote and have the
  deposit address cached.
- Submit intents with `maxFeeLamports: 'AUTO'` unless you intentionally want a
  lamport cap.
- Re-check `/fees/status` periodically (for example every 1-5 min) or whenever
  an intent gets rejected with an insufficient-fees class error.
- Treat `sponsored_seed_remaining_lamports > 0` as free headroom; only deposit
  once it is exhausted.
- `deposit.deposit_address` can change if the relayer operator rotates the
  payer; do not hardcode it client-side.
- Keep one `(user_owner, mango_account)` pair per logical bot. The ledger key
  is the pair, so using two different Mango accounts with the same wallet
  means two independent balances.

Do not:

- assume Mango margin deposits fund relayer fees automatically
- assume the relayer reads the wallet's live on-chain SOL balance
- sign `max_fee_lamports` into the core user-intent digest
- rely on the relayer charging your requested cap exactly

## Relayer Configuration Reference

Env vars honored by the relayer (server-side):

| Var                                      | Default                      | Purpose                                                 |
| ---------------------------------------- | ---------------------------- | ------------------------------------------------------- |
| `CTM_FEE_ENFORCEMENT_MODE`               | `enforce`                    | `enforce` / `shadow` / `disabled`                       |
| `CTM_FEE_STATE_PATH`                     | `/tmp/ctm-fee-state.json`    | Ledger state file (atomic write via `.tmp` + rename)    |
| `CTM_FEE_JOURNAL_PATH`                   | `/tmp/ctm-fee-journal.jsonl` | Append-only ledger journal                              |
| `CTM_FEE_DEPOSIT_ADDRESS`                | relayer payer pubkey         | Override deposit destination                            |
| `CTM_FEE_ADMIN_TOKEN`                    | unset (endpoint open)        | If set, `POST /fees-deposited` requires `Authorization` |
| `CTM_FEE_SPONSORED_SEED_LAMPORTS`        | 100,000,000                  | Default sponsored balance for new accounts              |
| `CTM_FEE_SERVICE_BASE_LAMPORTS`          | 25,000                       | Flat service fee component                              |
| `CTM_FEE_CHAIN_COST_MULTIPLIER_BPS`      | 12,000                       | `chain_cost = submit_CU_estimate * this / 10000`        |
| `CTM_FEE_NORMAL_MAX_LAMPORTS`            | 10,000,000                   | Hard cap on quoted fee under normal conditions          |
| `CTM_FEE_EMERGENCY_MAX_LAMPORTS`         | 25,000,000                   | Hard cap during queue/bg pressure surges                |
| `CTM_FEE_SUBMIT_COMPUTE_UNITS_ESTIMATE`  | 1,400,000                    | CU estimate used to derive `chain_cost_lamports`        |
| `CTM_FEE_EXECUTE_COMPUTE_UNITS_ESTIMATE` | see execution-engine source  | Reveal-side CU estimate                                 |
| `CTM_FEE_RECENT_ENTRIES_CAP`             | 1,024                        | Max rows returned in `recent_entries`                   |

## Route Compatibility Notes

The execution-engine HTTP server exposes `/fees/status` and
`/fees-deposited`. Older drafts referred to `/relay/fee-config` and
`/relay/deposit-fees`; those are not the canonical execution-engine routes in
this SDK. If an external gateway exposes aliases, confirm them with the gateway
operator before integrating against them.
