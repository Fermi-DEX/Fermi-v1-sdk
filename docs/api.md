# Continuum State Harness API Reference

This document is the end-user API reference for the local/testnet/mainnet **Continuum State Harness** service.

The harness provides a single HTTP/SSE surface for:

- optimistic state (relay-accepted intents + confirmed chain state),
- confirmed state (executed on-chain queue outcomes only),
- queue health, divergence diagnostics, and replay tooling.

## Version and Stability

- Current API version: `v1` (implicit, pathless).
- Compatibility: additive fields may be introduced without a breaking change.
- Breaking changes: endpoint or schema-breaking changes should be introduced behind a new versioned path.

## Base URL

Default local URL:

```text
http://127.0.0.1:9091
```

The `fermi-r6-mainnet` smoke deployment uses `http://127.0.0.1:9191` for the
harness, `127.0.0.1:9190` for relayer gRPC, and `http://127.0.0.1:9193` for
fee HTTP.

Set via:

- `CONTINUUM_HARNESS_BIND_ADDR`

### Exact Localhost Endpoints Requested

- `http://127.0.0.1:9091/state/markets?markets=0,1&view=optimistic|confirmed&depth=10&book=summary|full`
- `http://127.0.0.1:9091/state/markets/<market>?view=optimistic|confirmed&depth=10`
- `http://127.0.0.1:9091/state/balances/<owner>?view=optimistic|confirmed`
- `http://127.0.0.1:9091/state/trades?market=<market>&owner=<owner>&view=optimistic|confirmed&limit=200`
- `http://127.0.0.1:9091/state/trades/<market>?view=optimistic|confirmed&limit=200`
- `http://127.0.0.1:9091/state/trades/summary?market=<market>&owner=<owner>&view=optimistic|confirmed`
- `http://127.0.0.1:9091/state/stream/trades?market=<market>&view=optimistic|confirmed&backfill_n=50`
- `http://127.0.0.1:9091/state/stream/frontend?owner=<owner>&mango_account=<account>&market=<market>`
- `http://127.0.0.1:9091/state/candles/<market>?view=optimistic|confirmed&resolution_sec=60&limit=200`
- `http://127.0.0.1:9091/airdrop` (POST body with connected wallet pubkey)
- `http://127.0.0.1:9091/airdrop-deposit` (POST body with connected wallet pubkey)
- `http://127.0.0.1:9091/config`
- `http://127.0.0.1:9091/state/bootstrap`

## Authentication

### Relay ingest endpoint auth

`POST /ingest/relay-intent` optionally requires bearer token auth.

- Env: `CONTINUUM_HARNESS_RELAY_INGEST_TOKEN`
- Header:

```http
Authorization: Bearer <token>
```

If no token is configured, ingest is open.

### Read endpoints

Read endpoints are currently unauthenticated by default.

### Airdrop endpoint

`POST /airdrop` is intended for local/test deployments only and should not be exposed publicly.

## Content Types

- Request JSON: `application/json`
- Response JSON: `application/json`
- Metrics: `text/plain`
- SSE stream: `text/event-stream`

## Core Concepts

- `view=optimistic`: confirmed state + pending relay-accepted intents.
- `view=confirmed`: only executed queue outcomes.
- `market`: current implementation uses market index as string (for example `"0"`).
- `owner`: user owner pubkey (base58).

## Endpoints

## 1) Health and Operations

### `GET /healthz`

Returns harness status and high-level counts.

Response `200`:

```json
{
  "ok": true,
  "mode": "local",
  "intents_total": 10,
  "divergences_total": 0,
  "markets_total": 1,
  "users_total": 2,
  "queue_views_total": 1,
  "sse_clients": 0,
  "airdrop_enabled": true,
  "airdrop_deposit_enabled": true,
  "generated_ts_ms": 1772349020285
}
```

### `GET /livez`

Simple liveness probe.

Response `200`:

```json
{
  "ok": true,
  "ts_ms": 1772349020285
}
```

### `GET /config`

Returns public deployment metadata that clients need for transaction
construction without embedding mainnet constants. The response excludes
local keypair paths and private material.

Alias: `GET /state/bootstrap`.

Response `200`:

```json
{
  "version": 1,
  "cluster": "mainnet-beta",
  "program_id": "...",
  "group": "...",
  "authority_state": "...",
  "ctm_signer": "...",
  "tokens": {
    "0": {
      "symbol": "USDC",
      "mint": "...",
      "bank": "...",
      "vault": "...",
      "oracle": "...",
      "mint_info": "...",
      "token_program": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    }
  },
  "markets": [
    {
      "market_index": 0,
      "name": "SOL-PERP",
      "perp_market": "...",
      "bids": "...",
      "asks": "...",
      "event_queue": "...",
      "oracle": "...",
      "base_lot_size": "100",
      "quote_lot_size": "1",
      "execution_queue": {
        "address": "...",
        "direct_pool": "...",
        "layout_version": 7
      }
    }
  ]
}
```

### `GET /metrics`

Prometheus-style gauges.

Response `200` (text):

```text
# TYPE continuum_harness_intents_total gauge
continuum_harness_intents_total 10
# TYPE continuum_harness_divergences_total gauge
continuum_harness_divergences_total 0
# TYPE continuum_harness_markets_total gauge
continuum_harness_markets_total 1
# TYPE continuum_harness_users_total gauge
continuum_harness_users_total 2
# TYPE continuum_harness_sse_clients gauge
continuum_harness_sse_clients 0
```

### `GET /diagnostics/divergence?limit=<n>`

Lists recent divergence events.

Query params:

- `limit` optional, default `200`

Response `200`:

```json
{
  "items": [
    {
      "event_type": "divergence_event",
      "ts_ms": 1772349020285,
      "reason": "processed_without_relay_intent",
      "key": "<group>:<sequence>:<kind>",
      "details": {
        "status": "3",
        "slot": "123",
        "tx_signature": "..."
      }
    }
  ]
}
```

### `POST /admin/replay`

Triggers snapshot generation/replay path and returns timestamps.

Response `200`:

```json
{
  "ok": true,
  "optimistic_generated_ts_ms": 1772349020285,
  "confirmed_generated_ts_ms": 1772349020285
}
```

### `POST /airdrop`

Mints local/test USDC from the configured faucet mint authority to a wallet ATA.

Request body:

```json
{
  "owner": "FByAc4zWBnKKKnvdXSscFsztYBLgbUtmbVobnMVYxzkC",
  "ui_amount": 250
}
```

Alternative owner sources:

- `?owner=<pubkey>` query param
- `x-wallet-pubkey: <pubkey>` header

If `ui_amount` is omitted, harness default amount is used.

Response `200`:

```json
{
  "ok": true,
  "owner": "FByAc4zWBnKKKnvdXSscFsztYBLgbUtmbVobnMVYxzkC",
  "mint": "3kWXL6KRYf3CXp1De6q2tuFZc3spBtUbU4hNoCboBTCg",
  "destination_token_account": "8j8YqW5WE8MnN4R1xC4S4Q4Zf8D3Vj4eGj1hVq5MuQeW",
  "ui_amount": 250,
  "raw_amount": "250000000",
  "tx_signature": "5Qf...abc"
}
```

Errors:

- `400` invalid input, amount limit exceeded, or endpoint disabled
- `500` mint/send runtime error

### `POST /airdrop-deposit`

Credits `1000 USDC` directly inside Mango protocol accounting for a user via the on-chain `unsafe_deposit` instruction.

This is intentionally unsafe and test-only. It bypasses real token transfer semantics and must never be enabled in production.

Request body:

```json
{
  "owner": "FByAc4zWBnKKKnvdXSscFsztYBLgbUtmbVobnMVYxzkC",
  "mango_account": "optional-mango-account-pubkey"
}
```

Notes:

- `ui_amount` is fixed by harness config (`CONTINUUM_HARNESS_AIRDROP_DEPOSIT_UI_AMOUNT`, default `1000`).
- If `mango_account` is omitted, the first Mango account for `owner` in the configured group is used.

Response `200`:

```json
{
  "ok": true,
  "owner": "FByAc4zWBnKKKnvdXSscFsztYBLgbUtmbVobnMVYxzkC",
  "mango_account": "gddrsZnnddtquJHquhCmqq3bekkW3MN5SBCSJSij79j",
  "group": "9VYm4QaBhEPEiFfyGxXEDpN7ZTh2muajTDebKrDL4f5k",
  "mint": "DnTjy48VD6KN2mkXoaHjmgtMxjT1Ub9dc64vxPfiHomA",
  "ui_amount": 1000,
  "raw_amount": "1000000000",
  "unsafe_deposit_tx_signature": "5Qf...abc",
  "execution_path": "unsafe_deposit"
}
```

Errors:

- `400` invalid/missing owner, account mismatch, endpoint disabled, or fixed-amount mismatch
- `500` runtime failure

`execution_path` values:

- `unsafe_deposit`: new on-chain unsafe instruction path was used.
- `token_deposit_into_existing_fallback`: node is running an older program binary; harness fell back to mint+deposit-into-existing path.

## 2) Client Intent Submission

Clients submit intents via the **relayer**, not the harness. The relayer
accepts two transports: gRPC (:9090) and an HTTP bridge (:9092). Both share
the same payload schema and signing rules.

Since the v5 cutover, every accepted intent flows through the commit-reveal
pipeline on chain:

1. Client signs a v5 intent and submits it via gRPC/HTTP.
2. Relayer assigns a monotonic `sequence`, computes `commit_hash`, and lands
   a `commit_market` tx on chain.
3. Relayer's in-process reveal worker later submits a `reveal_execute_market`
   tx with the full payload, which dispatches the underlying perp instruction.
4. Clients watch `/state/queue/<market>` or the harness SSE stream to
   observe execution.

Clients **do not** build, sign, or track the commit/reveal transactions —
the relayer handles that. Clients sign only the current
`mango-v5-user-intent-v2` intent digest.

### gRPC `CtmSequencerRelayer.SubmitIntent` — default port `:9090`

```proto
syntax = "proto3";
package ctmsequencer;

message AccountMeta {
  string pubkey = 1;
  bool   is_signer = 2;
  bool   is_writable = 3;
}

message SubmitIntentRequest {
  string group               = 1;   // base58 group pubkey
  string execution_queue     = 2;   // legacy; empty string accepted under v4 route
  string market              = 3;   // market_index as decimal string ("0", "1", ...)
  bytes  payload             = 4;   // framed intent payload (see below)
  repeated AccountMeta remaining_accounts = 5; // optional; relayer derives when empty
  uint64 min_execute_slot    = 6;   // 0 = asap
  uint64 expires_at_slot     = 7;   // 0 = never
  string user_owner          = 8;   // base58
  string mango_account       = 9;   // base58, must exist under the group
  bytes  user_signature      = 10;  // 64-byte ed25519 signature (see signing)
  string base_fee            = 11;  // legacy fee-cap alias
  uint32 intent_version      = 12;  // 2
  uint32 target_kind         = 13;  // 0 = PerpMarket
  uint32 target_index        = 14;  // same as `market` for perp
  uint64 client_order_id     = 15;  // user replay nonce/randomizer
  string max_fee_lamports    = 16;  // "auto" or integer lamports
}

message SubmitIntentResponse {
  uint64 sequence               = 1; // v4 sequence assigned to this intent
  string tx_signature           = 2; // on-chain signature of the commit_market tx
  bytes  user_intent_message    = 3; // 32-byte canonical_user_intent_message_v3 (echo)
  bytes  ctm_envelope_message   = 4; // 32-byte placeholder for legacy compatibility
  double accepted_latency_ms    = 5;
  double optimistic_processed_latency_ms = 6;
}

service CtmSequencerRelayer {
  rpc SubmitIntent(SubmitIntentRequest) returns (SubmitIntentResponse);
}
```

### HTTP bridge `POST /relay/submit-intent` — default port `:9092`

Convenience wrapper over the gRPC call for browser / non-Rust clients.

Request body:

```json
{
  "group": "3FDdg3kMYutwUiChQ3rQryt2ktQyujtvJvHwU9ypPBMi",
  "execution_queue": "",
  "market": "0",
  "payload_b64": "<base64 of the 49-byte framed payload>",
  "remaining_accounts": [
    { "pubkey": "...", "is_signer": false, "is_writable": true }
  ],
  "min_execute_slot": "0",
  "expires_at_slot": "0",
  "user_owner": "BvUeT57AWhCjAYfBAQrtuHT24BsBa94uiDhPnVp3kTa7",
  "mango_account": "FGxSs4fio65cKzAwuGhBxwHscXq9JXmEMe33mAKZ33Pt",
  "user_signature_b64": "<base64 of 64-byte ed25519 signature>",
  "intent_version": 2,
  "target_kind": 0,
  "target_index": 0,
  "client_order_id": "1775489806394",
  "max_fee_lamports": "AUTO"
}
```

Response `200`:

```json
{
  "sequence": "1274",
  "tx_signature": "5qrsaYGu...commit_market_sig...",
  "user_intent_message_b64": "<base64 of 32-byte canonical hash>",
  "ctm_envelope_message_b64": "<base64 of 32-byte placeholder>"
}
```

Errors:

- `400` missing/invalid fields
- `500` gRPC dispatch failure

### Helper endpoint: `GET /relay/config?owner=<pubkey>` — port `:9092`

Returns the group/queue/market/mango_account bundle + execution lanes for
the given owner so clients can populate the submit request correctly.

```json
{
  "group": "3FDdg3kMYutwUiChQ3rQryt2ktQyujtvJvHwU9ypPBMi",
  "execution_queue": "5d9v9RF6EZMA4NXnGPN2ikshTgY4FCcJDoFPkjofRtWa",
  "market": "0",
  "mango_account": "FGxSs4fio65cKzAwuGhBxwHscXq9JXmEMe33mAKZ33Pt",
  "owner_to_mango_account": { "BvUeT57A...": "FGxSs4fio..." },
  "lanes": [
    {
      "name": "lane-0",
      "remaining_accounts": [
        { "pubkey": "...", "is_signer": false, "is_writable": true }
      ]
    }
  ]
}
```

### Payload framing

The `payload` field carries a v1-framed variant body:

```
byte 0       : version = 1
byte 1       : variant
bytes 2..4   : flags = 0 (reserved)
bytes 4..end : variant-specific body (AnchorSerialize)
```

Supported variants:

| variant                              | body                           | notes                       |
| ------------------------------------ | ------------------------------ | --------------------------- |
| `0` `PerpPlaceOrderV2`               | 45 B `PerpPlaceOrderV2Payload` | place perp order            |
| `1` `PerpCancelOrder`                | 8 B `u64 order_id`             | cancel by on-chain order id |
| `2` `PerpCancelOrderByClientOrderId` | 8 B `u64 client_order_id`      | cancel by client id         |
| `3` `PerpCancelAllOrders`            | 1 B `u8 limit`                 | mass cancel                 |
| `4` `PerpCancelAllOrdersBySide`      | 1 B `side` + 1 B `u8 limit`    | one-sided mass cancel       |

`PerpPlaceOrderV2Payload` (45 B, AnchorSerialize order):

```
side                : u8  (0=Bid, 1=Ask)
price_lots          : i64 (LE)
max_base_lots       : i64 (LE)
max_quote_lots      : i64 (LE)
client_order_id     : u64 (LE)
order_type          : u8  (0=Limit, 1=IOC, 2=PostOnly, 3=Market, 4=PostOnlySlide)
self_trade_behavior : u8  (0=DecrementTake, 1=CancelProvide, 2=AbortTransaction)
reduce_only         : u8  (0/1)
expiry_timestamp    : u64 (LE; unix seconds; 0=no TTL; non-zero + past = terminal)
limit               : u8  (max matches per tx)
```

### Intent signing

Clients sign `canonical_user_intent_message_v3`:

```
msg_hash = sha256(
    "mango-v5-user-intent-v2"    // literal
    || group                      // 32 bytes
    || mango_account              // 32 bytes
    || user_owner                 // 32 bytes
    || [kind=0]                   // u8, CtmWrapped
    || [target_kind=0]            // u8, PerpMarket
    || market_index_le            // u16 LE
    || payload_hash               // 32 bytes = sha256(payload)
    || accounts_hash              // 32 bytes = canonical account hash
    || min_execute_slot_le        // u64 LE
    || expires_at_slot_le         // u64 LE
    || client_order_id_le         // u64 LE replay nonce/randomizer
)
```

`user_signature` is the 64-byte ed25519 signature over `msg_hash`.

For place-order helpers, the SDK uses the order `clientOrderId` as
`client_order_id` unless `intentClientOrderId` is supplied. Cancel helpers
generate a fresh random u64 replay nonce by default.

For frontend/wallet compatibility the relayer also accepts a signature over
the lowercase hex utf-8 representation of `msg_hash` (64 ASCII bytes),
useful for wallets that only sign UTF-8 messages.

### Deployment Pubkey Bundle

Do not hardcode old devnet bundles in production clients. Read the active
group, market, and queue addresses from your operator run config or from the
gateway config endpoint for the environment you are targeting.

Historical example only:

| Key                     | Value                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| Program ID              | `5KaJhG2AxyFbyNorYLtUUmrKXZMMGGWDQUzetQgS3LqB`                                                             |
| Group                   | `3FDdg3kMYutwUiChQ3rQryt2ktQyujtvJvHwU9ypPBMi`                                                             |
| USDC mint               | `3u3nk3mpo49NceRVsTfuZ43H8AwEXPYyNJfi6CLy2iTp`                                                             |
| USDC decimals           | 6                                                                                                          |
| Market 0 perp_market    | `G4mWsvmkcbwfDWs6XhcVHmsP9ZSSs1bzVA7ta7e7Znw3`                                                             |
| Market 1 perp_market    | `H2Ydm35VdTJhMAQFgczQMEkapchG1w3JFovbNxzCWQfa`                                                             |
| Market \<N\> queue_root | per-market v4 PDA; derive from `["commit-queue-root", group, market_index_le, shard_id=0]` over program_id |

For the full per-market bundle (bids, asks, event_queue, oracle, queue_root,
queue_page0), see `/relay/config` or the SDK helper `getV4Bundle()`.

## 3) Relay Event Sink (relayer → harness)

### `POST /ingest/relay-intent`

**Internal endpoint.** Emitted by the relayer to keep the harness optimistic
state in sync with accepted/submitted/failed intents. Clients should not
post here; they should submit via gRPC / `/relay/submit-intent` (Section 2).

Two event variants share this endpoint:

#### `relay_intent_accepted` — when an intent passes ingress validation

```json
{
  "event_type": "relay_intent_accepted",
  "ts_ms": 1772349020285,
  "request_id": "relay-1772349020285-123456",
  "group": "3FDdg3kMYutwUiChQ3rQryt2ktQyujtvJvHwU9ypPBMi",
  "execution_queue": "5d9v9RF6EZMA4NXnGPN2ikshTgY4FCcJDoFPkjofRtWa",
  "market": "0",
  "intent_version": 2,
  "target_kind": 0,
  "target_index": 0,
  "accounts_hash": "<32-byte runtime-flag-merged hash, lowercase hex>",
  "remaining_accounts_source": "relayer_derived",
  "sequence": "1274",
  "kind": 0,
  "payload_b64": "AQAAAABP9gMAAAAAAKcBAAAAAAAA/////////39ku+2PkqEAAAEAAAAAAAAAAAAAFA==",
  "remaining_accounts": [
    { "pubkey": "...", "is_signer": false, "is_writable": true }
  ],
  "min_execute_slot": "456363733",
  "expires_at_slot": "0",
  "user_owner": "BvUeT57AWhCjAYfBAQrtuHT24BsBa94uiDhPnVp3kTa7",
  "mango_account": "FGxSs4fio65cKzAwuGhBxwHscXq9JXmEMe33mAKZ33Pt",
  "enqueue_tx_signature": "5qrsaYGu..."
}
```

Under v4, `enqueue_tx_signature` is the `commit_market` tx signature. The
corresponding `reveal_execute_market` tx lands shortly after via the
relayer's internal reveal worker and shows up as a `queue_item_processed`
event on the SSE stream.

#### `relay_intent_status` — lifecycle transitions

```json
{
  "event_type": "relay_intent_status",
  "ts_ms": 1772349020285,
  "request_id": "relay-1772349020285-123456",
  "status_code": 2,
  "status_label": "submitted",
  "reason": null,
  "group": "3FDdg3kMYutwUiChQ3rQryt2ktQyujtvJvHwU9ypPBMi",
  "execution_queue": "5d9v9RF6EZMA4NXnGPN2ikshTgY4FCcJDoFPkjofRtWa",
  "market": "0",
  "intent_version": 2,
  "target_kind": 0,
  "target_index": 0,
  "sequence": "1274",
  "kind": 0,
  "user_owner": "...",
  "mango_account": "...",
  "tx_signature": "5qrsaYGu...",
  "grpc_code": null,
  "queue_process_status": null,
  "queue_process_status_name": null
}
```

`status_code` values:

- `1` accepted (pre-send)
- `2` submitted (tx dispatched to RPC; under v4 this is the commit tx)
- `3` rejected (relayer-side validation failed; `grpc_code` set)

Response `202`:

```json
{
  "ok": true,
  "key": "<group>:<sequence>:<kind>" // for accepted
  // or "<request_id>:<status_code>"   // for status
}
```

Errors:

- `401` unauthorized (when `CONTINUUM_HARNESS_RELAY_INGEST_TOKEN` is set and missing/invalid)
- `500` parse/validation errors

## 3) State Read API

## `GET /state/markets?markets=<id,id>&view=optimistic|confirmed&depth=<n>&book=summary|full`

Returns market cards for one or more markets.

Query params:

- `markets` optional comma-separated subset
- `view` optional (`optimistic` default)
- `depth` optional orderbook summary depth (`10` default)
- `book` optional: `summary` hides full bids/asks, `full` returns the full replayed orderbook in `data`

Response `200`:

```json
{
  "view": "optimistic",
  "items": [
    {
      "market": "0",
      "view": "optimistic",
      "metadata": {
        "market_index": 0,
        "name": "SOL-PERP"
      },
      "data": {
        "market": "0",
        "bids": [],
        "asks": [],
        "open_orders": [],
        "watermarks": {
          "optimistic_seq": "124",
          "confirmed_seq": "120",
          "last_slot": "290123456"
        }
      },
      "orderbook_summary": {
        "depth": 10,
        "bids": [],
        "asks": []
      },
      "trade_summary": {
        "market": "0",
        "view": "optimistic",
        "window_ms": 86400000,
        "trade_count": 0,
        "change_24h_pct": null
      },
      "metrics": {
        "market": "0",
        "oracle_price_ui": 151.23,
        "mark_price_ui": 151.22,
        "funding_rate_daily_pct": 0.01,
        "funding_rate_hourly_pct": 0.0004,
        "open_interest_base_lots": "100000",
        "open_interest_base_ui": 10,
        "best_bid_ui": 151.2,
        "best_ask_ui": 151.24,
        "updated_ts_ms": 1772349020285
      }
    }
  ]
}
```

## `GET /state/markets/:market?view=optimistic|confirmed&depth=<n>`

Returns a single market with the replayed market state plus frontend-oriented summaries and metrics.

Response `200`:

```json
{
  "view": "optimistic",
  "metadata": {
    "market_index": 0,
    "name": "SOL-PERP"
  },
  "orderbook_summary": {
    "depth": 10,
    "bids": [],
    "asks": []
  },
  "trade_summary": {
    "market": "0",
    "view": "optimistic",
    "window_ms": 86400000,
    "trade_count": 0,
    "change_24h_pct": null
  },
  "metrics": {
    "market": "0",
    "oracle_price_ui": 151.23,
    "mark_price_ui": 151.22,
    "funding_rate_daily_pct": 0.01,
    "funding_rate_hourly_pct": 0.0004,
    "open_interest_base_lots": "100000",
    "open_interest_base_ui": 10,
    "best_bid_ui": 151.2,
    "best_ask_ui": 151.24,
    "updated_ts_ms": 1772349020285
  },
  "data": {
    "market": "0",
    "bids": [{ "price_lots": "100", "base_lots": "2" }],
    "asks": [],
    "open_orders": [],
    "watermarks": {
      "optimistic_seq": "124",
      "confirmed_seq": "120",
      "last_slot": "290123456"
    }
  }
}
```

## `GET /state/users/:owner?view=optimistic|confirmed`

Returns user-level projection.

Example response:

```json
{
  "view": "confirmed",
  "data": {
    "owner": "...",
    "mango_accounts": ["..."],
    "open_orders": [],
    "per_market": [
      {
        "market": "0",
        "open_order_base_lots_bid": "0",
        "open_order_base_lots_ask": "0",
        "quote_reserved_lots": "0",
        "base_position_lots": "0",
        "quote_position_native": "0"
      }
    ],
    "margin_summary": {
      "status": "placeholder",
      "source": "queue-replay"
    }
  }
}
```

## `GET /state/balances/:owner?view=optimistic|confirmed`

Returns balance-style user projection for UI consumption.

Response `200`:

```json
{
  "view": "optimistic",
  "data": {
    "owner": "...",
    "mango_accounts": ["..."],
    "per_market": [
      {
        "market": "0",
        "open_order_base_lots_bid": "2",
        "open_order_base_lots_ask": "0",
        "quote_reserved_lots": "200",
        "base_position_lots": "0",
        "quote_position_native": "0"
      }
    ],
    "totals": {
      "total_open_order_base_lots_bid": "2",
      "total_open_order_base_lots_ask": "0",
      "total_quote_reserved_lots": "200"
    },
    "margin_summary": {
      "status": "placeholder",
      "source": "queue-replay"
    },
    "view": "optimistic"
  }
}
```

## `GET /state/orders/:market?owner=<pubkey>&view=optimistic|confirmed`

Returns open orders for a market, optionally filtered by owner.

Query params:

- `owner` optional
- `view` optional (`optimistic` default)

Response `200`:

```json
{
  "view": "optimistic",
  "market": "0",
  "owner": "...",
  "data": [
    {
      "order_id": "...",
      "owner": "...",
      "mango_account": "...",
      "market": "0",
      "side": "ask",
      "price_lots": "101",
      "base_lots": "1",
      "quote_lots": "100",
      "client_order_id": "42",
      "sequence": "125",
      "status": "open"
    }
  ]
}
```

## `GET /state/trades?market=<market>&owner=<owner>&view=optimistic|confirmed&limit=<n>`

Returns recent replayed trades with optional market and owner filters.

Query params:

- `market` optional, omit to stream/query all markets
- `owner` optional owner pubkey filter
- `view` optional (`optimistic` default)
- `limit` optional (`200` default, max `5000`)

Response `200`:

```json
{
  "view": "confirmed",
  "market": "0",
  "owner": "9xQeWvG816bUx9EPjHmaT23yvVMR6YJ7TrwV7K9Zbd5A",
  "data": [
    {
      "trade_id": "...",
      "market": "0",
      "price_lots": "100",
      "base_lots": "1",
      "quote_lots": "100",
      "taker_side": "ask",
      "maker_owner": "...",
      "taker_owner": "...",
      "maker_order_id": "...",
      "taker_sequence": "125",
      "ts_ms": 1772349020285,
      "view": "confirmed"
    }
  ]
}
```

## `GET /state/trades/:market?view=optimistic|confirmed&limit=<n>`

Compatibility alias for the market-scoped trade query.

## `GET /state/trades/summary?market=<market>&owner=<owner>&view=optimistic|confirmed`

Returns a 24h trade summary for one market, or for all markets when `market` is omitted.

Single-market response:

```json
{
  "view": "optimistic",
  "market": "0",
  "owner": null,
  "data": {
    "market": "0",
    "view": "optimistic",
    "window_ms": 86400000,
    "trade_count": 12,
    "last_trade_ts_ms": 1772349020285,
    "last_price_lots": "100",
    "last_price_ui": 151.24,
    "open_price_lots": "99",
    "open_price_ui": 150.75,
    "high_price_lots": "101",
    "high_price_ui": 151.75,
    "low_price_lots": "98",
    "low_price_ui": 149.8,
    "change_24h_pct": 0.324,
    "volume_base_lots": "1000",
    "volume_quote_lots": "151240",
    "volume_base_ui": 10,
    "volume_quote_ui": 1512.4
  }
}
```

## `GET /state/candles/:market?view=optimistic|confirmed&resolution_sec=<seconds>&limit=<n>`

Returns OHLCV candles derived from `trades` endpoint output.

Response `200`:

```json
{
  "view": "confirmed",
  "market": "0",
  "resolution_sec": 60,
  "data": [
    {
      "market": "0",
      "bucket_start_ts_ms": 1772349000000,
      "resolution_sec": 60,
      "open_price_lots": "100",
      "high_price_lots": "101",
      "low_price_lots": "99",
      "close_price_lots": "100",
      "base_volume_lots": "5",
      "quote_volume_lots": "500",
      "trade_count": 3,
      "view": "confirmed"
    }
  ]
}
```

## `GET /state/queue/:market`

Returns queue metrics for a market.

Response `200`:

```json
{
  "market": "0",
  "data": {
    "market": "0",
    "pending_count": 1,
    "processed_count": 40,
    "failed_count": 0,
    "skipped_count": 0,
    "last_processed_sequence": "120",
    "lag_slots": "3",
    "unmatched_processed_count": 0
  }
}
```

## `GET /state/full?view=optimistic|confirmed`

Returns full snapshot.

Response `200` (shape):

```json
{
  "view": "optimistic",
  "markets": { "0": { "...": "..." } },
  "users": { "<owner>": { "...": "..." } },
  "queue": { "0": { "...": "..." } },
  "generated_ts_ms": 1772349020285
}
```

## `GET /state/full?market=<market>&view=optimistic|confirmed`

Market-scoped full view.

Response `200`:

```json
{
  "view": "optimistic",
  "generated_ts_ms": 1772349020285,
  "market": { "...": "..." },
  "queue": { "...": "..." },
  "users": {
    "<owner>": { "...": "..." }
  }
}
```

## 4) SSE Stream

### `GET /state/stream`

Legacy raw harness SSE stream.

Events emitted:

- `connected`
- `relay_intent_accepted`
- `queue_item_enqueued`
- `queue_item_processed`
- `divergence_event`
- `market_state_updated` (initial synthetic update)

### `GET /state/stream/trades?market=<market>&view=optimistic|confirmed&backfill_n=<n>`

Trade SSE stream.

Behavior:

- omitting `market` streams all markets
- initial `snapshot` event returns the last `backfill_n` trades
- subsequent `trade` events emit new replayed trades only

Example:

```text
event: connected
data: {"ts_ms":1772349020285,"mode":"local","view":"optimistic","market":"0"}

event: snapshot
data: {"view":"optimistic","market":"0","data":[...]}

event: trade
data: {"trade_id":"...","market":"0", ...}
```

### `GET /state/stream/frontend?owner=<owner>&mango_account=<account>&market=<market>&include=...`

Frontend-oriented SSE stream for owner and/or market slices.

Behavior:

- requires at least one of `owner`, `mango_account`, or `market`
- emits `snapshot` on connect
- emits `account_update` when the owner slice changes
- emits `market_update` when the market slice changes
- `include` can request any subset of `positions`, `trades`, `open_orders`, `account_metrics`, `market_metrics`, `trade_summary`, `orderbook_summary`, `orderbook`
- `orderbook=full` enables `orderbook` in the market slice

Current limitation:

- `account_metrics` is intentionally stubbed for now:
  `{"status":"stub","source":"pending-subtree",...}`

## Data Models

## `QueueView`

- `optimistic`
- `confirmed`

## `QueueItemProcessed.status`

- `0`: empty
- `1`: pending
- `2`: executed
- `3`: failed
- `4`: skipped

## `kind`

- `0`: CTM wrapped
- `1`: liquidity deposit
- `2`: liquidity withdraw

## Common Errors

Generic error payload from handler exceptions:

```json
{
  "error": "<message>"
}
```

Common statuses:

- `401`: unauthorized (`/ingest/relay-intent` token mismatch)
- `404`: path not found
- `500`: validation/parsing/runtime errors

## TypeScript Client Wrapper

A typed client wrapper is available in:

- `ts/client/src/continuumHarnessClient.ts`

Example:

```ts
import { ContinuumHarnessClient } from '@blockworks-foundation/mango-v4';

const client = new ContinuumHarnessClient('http://127.0.0.1:9091');

const health = await client.healthz();
const market = await client.getMarketState('0', 'optimistic');
const user = await client.getUserState('OWNER_PUBKEY', 'confirmed');
const balances = await client.getBalances('OWNER_PUBKEY', 'optimistic');
const trades = await client.getTrades({
  market: '0',
  view: 'confirmed',
  limit: 200,
});
const candles = await client.getCandles({
  market: '0',
  view: 'confirmed',
  resolutionSec: 60,
  limit: 200,
});
const faucet = await client.airdropUsdc({
  owner: 'OWNER_PUBKEY',
  ui_amount: 250,
});
const unsafeDeposit = await client.airdropDepositUsdc({
  owner: 'OWNER_PUBKEY',
});
const full = await client.getFullState('confirmed');
```

## Verification Utilities (Phase 5)

These scripts are part of the operational API workflow:

- `yarn continuum-state-harness-verify`
  - compares harness view to on-chain Mango perp open orders.
- `yarn continuum-state-harness-replay-check`
  - shuffles captured JSONL events and checks deterministic replay outputs.

## Environment Variables (Harness)

- `CONTINUUM_HARNESS_BIND_ADDR`
- `CONTINUUM_HARNESS_MODE`
- `CONTINUUM_HARNESS_PROGRAM_ID`
- `CONTINUUM_HARNESS_EVENT_LOG_PATH`
- `CONTINUUM_HARNESS_RELAY_INGEST_TOKEN`
- `CONTINUUM_HARNESS_REPLAY_LOG`
- `CONTINUUM_HARNESS_BACKFILL_SIGNATURE_LIMIT`
- `CONTINUUM_HARNESS_COMMITMENT`
- `CONTINUUM_HARNESS_REQUEST_BODY_MAX_BYTES`
- `CONTINUUM_HARNESS_ENABLE_AIRDROP`
- `CONTINUUM_HARNESS_USDC_MINT`
- `CONTINUUM_HARNESS_AIRDROP_KEYPAIR`
- `CONTINUUM_HARNESS_AIRDROP_DEFAULT_UI_AMOUNT`
- `CONTINUUM_HARNESS_AIRDROP_MAX_UI_AMOUNT`
- `CONTINUUM_HARNESS_GROUP_PK`
- `CONTINUUM_HARNESS_AIRDROP_DEPOSIT_UI_AMOUNT`

## Environment Variables (Relayer -> Harness Sink)

- `CTM_RELAYER_EVENT_SINK_URL`
- `CTM_RELAYER_EVENT_SINK_AUTH_TOKEN`

## Curl Quick Reference

```bash
curl -s http://127.0.0.1:9091/healthz | jq
curl -s 'http://127.0.0.1:9091/state/markets/0?view=optimistic' | jq
curl -s 'http://127.0.0.1:9091/state/users/<owner>?view=confirmed' | jq
curl -s 'http://127.0.0.1:9091/state/balances/<owner>?view=optimistic' | jq
curl -s 'http://127.0.0.1:9091/state/orders/0?owner=<owner>&view=optimistic' | jq
curl -s 'http://127.0.0.1:9091/state/trades/0?view=confirmed&limit=200' | jq
curl -s 'http://127.0.0.1:9091/state/candles/0?view=confirmed&resolution_sec=60&limit=200' | jq
curl -s 'http://127.0.0.1:9091/airdrop' \
  -H 'Content-Type: application/json' \
  -d '{"owner":"<owner>","ui_amount":250}' | jq
curl -s 'http://127.0.0.1:9091/airdrop-deposit' \
  -H 'Content-Type: application/json' \
  -d '{"owner":"<owner>"}' | jq
curl -s http://127.0.0.1:9091/state/queue/0 | jq
curl -s 'http://127.0.0.1:9091/state/full?view=confirmed' | jq
curl -N http://127.0.0.1:9091/state/stream
```
