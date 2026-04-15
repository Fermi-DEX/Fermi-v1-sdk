# Relayer Fee System

This document explains how external clients should handle relayer fee-gating
when submitting intents through `cont-sdk-fresh`.

This fee system is external to the signed core intent payload.

The user still signs the canonical Mango execution-queue intent message, but
the caller must also provide a fee preference to the relayer.

## What Changed

`SubmitIntentRequest` now carries:

```proto
string base_fee = 11;
```

For clients, that means:

- gRPC / SDK field: `base_fee`
- HTTP bridge field: `_base_fee`
  The bridge also accepts `base_fee`, but `_base_fee` is the preferred bridge
  field name.

## Recommended Default

Use:

```text
AUTO
```

That means:

- the relayer computes the current internal base fee for the target queue
- the request is accepted if the wallet has enough internal fee balance
- the relayer debits exactly its current internal fee, not an arbitrary client
  bid

For most clients, `AUTO` is the correct default.

## Fee Cap Semantics

If you want to cap what the relayer may charge, send a maximum instead of
`AUTO`.

Accepted formats:

- `AUTO`
- `0.00002`
- `0.00002sol`
- `25000lamports`
- `25000lamport`

Interpretation:

- `AUTO` means no fee cap
- a numeric value means "accept only if current internal base fee is at or
  below this amount"

If the cap is too low, the relayer rejects the request with:

```text
base fee too low requested=<...> required=<...>
```

## Internal Fee Balance

The relayer maintains an internal SOL fee ledger per wallet.

This ledger is separate from:

- the Mango account's deposited USDC
- the wallet's on-chain SOL balance

The relayer debits this internal ledger every time an intent is accepted.

If the wallet's internal fee balance is too low, the relayer rejects with:

```text
please deposit gas
```

The rejection currently includes:

- `required_lamports`
- `available_lamports`
- `deposit_address`

## Auto Quota

On first fee-ledger initialization for a wallet, the relayer grants a default
internal fee quota:

```text
0.1 SOL
```

Important:

- this is an implementation detail of the current relayer
- clients should not assume it will always be available forever
- clients should still be prepared to top up fees through `deposit-fees`

## Client Flow

The client-side flow should be:

1. Query the current fee config for the wallet.
2. Submit intents with `AUTO` unless you intentionally want a cap.
3. If the relayer returns `please deposit gas`, fetch the deposit address.
4. Send SOL from the user wallet to the deposit address.
5. Call `deposit-fees` with the transfer tx signature.
6. Retry the intent.

## Endpoints

If you are already using the HTTP bridge / gateway, the relevant fee endpoints
are available there too.

### `GET /relay/fee-config`

Use this to discover:

- `deposit_address`
- `current_internal_base_fee_lamports`
- `current_internal_base_fee_sol`
- current wallet fee balance
- whether the auto quota has already been consumed

Typical request:

```text
GET <gateway>/relay/fee-config?owner=<wallet>&group=<group>&execution_queue=<queue>
```

Typical response fields:

- `fee_gate_enabled`
- `deposit_address`
- `current_internal_base_fee_lamports`
- `current_internal_base_fee_sol`
- `balance_lamports`
- `balance_sol`
- `auto_quota_granted`
- `auto_quota_available_lamports`
- `auto_quota_available_sol`
- `total_deposited_lamports`
- `total_charged_lamports`

### `POST /relay/deposit-fees`

After sending SOL to the relayer deposit address, call:

```json
{
  "user_owner": "<wallet pubkey>",
  "tx_signature": "<solana transfer tx signature>"
}
```

Response fields include:

- `credited_lamports`
- `credited_sol`
- `balance_lamports`
- `balance_sol`
- `deposit_address`

The endpoint is idempotent for the same tx signature.

## SDK Usage

The high-level SDK helpers now accept `baseFee?: string`.

Example:

```ts
await submitPerpOrderViaRelayer(relayer, context, {
  marketIndex: 0,
  side: PerpOrderSide.bid,
  price: 120,
  quantity: 0.01,
  baseFee: 'AUTO',
});
```

You can also set an explicit cap:

```ts
await submitPerpOrderViaRelayer(relayer, context, {
  marketIndex: 0,
  side: PerpOrderSide.bid,
  price: 120,
  quantity: 0.01,
  baseFee: '25000lamports',
});
```

The same applies to:

- `cancelPerpOrderByClientIdViaRelayer`
- `cancelAllPerpOrdersViaRelayer`

## Raw HTTP Example

Bridge request example:

```json
{
  "group": "<group>",
  "execution_queue": "<queue>",
  "market": "0",
  "_base_fee": "AUTO",
  "payload_b64": "<payload>",
  "remaining_accounts": [],
  "min_execute_slot": "0",
  "expires_at_slot": "0",
  "user_owner": "<wallet>",
  "mango_account": "<mango_account>",
  "user_signature_b64": "<signature>"
}
```

## What Clients Should Not Do

Do not:

- assume Mango margin deposits fund relayer fees automatically forever
- assume the relayer reads the wallet's live on-chain SOL balance
- sign `base_fee` into the core user-intent digest
- rely on the relayer charging your requested cap exactly

The relayer charges its current internal base fee, subject to your cap.

## Error Handling Guidance

Treat these cases separately:

- `please deposit gas`
  Top up fee balance via `deposit-fees`.
- `base fee too low`
  Retry with `AUTO` or a higher cap.
- transport / RPC errors
  Retry according to your normal networking policy.

## Recommended Client Strategy

For most bots or external integrations:

- fetch `/relay/fee-config` on startup
- submit with `AUTO`
- on `please deposit gas`, deposit more SOL and call `/relay/deposit-fees`
- periodically re-read `/relay/fee-config` to monitor fee burn and current base
  fee
