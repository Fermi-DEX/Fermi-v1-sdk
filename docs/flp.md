# FLP RC6.1 / v4

Use `FlpV4Client` and the `flpV4` namespace for the deployed mainnet vault program.
Builders return instructions and never sign, send, or submit transactions. Existing
`FlpClient`, `FLP_IDL`, and `flp` exports retain the [legacy v3/RC4 API](flp-v3.md).
The r9 core client and trigger-order interfaces are unchanged.

## Deployment and interface pins

| Item | Pin |
| --- | --- |
| Public source | [Fermi-DEX/fermi-v1-programs at 623f113](https://github.com/Fermi-DEX/fermi-v1-programs/tree/623f113075bd124948eabac8589bfbe8c53b11e8/flp) |
| FLP mainnet program | `FLPRrDPN5tJpLx6wY6FUiGFN5Kws8gHUCYMCcs6Goa9Q` |
| r9 mainnet core | `FRMiX94PWHbndvySq8xyRx185GvPeggUeKaLmZgVdd4` |
| Vault / funding-window version | 4 / 1 |
| Recorded deployment slot | 461700429 |
| Recorded ELF SHA-256 | `4cd0f7787be53a52195ff21bc34797f3eb40de1810d17443d883f1533f59f36e` |
| Packaged IDL SHA-256 | `022363b3b6b18160c90fc10dc56f8dc2eb3416669ccdf2f5d2021db90e0cf7b7` |

`FLP_V4_RELEASE` exposes these pins. The IDL metadata names the final mainnet
program, not the shared devnet/baseline address. Constructors still require an
explicit program ID; a vault PDA must come from your chosen deployment.

The public [build evidence](https://github.com/Fermi-DEX/fermi-v1-programs/blob/623f113075bd124948eabac8589bfbe8c53b11e8/flp/build-evidence.json)
records 1,776,216 deployed bytes matching the build, with zero allocation padding.
It records remote verification as pending resubmission. These are snapshot claims,
not a new live-chain attestation or proof of the current upgrade state. Follow the
public build instructions to independently reproduce the ELF. The SDK's source
check verifies all 47 instruction signatures and account privileges, 5 accounts,
11 types, 48 events and 53 errors against that clean pinned checkout:

```sh
python3 scripts/verify-flp-v4.py /path/to/fermi-v1-programs
```

## Read and build

```ts
import { Connection, PublicKey } from '@solana/web3.js';
import { FlpV4Client, FLP_V4_RELEASE } from '@fermilabs/fermi-v1-sdk';

const client = new FlpV4Client(
  new Connection(rpcUrl, 'confirmed'),
  new PublicKey(FLP_V4_RELEASE.vaultProgram),
);
const state = await client.fetchVault(vault);
const instructions = client.preDepositInstructions(vault, state, user, 5_000_000n);
// Submit the entire array atomically through your wallet after checking current state.
```

`fetchVault` rejects v3 accounts, wrong owners, wrong lengths and invalid recovery
sidecars. Initialized v4 vaults require a recovery sidecar even outside recovery;
active recovery also checks its generation. Depositor, epoch and funding-window
readers validate their identities. Separate RPC reads can race a close or recovery
transition; refresh and rebuild when a generation check fails.

Amounts are native integers (`bigint` or Anchor `BN`). USDC uses six decimals;
`5_000_000n` is 5 USDC. Share amounts are native share units. Do not convert large
balances through JavaScript `number`.

## Public and approved user flows

Every `*Instructions` user helper prepares the Depositor PDA in the same transaction.
The initializer is idempotent and does not reset existing balances or tickets. Claim,
refund and share-minting helpers prepare the needed destination ATAs. The payer can
be supplied separately; the caller must supply the transaction's required signatures.

| State / action | Builder |
| --- | --- |
| Public intake before graduation | `preDepositInstructions` |
| Public principal refund before graduation, including closure before graduation | `preWithdrawInstructions` (amount is quote principal) |
| Public shares after graduation | `claimPreDepositInstructions` |
| Public live deposit | `requestDepositInstructions` |
| Approved deposit at current NAV | `permissionedDepositInstructions` with `minShares` |
| Approved share withdrawal before graduation | `permissionedWithdrawInstructions` with `minQuote` |
| Trading share withdrawal in live mode | `requestWithdrawInstructions` |
| Cancel queued deposit / withdrawal | `cancelDepositInstructions` / `cancelWithdrawInstructions` |
| Closed vault's trading shares | `terminalRedeemInstructions` |
| Settle priced deposit or refund held deposit | `settleDepositInstructions` with fetched epoch record |
| Funded withdrawal claim | `claimWithdrawalInstructions` with ticket epoch |

Public escrow principal and approved trading shares are distinct balances, even
when both belong to the same wallet. Never pass a principal amount as shares.
Use the ticket's epoch for claims, not the current vault epoch. The program enforces
phase, approval, minimums, pause flags, cutoff, balance, slippage and FIFO conditions;
constructing an instruction does not certify eligibility or successful execution.

`buildFlpPricingContext(core, client, vault, state)` works with both clients. It checks
the core account's group/authority and quote bank, builds active-position health
accounts and appends event queues. Approved deposit/withdrawal and graduation take
`context.pricingAccounts` plus `context.pricingHealth`. See the
[build-only examples](../examples/flp-v4.ts).

## Shares, NAV and fees

`flpV4.pricingSupply(mintSupply, owedUnmintedShares, lockedShares)` includes burned
withdrawal shares and unclaimed deposit shares. Include newly accrued fee shares
before using a pricing ratio. Supply and NAV must be from a consistent current
valuation; these helpers do not calculate core portfolio NAV or accrue fees.

Normal pricing uses virtual assets and shares of **1,000,000 native units each**:

- Deposit shares: floor(net quote × (supply + 1,000,000) / (NAV_high + 1,000,000)).
- Withdrawal gross: floor(shares × (NAV_low + 1,000,000) / (supply + 1,000,000)).
- Deposit fees round up. Batch funding uses a rounded-down withdrawal fee; individual
  claims round that fee up. Gross payout rounds down in both cases.
- Nonpositive NAV_low gives zero normal withdrawal value. Deposits with positive
  supply require positive NAV_high.
- Recovery uses real NAV_low / real supply without virtual offsets. Use
  `recoveryWithdrawRatio`, not the normal ratio. Terminal claims use the recorded
  terminal assets/supply; do not add virtual offsets to them.

`quoteDeposit`, `depositRatio`, `withdrawRatio`, `recoveryWithdrawRatio`,
`applyRatioFloor`, `priceE12`, `batchPayout` and `claimPayout` implement bounded integer arithmetic.
For already closed epochs use the stored batch ratios and fee rate, not a newly
computed estimate. Off-chain quotes are estimates; enforce `minShares` / `minQuote`
on supported immediate instructions.

## Close, fund and recovery accounts

`closeEpoch` emits `closeEpochV4`, follows the deferred FIFO (default two batches,
maximum eight), validates records and appends writable batch records before health
accounts and event queues. A writable recovery sidecar is last during unwind.
More than two batches can require a larger heap and compute budget. Check the full
prepared transaction's size; use a supported v0 lookup-table strategy when needed.

`fundHead` emits `fundHeadV2` with the funding-window PDA. `fundHeadIfOpen` first
reads that account and checks its vault, version, closed epoch and inclusive chain
time bounds. Pass a chain timestamp, not an untrusted wall-clock estimate. Funding
can still fail when state changes before execution. `sweepIdle` takes a bounded
`maxAmount`; `cureDeferred` uses `cureDeferredV2`.

Remaining accounts are instruction-specific:

| Path | Remaining-account order |
| --- | --- |
| Close | writable deferred FIFO prefix, core health, event queues, writable recovery sidecar if unwinding |
| Fund | core health, event queues, readonly recovery sidecar if unwinding |
| Approved deposit/withdraw, graduation, breaker | core health then event queues |
| Trigger recovery | writable (market, bids, asks) triples in active-position order, writable sidecar |
| Extend partial recovery | core health, event queues, writable sidecar |
| Unwind step / finish | caller-supplied core health then readonly sidecar |

Pass raw `context.health` to close/fund/sweep/cure/extend helpers: they append queues.
Pass `context.pricingHealth` to helpers explicitly taking `healthAndQueues`.
Never append queues twice, sort active slots by market index, or substitute the
all-market trigger-order intent account list for FLP health accounts.

Administration builders include initialization/seeding, capacity expansion,
deposit approval, graduation, status, parameter/recovery timelocks, roles,
two-step admin transfer and delegate management. Recovery builders include full
and partial triggers, bounded steps, partial extensions (5,000–10,000 bps), finish,
abort and foreign-token cleanup. `instruction(name, dotPathAccounts, args, remaining)`
exposes the full pinned IDL. Optional accounts use the FLP program ID as a readonly,
non-signer placeholder. Builders do not authorize administration actions.

## Migration

There is no breaking change to existing SDK exports. Moving an integration to v4
requires `FlpV4Client` / `flpV4`, its current IDL, prepared instruction arrays, and
funding-window/sidecar handling. Do not pass v4 state through the v3 client or use
legacy close/fund instruction discriminators. v4 is a fresh-vault interface, not
an SDK-assisted account migration. Numerical Init-health recovery reason 3 is not
a v4 public trigger: only cash-shortage reason 2 starts that clock.

Harness metadata APIs remain available and separate from authenticated on-chain
account decoding. A successful SDK build or offline test does not certify live
mainnet balances, transaction simulation, remote verification or keeper readiness.

## Opt-in mainnet smoke workflow

The [mainnet smoke guide](flp-mainnet-smoke.md) provides read-only preflight and
simulation by default, with explicit human-operated deposit, withdrawal request
and settled claim stages. It verifies the pinned binaries and records resumable
public receipts. It does not force epoch closure or submit anything on import.
