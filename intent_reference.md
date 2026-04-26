# Intent Reference

This file documents the current SDK intent model for the v5 FIFO perps path.
The SDK supports two submission paths:

- relayed commit/reveal submission via `submitPerp*ViaRelayer(...)`
- direct on-chain fallback via `submitPerp*Direct(...)`

Relayed submission is the normal path. Direct fallback should be rare and is
delayed on chain by the configured direct speed bump.

## Relayed v5 Intent Shape

The gRPC request is `CtmSequencerRelayer.SubmitIntent`.

Required fields:

- `group`: Mango group pubkey
- `execution_queue`: v5 queue PDA for the target market
- `market`: decimal market index
- `payload`: raw execution-queue payload bytes
- `remaining_accounts`: canonical dispatch accounts
- `min_execute_slot`: usually `0`
- `expires_at_slot`: usually `0`
- `user_owner`: owner/delegate pubkey
- `mango_account`: Mango account pubkey
- `user_signature`: ed25519 signature over the current v5 digest
- `intent_version`: `2`
- `target_kind`: `0` for perp market
- `target_index`: market index
- `client_order_id`: u64 replay nonce/randomizer
- `max_fee_lamports`: `AUTO` or an integer lamport cap

The SDK derives the per-market v5 queue PDA from `(programId, group,
marketIndex)` for high-level relayer helpers. `EXECUTION_QUEUE_PK` remains a
legacy/default override for callers that need it manually.

## Payload Framing

`payload` is not Anchor instruction data and not JSON. It is the raw
execution-queue payload:

```text
byte 0       : version = 1
byte 1       : variant
bytes 2..4   : flags = 0
bytes 4..end : variant body
```

Supported SDK variants:

| variant                              | body                  | helper                                                                   |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------ |
| `0` `PerpPlaceOrderV2`               | place order body      | `submitPerpOrderViaRelayer`, `submitPerpOrderDirect`                     |
| `2` `PerpCancelOrderByClientOrderId` | `u64 client_order_id` | `cancelPerpOrderByClientIdViaRelayer`, `cancelPerpOrderByClientIdDirect` |
| `3` `PerpCancelAllOrders`            | `u8 limit`            | `cancelAllPerpOrdersViaRelayer`, `cancelAllPerpOrdersDirect`             |

For production-like FIFO traffic, use `expiryTimestamp = 0`. Nonzero order
expiries can mature while the intent is waiting behind earlier queue work.

## Relayed User Signature

Relayed v5 intents sign `mango-v5-user-intent-v2`.

```text
sha256(
  utf8("mango-v5-user-intent-v2")
  || group_pubkey_32
  || mango_account_pubkey_32
  || user_owner_pubkey_32
  || kind_u8                  // 0 = CtmWrapped
  || target_kind_u8           // 0 = PerpMarket
  || target_index_u16_le
  || payload_hash_32          // sha256(payload)
  || accounts_hash_32         // canonical dispatch account hash
  || min_execute_slot_u64_le
  || expires_at_slot_u64_le
  || client_order_id_u64_le
)
```

`client_order_id` is the replay nonce bound into the user signature and into
the v5 on-chain rolling replay cache. The SDK behavior is:

- place order: use `params.clientOrderId` as both order id and replay nonce
  unless `params.intentClientOrderId` is set
- cancel by client id: use `params.clientOrderId` as the cancel target and a
  fresh random replay nonce unless `params.intentClientOrderId` is set
- cancel all: use a fresh random replay nonce unless
  `params.intentClientOrderId` is set

The legacy `mango-v4-user-intent-v2` builder remains exported only for older
deployments; current v5 helpers do not use it.

## Account Hash Rule

Each account contributes exactly:

```text
pubkey_32 || is_signer_u8 || is_writable_u8
```

Account order and duplicates matter.

For perp execution-queue intents, `remaining_accounts` must be ordered as:

```text
group
mango_account
user_owner
target_perp_market
target_bids
target_asks
target_event_queue
target_oracle
banks...
bank_oracles...
perp_markets...
perp_oracles...
serum3_open_orders...
openbook_open_orders...
fallback_oracles...
```

The health suffix is intentionally sectioned. Do not interleave
`perp_market, oracle` pairs. The on-chain health scanner first consumes all
banks, then all bank oracles, then a contiguous perp-market section, then a
matching contiguous perp-oracle section. Current SDK helpers include every
configured perp market in sorted market-index order to keep relayer lane hashes
stable across users and markets.

For relayed CTM enqueue, the SDK hashes the submitted `remaining_accounts`
after applying the effective runtime flags for fixed accounts:

- group: writable
- v5 queue: writable
- sysvar instructions: readonly

For v5 direct enqueue, the direct hash applies the same group/queue writability
normalization and also scrubs the owner/delegate account to readonly,
non-signer, matching on-chain verification.

## Direct Fallback Signature

Direct fallback signs `mango-v5-direct-intent-v1`:

```text
sha256(
  utf8("mango-v5-direct-intent-v1")
  || group_pubkey_32
  || mango_account_pubkey_32
  || user_owner_pubkey_32
  || kind_u8
  || target_kind_u8
  || market_index_u16_le
  || payload_hash_32
  || accounts_hash_32
  || expires_at_slot_u64_le
  || nonce_u64_le
)
```

Use `nonce` only as the direct replay nonce. It does not need to equal the
order payload `clientOrderId`.

## Minimal Relayed Example

```ts
import {
  ContinuumRelayerClient,
  PerpOrderSide,
  PerpOrderType,
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

const relayer = new ContinuumRelayerClient(process.env.RELAYER_ADDR!);

await submitPerpOrderViaRelayer(relayer, context, {
  marketIndex: 0,
  side: PerpOrderSide.bid,
  price: 120,
  quantity: 0.01,
  orderType: PerpOrderType.immediateOrCancel,
  expiryTimestamp: 0,
  maxFeeLamports: 'AUTO',
});
```

## Operational Defaults

- `maxFeeLamports: 'AUTO'` is the default recommendation.
- `minExecuteSlot = 0` is normal for relayed traffic.
- `expiresAtSlot = 0` avoids queue-delay expiry surprises.
- Use direct fallback only after the configured speed bump and only when the
  relayer path is unavailable or censored.
