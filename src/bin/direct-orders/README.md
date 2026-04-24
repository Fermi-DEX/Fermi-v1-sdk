# Direct Orders

This folder contains runnable direct-enqueue order scripts built on top of the
SDK's v5 direct market path.

Current entrypoint:

- `place.ts`: submit a perp order directly on-chain via
  `execution_queue_v5_enqueue_direct_market`

Required base env:

- `CLUSTER`
- `CLUSTER_URL`
- `USER_KEYPAIR`
- `GROUP_PK`
- `MANGO_ACCOUNT_PK`
- `EXECUTION_QUEUE_PK`

Optional:

- `HARNESS_URL` for lane registration and local optimistic tracking
- `PROGRAM_ID` to override the Mango program id

Place-order env:

- `DIRECT_ORDER_MARKET_INDEX` or `PERP_MARKET_INDEX`
- `DIRECT_ORDER_SIDE=bid|ask`
- `DIRECT_ORDER_PRICE=<ui price>`
- `DIRECT_ORDER_QUANTITY=<ui base size>`
- `DIRECT_ORDER_MAX_QUOTE_QUANTITY=<optional ui quote cap>`
- `DIRECT_ORDER_CLIENT_ORDER_ID=<optional u64>`
- `DIRECT_ORDER_TYPE=limit|ioc|postOnly|market|postOnlySlide`
- `DIRECT_ORDER_SELF_TRADE_BEHAVIOR=decrementTake|cancelProvide|abortTransaction`
- `DIRECT_ORDER_REDUCE_ONLY=true|false`
- `DIRECT_ORDER_EXPIRY_TIMESTAMP=<unix seconds>`
- `DIRECT_ORDER_MATCH_LIMIT=<u8>`
- `DIRECT_ORDER_EXPIRES_AT_SLOT=<optional slot>`
- `DIRECT_ORDER_NONCE=<optional u64>`

Run with:

```bash
npm run direct-place-order
```

or

```bash
npx continuum-direct-place-order
```
