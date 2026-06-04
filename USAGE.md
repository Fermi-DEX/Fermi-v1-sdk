# Fermi v1 SDK — Usage Guide

A walkthrough for someone connecting a fresh wallet to a running Fermi v1
deployment (relayer + harness + Fermi v1 program). The README covers the
high-level surface and library API; this guide covers the operational
sequence — what to run, in what order, and how to verify each step before
moving on.

If anything below fails, run `npm run smoke-check` first to confirm RPC,
harness, and relayer reachability before debugging higher-level code.

---

## 1. Install and configure

```bash
npm install                 # also runs `npm run build` via `prepare`
cp .env.example .env
```

Required for **everything**:

| var            | example                                  |
|----------------|------------------------------------------|
| `CLUSTER`      | `devnet`                                 |
| `CLUSTER_URL`  | `https://api.devnet.solana.com`          |
| `USER_KEYPAIR` | absolute path to a Solana keypair JSON   |
| `GROUP_PK`     | Fermi v1 group public key                   |

Required for **relayer/harness** flows:

| var               | example                                         |
|-------------------|-------------------------------------------------|
| `HARNESS_URL`     | `http://harness-host:9191`                      |
| `RELAYER_ADDR`    | `relayer-host:9190`                             |
| `FEE_HTTP_URL`    | `http://relayer-host:9193`                      |
| `FERMI_ACCOUNT_PK`| pubkey of the account you'll trade with         |

If you don't have a Fermi v1 account yet, skip ahead to
[3. Bootstrap a Fermi v1 account](#3-bootstrap-a-mango-account) before doing
anything else.

---

## 2. Smoke check

Verify each external dependency is reachable before troubleshooting deeper.

```bash
npm run smoke-check
```

Output looks like:

```
fermi-v1 smoke-check
---------------------
PASS  rpc           187ms     slot=308542193
PASS  harness        24ms     mode=devnet backend=rust-backend markets=3 users=26
PASS  relayer        61ms     reachable (server replied: ...)
PASS  fees-http      31ms     deposit=Bv... balance=0
```

- `PASS` on `rpc` is mandatory (everything else needs the chain).
- `SKIP` means the corresponding env var isn't set — fine if you genuinely
  don't need that surface.
- `FAIL` on `relayer` is usually a wrong port, a firewall, or the binary not
  running. The mainnet smoke relayer's gRPC default is `:9190`.

Read the harness-published transaction-construction config:

```bash
npm run config
```

This calls `GET /config` by default. Set `CONFIG_SOURCE=bootstrap` to call the
alias `GET /state/bootstrap`.

---

## 3. Bootstrap a Fermi v1 account

For a brand-new wallet, create the account and fund it:

```bash
npm run create-fermi-account     # prints the created FERMI_ACCOUNT_PK
npm run deposit-usdc             # deposits USDC_AMOUNT_UI from your ATA
npm run withdraw-usdc            # withdraws USDC_AMOUNT_UI back to your ATA
```

The create script honors `FERMI_ACCOUNT_NUM` and `FERMI_ACCOUNT_NAME` so you
can run it multiple times for sub-accounts. The deposit and withdraw scripts
read `USDC_AMOUNT_UI` and `USDC_MINT` (or fall back to the group's perp settle
mint).

Quick portfolio readout:

```bash
OWNER=<your-wallet-pubkey> npm run portfolio
```

Backup on-chain readout:

```bash
npm run onchain-portfolio
```

Sample output:

```
portfolio for 3Ynr...788J  (view=optimistic)

fermi_accounts: 82Td...1hem

margin
------
  equity         $4,624.36
  init_health    $4,009.90    (100.00%)
  maint_health   $4,317.16    (100.00%)

per_market
----------
  market           base_pos     quote_pos      bids        asks
  SOL-PERP                0             0           0           0
```

`init_health_ratio` of 100% means you're fully unhealthy-margin-distance from
liquidation — the highest the harness reports for an account with no open
positions.

---

## 4. Simulate a trade (no RPC, sub-millisecond)

The harness exposes `/simulate` for projecting a proposed perp order onto
**optimistic** state — your existing positions, accepted intents, observed
fills, and others' fills against your resting orders. It is cache-only on the
hot path; first call to a fresh harness pays one RPC (~200–400 ms) to load
the Fermi v1 account, then every subsequent call against the same owner is pure
local math (~2–10 ms) until the 15 s cache TTL expires.

The packaged script wraps both calls:

```bash
SIMULATE_OWNER=<wallet-pubkey> \
SIMULATE_MARKET=SOL-PERP \
SIMULATE_SIDE=buy \
SIMULATE_QUANTITY=10 \
npm run simulate
```

Output:

```
warm: owner=3Ynr...788J accounts=1 load=401ms ttl=15000ms

trade: BUY 10 SOL-PERP @ $85.11 (oracle, limit)
account: 82Td...1hem
freshness: cached_age=17ms snapshot_age=4ms overlay=false compute=8ms

              before              after               delta
equity              $4,624.36           $4,624.36           +$0.00
init_health         $4,009.90           $3,839.69         -$170.21
maint_health        $4,317.16           $4,232.06          -$85.10
init_ratio              100.00%             95.75%
maint_ratio             100.00%             97.83%

OK — trade fits available margin
```

Push the quantity past available margin and rejection fires:

```bash
SIMULATE_QUANTITY=500 npm run simulate
# … REJECT — reasons: insufficient_init_margin
```

### Programmatic use

For a real UI, call `simulateWarm()` once when the user opens a trade modal,
then call `simulate()` on every keystroke. Don't call warm in a tight loop;
warm is RPC-bound, simulate is not.

```ts
import { FermiV1StateClient } from '@fermilabs/fermi-v1-sdk';

const harness = new FermiV1StateClient(process.env.HARNESS_URL!);

// Once on modal open:
await harness.simulateWarm({ owner });

// On every quantity-input change:
const result = await harness.simulate({
  owner,
  trade: {
    market: 'SOL-PERP',
    side: 'buy',
    quantity: parseFloat(quantityField.value),
    price: null,            // null = use oracle price
    order_type: 'limit',
    reduce_only: false,
  },
});

if (result.would_reject) {
  showError(result.reject_reasons.join(', '));
} else {
  setMargin({
    before: result.before.init_health_ui_quote,
    after: result.after.init_health_ui_quote,
  });
}
```

### Cache-miss errors

If you see `HTTP 425 cache_miss`, you skipped the warm step or the cache
expired. Either:

- POST `/simulate/warm` first (the script does this for you), or
- Hit `/state/users/<owner>` first — the harness primes the simulate cache
  as a side-effect of every `/state/*` query for that owner.

---

## 5. Place and cancel a perp order

Two paths:

**Via the relayer (recommended for production-style flow):**

CLI:

```bash
PERP_ORDER_MARKET_INDEX=0 \
PERP_ORDER_SIDE=bid \
PERP_ORDER_PRICE=100 \
PERP_ORDER_QUANTITY=0.01 \
npm run place-order
```

Programmatic:

```ts
import {
  FermiV1RelayerClient,
  PerpOrderSide,
  createFermiV1Context,
  submitPerpOrderViaRelayer,
  cancelPerpOrderByClientIdViaRelayer,
} from '@fermilabs/fermi-v1-sdk';

const context = await createFermiV1Context({
  cluster: 'devnet',
  clusterUrl: process.env.CLUSTER_URL!,
  userKeypair: process.env.USER_KEYPAIR!,
  groupPk: process.env.GROUP_PK!,
  fermiAccountPk: process.env.FERMI_ACCOUNT_PK!,
});
const relayer = new FermiV1RelayerClient(process.env.RELAYER_ADDR!);

const clientOrderId = Date.now();
await submitPerpOrderViaRelayer(relayer, context, {
  marketIndex: 0,
  side: PerpOrderSide.bid,
  price: 100,
  quantity: 0.01,
  clientOrderId,
  maxFeeLamports: 'AUTO',
});

await cancelPerpOrderByClientIdViaRelayer(relayer, context, {
  marketIndex: 0,
  clientOrderId,
  maxFeeLamports: 'AUTO',
});
```

**Via direct on-chain enqueue (skips relayer):**

```bash
DIRECT_ORDER_MARKET_INDEX=0 \
DIRECT_ORDER_SIDE=bid \
DIRECT_ORDER_PRICE=100 \
DIRECT_ORDER_QUANTITY=0.01 \
npm run direct-place-order
```

The relayer path uses the v5 user-intent envelope (`fermi-v1-user-intent-v2`)
and goes through the FIFO queue. The direct path uses
`execution_queue_v5_enqueue_direct_market` and bypasses the CTM signer, which
is why it requires more env vars and the executor must be running to
eventually drain it.

For a copy-paste end-to-end demo see
[`examples/direct-v5-smoketest.ts`](./examples/direct-v5-smoketest.ts).

---

## 6. Fees and gas

The relayer maintains a per-wallet SOL fee ledger separate from your main
wallet balance. Every relayed intent debits this ledger; if it runs dry the
relayer rejects with `please deposit gas`.

Top up flow:

1. Read `deposit_address` from `/fees/status` (or `npm run smoke-check` with
   `USER_OWNER_PK` set).
2. Send SOL to that address with the canonical memo
   `fee_credit:v1:<owner>:<fermi_account>`.
3. Call `POST /fees-deposited` to credit the ledger.

The SDK exposes `buildFeeDepositInstructions()` and `depositFeeCredit()` to
do all three steps in one call:

```ts
import { depositFeeCredit } from '@fermilabs/fermi-v1-sdk';

await depositFeeCredit({
  connection: context.connection,
  payer: context.user,
  userOwner: context.user.publicKey,
  fermiAccount: context.fermiAccount.publicKey,
  feeHttpUrl: process.env.FEE_HTTP_URL!,
  lamports: 100_000_000,   // 0.1 SOL
});
```

Most flows can leave `maxFeeLamports: 'AUTO'` and let the relayer pick.

See [`fee_system.md`](./fee_system.md) for the canonical reference and
[`docs/fee-path-end-to-end.md`](./docs/fee-path-end-to-end.md) for a worked
sequence.

---

## 7. Run a quoter bot

Minimal market-making bot that quotes around CoinGecko spot:

```bash
BOT_SIDE=bid BOT_SPREAD_BPS=20 BOT_SIZE=0.01 BOT_INTERVAL_MS=2000 \
  npm exec fermi-v1-quoter
```

The bundled bot is intentionally minimal — production setups should fork it
and add their own funding logic, kill switches, and per-market parameters.

---

## Troubleshooting

| Symptom                                | First thing to check                                   |
|----------------------------------------|--------------------------------------------------------|
| `HTTP 425 cache_miss` on /simulate     | `POST /simulate/warm` first (or hit `/state/users/<owner>`) |
| `please deposit gas` from relayer      | top up via `depositFeeCredit()` (section 6)            |
| `Custom(6126) LegacyQueuesDisabled`    | relayer was built without v5 routing — rebuild from current source |
| `AccountOwnedByWrongProgram`           | program id in source `declare_id!` doesn't match deployed |
| `dispatch failed` with no fill         | check `/trace/sequence/<market>/<seq>` on the harness  |
| `would_reject: insufficient_init_margin` (when expected to fit) | `cached_age_ms` may be > 15s — re-warm; check `optimistic_overlay_applied` |

Always start with `npm run smoke-check` when something doesn't work.
