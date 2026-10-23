# Trigger orders: stop loss and take profit

The SDK builds signed SL/TP legs for the existing trigger keeper.
Each leg is a bounded, reduce-only IOC order. The keeper holds it until the
on-chain oracle meets its trigger. No core-program upgrade is required.

The keeper and gateway routes must be enabled by the operator.
The SDK does not start or configure those services.

## Build and submit a bracket

```ts
import {
  createFermiV1Context,
  FermiV1TriggerClient,
  prepareSlTpOrdersUi,
  signTriggerOrderLeg,
  triggerCancelIsFinal,
} from '@fermilabs/fermi-v1-sdk';

const context = await createFermiV1Context({
  deployment: 'fermi-r9-mainnet',
  clusterUrl: process.env.CLUSTER_URL,
  apiKey: process.env.FERMI_API_KEY!,
  userKeypair: process.env.USER_KEYPAIR!,
  fermiAccountPk: process.env.FERMI_ACCOUNT_PK!,
});
const triggers = new FermiV1TriggerClient({
  gatewayUrl: context.gatewayUrl!,
  apiKey: context.apiKey,
});
const legs = await prepareSlTpOrdersUi(context, {
  marketIndex: 0,
  position: 'long',
  size: 'all',
  stopLossPrice: 90,
  takeProfitPrice: 120,
  slippageBps: 50,
  expiryTs: BigInt(Math.floor(Date.now() / 1000) + 86400),
});

// Each call submits one real trigger leg. Replace the example prices first.
const accepted = [];
for (const leg of legs) {
  const signature = signTriggerOrderLeg(leg, context.user.secretKey);
  const result = await triggers.submitTriggerOrder(leg, signature, 'AUTO');
  accepted.push(result.trigger_order_id);
  console.log(result.trigger_order_id, result.trigger_order_status);
}
```

Prices and size use UI units in `prepareSlTpOrdersUi`.
The helper converts them to market lots and builds the canonical account list.
A size of `'all'` uses the maximum signed base-lot cap. Reduce-only limits the
actual fill to the position size at execution.

The example prices are illustrative. The helper rejects a trigger that the
loaded oracle price already meets. The keeper also checks the current oracle at intake.
Its default expiry range is 60 seconds to 30 days. `expiryTs` uses Unix seconds.

Submission is separate for each leg. If the second call fails, the first leg
can remain active. Read status before a retry. The SDK does not retry or convert
a trigger into an immediate order.

## Units and signed terms

| API | Inputs |
| --- | --- |
| `prepareSlTpOrdersUi` | Context, UI prices, UI base size or `'all'` |
| `prepareSlTpOrders` | Context, price lots, base lots or `'all'` |
| `buildSlTpLegs` | Explicit group, queue, account, signer and canonical account list |
| `buildTriggerOrderLeg` | One leg with optional explicit salt, OCO group and IOC limit |
| `triggerTermsBytes`, `triggerTermsCommitment` | Exact keeper terms encoding and commitment |
| `triggerOrderRequest` | Signed leg as a gRPC request |
| `triggerOrderSubmitBody` | Signed leg as an HTTP request |

Native integer inputs use `bigint`. Slippage uses integer basis points from
0 to 9,999. Long positions close with asks. Short positions close with bids.
The IOC limit rounds down for asks and up for bids.

The terms commitment becomes `client_order_id` in both the payload and intent.
The signature binds trigger price, direction, expiry, OCO group and salt through this commitment.
Envelope timing remains zero. The finite expiry is in the order payload.
The trigger request always uses `intent_version: 3` and `trigger_order`.

For an external wallet, sign `leg.intentHash` with `signMessage`.
Pass the returned 64-byte signature to `submitTriggerOrder`.
The client also accepts signatures over the lowercase hex representation of the hash.
The signer must match the owner or authorized delegate in the context.

Existing gRPC clients can call:

```ts
const result = await submitTriggerOrderViaRelayer(relayer, leg, signature, 'AUTO');
```

This helper requires the updated protobuf with trigger field 17.
The SDK rejects a trigger request with an immediate-order routing marker.
A successful hand-off returns a trigger ID and `pending` or `armed` status.
It does not return an executed trade.

## Read status

```ts
const list = await triggers.getTriggerOrders({
  fermiAccount: context.fermiAccount.publicKey,
  activeOnly: true,
  marketIndex: 0,
  limit: 100,
});
const detail = await triggers.getTriggerOrder(accepted[0]);
console.log(detail.order.state, detail.order.wait_reason, detail.history);
```

The list can also filter by owner, client order ID or OCO group.
Read responses exclude stored payloads, signatures and canonical account lists.
The SDK keeps the transport name `mango_account` for compatibility.

| State or flag | Meaning |
| --- | --- |
| `pending` | No reducing position yet |
| `armed` | Position exists and the keeper watches the oracle |
| `firing` | A fire attempt is in progress |
| `awaiting_outcome` | The attempt reached the relayer and needs reconciliation |
| `filled` | The keeper observed a position reduction |
| `cancelled`, `expired`, `failed` | Terminal states |
| `fire_unknown` | Uncertain outcome. The keeper does not fire again automatically |
| `resign_required` | Refresh the account list, cancel the old leg and sign a replacement |

The keeper cancels OCO siblings after a fill, not after acceptance alone.
An unfilled IOC can re-arm. On-chain oracle freshness and keeper availability
control trigger latency. The trigger condition itself is enforced by the keeper
and relayer registry. The on-chain order enforces reduce-only, expiry and the IOC limit.

## Cancel legs

```ts
const cancelled = await triggers.cancelForContext(context, {
  scope: 'oco_group',
  ocoGroup: legs[0].terms.ocoGroup,
  marketIndex: 0,
});
console.log(triggerCancelIsFinal(cancelled), cancelled.results);
```

Scopes are `ids`, `oco_group`, and `all`.
The `ids` scope takes `clientOrderIds`, not keeper trigger IDs.
The `oco_group` scope requires a non-zero group.
The optional market index restricts the cancellation.

A `cancel_pending` result is not final. An in-flight attempt can still fill.
Poll status until the outcome is terminal. `not_found` is distinct from `cancelled`.
External wallets can use `triggerCancelMessageHash`, sign the hash, and call
`cancelTriggerOrders`. `issuedAtMs` uses Unix milliseconds.

Source contract: `fermi-v1` commit `7afba98770b6bae99d839c296f3c7fd4750ab18c`.
Regression tests use the keeper and relayer Rust fixtures.
