# Direct orders

`place.ts` uses `execution_queue_v5_enqueue_direct_market` on Solana RPC.
The r9 mainnet direct pools were absent at the 2026-10-23 check.
The CLI rejects the r9 preset. Use `npm run place-order` for mainnet relayed orders.

For a prepared custom deployment, supply the program, group, RPC URL, wallet,
and Fermi account. The direct pool must exist before order submission.
The context also requires a gateway UUID key.

| Variable | Purpose |
| --- | --- |
| `CLUSTER`, `CLUSTER_URL` | Solana cluster and RPC |
| `PROGRAM_ID`, `GROUP_PK` | Explicit deployment identity |
| `USER_KEYPAIR`, `FERMI_ACCOUNT_PK` | Owner wallet and r9-format account |
| `FERMI_API_KEY` | UUID for context construction |
| `DIRECT_ORDER_MARKET_INDEX` | Market index |
| `DIRECT_ORDER_SIDE` | `bid` or `ask` |
| `DIRECT_ORDER_PRICE`, `DIRECT_ORDER_QUANTITY` | UI price and base size |
| `DIRECT_ORDER_TYPE` | `limit`, `ioc`, `postOnly`, `market`, or `postOnlySlide` |
| `DIRECT_ORDER_REDUCE_ONLY` | Boolean |
| `DIRECT_ORDER_EXPIRES_AT_SLOT` | Absolute expiry slot, default current slot + 20 |
| `DIRECT_ORDER_NONCE` | Optional unsigned 64-bit nonce |

A direct intent requires a non-zero expiry on r9.
The high-level helper supplies current slot + 20 by default.
The low-level builder requires the caller to supply the expiry.
A longer expiry can exceed the program's replay window.

The helpers derive the per-market queue and direct-pool PDAs.
`EXECUTION_QUEUE_PK` does not select a v5 market queue.
The direct path does not register a lane through the gateway.

```bash
npm run direct-place-order
```

This command signs and sends an on-chain transaction.
