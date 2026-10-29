# Opt-in mainnet FLP smoke test

This CLI exercises the approved-wallet lifecycle against the pinned RC6.1/v4
mainnet vault. It defaults to **read-only preflight**. Selecting an action without
`--transact` builds and simulates it without loading a private key or sending it.
Only the human operator should invoke transaction mode.

Read-only mainnet preflight passed during the 30 October 2026 (Singapore) SDK
integration review, including the pinned vault/core binary hashes and account
decoding. See the [validation record](flp-v4-validation.md). No private key was
loaded and no transaction was signed, simulated or submitted during that review.
Rerun preflight for current deployment state and wallet eligibility.

## Scope and risks

- Deposited USDC becomes trading capital and can lose value. Deposit/withdrawal
  fees, SOL transaction fees and account rent apply. A round trip need not return
  the original amount. The runner does not select an investment amount.
- Use a wallet approved by the vault administrator. The CLI cannot whitelist it,
  change roles, remove pauses, graduate the vault, close epochs, fund withdrawals,
  invoke recovery or force settlement. Approval is checked for deposits; exits
  use the protocol's withdrawal rules even if approval has since been revoked.
- Treat this as a daily-epoch workflow. Preflight reports actual on-chain duration,
  cutoff and scheduled timing. A request at or after cutoff targets the next epoch.
  An independent keeper must close and fund the ticket. Insufficient liquidity or
  recovery can defer it further. A complete lifecycle may not finish today.
- The CLI uses approved immediate deposits. Public predeposit principal is a
  different balance and is **not** exercised by this runner. Explicit public
  deposit/refund builders are shown in [flp-v4.ts](../examples/flp-v4.ts); only use
  them after checking the vault phase. Do not substitute them for approved capital.
- One receipt tracks one deposit, one withdrawal request, and one claim. Keep it
  until reconciliation completes. Do not delete it or create another receipt to
  retry an uncertain action. Other activity in the same wallet can change balances;
  a dedicated approved smoke wallet is easiest to audit.

## Setup and read-only preflight

From the SDK checkout:

```sh
npm install
npm run build
export SOLANA_RPC_URL='https://YOUR_MAINNET_RPC'
export SMOKE_OWNER='YOUR_APPROVED_PUBLIC_KEY'
export SMOKE_RECEIPT='.flp-smoke/rc6-mainnet.json'

node dist/bin/flp-mainnet-smoke.js \
  --owner "$SMOKE_OWNER" --receipt "$SMOKE_RECEIPT"
```

Use an HTTPS RPC that permits full ProgramData reads and transaction history.

The receipt separates `summary.navObservationSlot` (the stored NAV's valuation
slot) from `summary.accountReadSlot` (the later clock read). Reading an account
does not refresh its cached NAV. Preflight uses several confirmed RPC reads,
which are not an atomic portfolio snapshot.
Credentials may be supplied through `SOLANA_RPC_URL`; they are never written to
receipts. No keypair is needed or accepted for read-only actions. Do not put a
keypair JSON array on the command line. A transaction-mode keypair must be a local
Solana keypair **file**, whose public key matches `--owner`.

Preflight checks mainnet genesis, the exact FLP and core program IDs, upgradeable
loader/ProgramData identities, both pinned ELF hashes and zero allocation padding,
vault version and PDA, core account/authority/group, USDC mint/bank/bank vault,
share mint and recovery sidecar. It records approval, balances, native minimums,
fees, NAV observation, epoch timing and any withdrawal record. A program upgrade
or identity mismatch fails closed; there is no skip-verification flag.

Pinned target:

| Account | Address |
| --- | --- |
| FLP program | `FLPRrDPN5tJpLx6wY6FUiGFN5Kws8gHUCYMCcs6Goa9Q` |
| Vault (ID 1) | `8aHdjxJzec6CfBngSFZYQvqZsBtXWXG6j1C3rW799pbP` |
| Core | `FRMiX94PWHbndvySq8xyRx185GvPeggUeKaLmZgVdd4` |
| Group | `2mDvxS4A6bJyR3RjLwvBWeNuFvCAaQ26ss7w1jUChRse` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

See [source and build pins](flp.md). Mainnet and shared devnet program IDs are not
interchangeable. Core account, escrows and share mint are derived and checked.

## Stage 1: approved deposit

Choose positive **native integer** values: USDC has six decimals, and shares use
native share units. These variables deliberately have no default spending amounts.
`SMOKE_AMOUNT` must not exceed `SMOKE_CAP`. Choose `SMOKE_MIN_SHARES` as your price
protection. If the wallet already holds shares, that floor must cover the current
withdrawal minimum so the new shares can be requested without touching old ones.

```sh
node dist/bin/flp-mainnet-smoke.js --action deposit \
  --owner "$SMOKE_OWNER" --receipt "$SMOKE_RECEIPT" \
  --amount-native "$SMOKE_AMOUNT" --cap-native "$SMOKE_CAP" \
  --min-shares "$SMOKE_MIN_SHARES"
```

This is read-only simulation. If the transaction exceeds 1,232 bytes, supply
`--lookup-table "$SMOKE_ALT"` with an appropriate public mainnet lookup table.
The CLI verifies its owner and active state. It does not create, extend or trust
an ALT as a deployment registry. Without sufficient table coverage it stops.

To authorize this **one** deposit yourself, rerun the command with:

```sh
--transact --acknowledge-risk --keypair "$SMOKE_KEYPAIR_FILE" \
--max-fee-lamports "$SMOKE_MAX_FEE" --max-sol-lamports "$SMOKE_MAX_SOL"
```

Both SOL values are positive native lamport caps. The network fee estimate must
fit the fee cap. A conservative simulated payer debit including fee/rent must fit
the SOL cap. These are pre-signing checks, not on-chain spending-limit accounts.
The instructions use no priority fee; congestion may cause expiration. A successful
simulation is not a promise of execution at the same price. `minShares` is enforced
on chain. Every gate and simulation runs before the CLI loads the keypair.

The CLI records the signed transaction's original signature durably **before** the
first send. It sends once with RPC retries disabled, then reads its status once.
It does not automatically request a withdrawal or claim afterward.

## Stage 2: observe and request withdrawal

```sh
node dist/bin/flp-mainnet-smoke.js --action status \
  --owner "$SMOKE_OWNER" --receipt "$SMOKE_RECEIPT"
```

This reads the original signatures with history search. Receipt fields include
Solscan links, confirmation state, actual `FlpPermissionedDeposit` minted shares,
transaction token balances, and labeled NAV/account observations. NAV observations
can be later than the transaction; they are not an execution-price attestation.

Wait for confirmed/finalized deposit evidence. Choose `SMOKE_SHARES` no greater
than `summary.observedMintedShares`, with a positive `SMOKE_SHARE_CAP` at least that
amount. For a complete round trip choose all the minted shares. A partial request
leaves the remaining shares exposed and the report identifies that remainder.
Existing withdrawal tickets are rejected to avoid merging financial actions.

```sh
node dist/bin/flp-mainnet-smoke.js --action request-withdraw \
  --owner "$SMOKE_OWNER" --receipt "$SMOKE_RECEIPT" \
  --amount-native "$SMOKE_SHARES" --cap-native "$SMOKE_SHARE_CAP"
```

Inspect the reported target epoch/cutoff. To submit, add the same explicit
transaction/keypair/fee/rent flags as Stage 1. This burns the requested shares into
a withdrawal ticket. It does not pay USDC immediately. It has no minimum-payout
argument; price and fees at settlement govern the payout.

## Stage 3: wait, read settlement, then claim

Repeat `--action status` when useful. There is no forced close, background keeper,
polling loop, or synchronous lifecycle shortcut. The original withdrawal event
binds the ticket's request ID, epoch and shares. The current ticket must match it.

`lastPreflight.epochRecord.wdStatus` must be `1` (settled), and the receipt reports
`settledClaimEstimate` using the stored ratio. A missing/open record or `2`
(deferred) is **not claimable**. Individual claims round withdrawal fees up, while
batch funding rounds them down; the SDK uses claim-specific arithmetic here.

```sh
node dist/bin/flp-mainnet-smoke.js --action claim \
  --owner "$SMOKE_OWNER" --receipt "$SMOKE_RECEIPT"
```

The command first builds and simulates the claim. To submit, add the explicit
transaction/keypair/fee/rent flags. It only claims the exact recorded ticket to
the owner's canonical USDC ATA. Run `status` afterward until confirmed/finalized
claim evidence is available.

Success criteria:

- Deposit: confirmed original signature, matching vault/user event and minted shares.
- Request: confirmed original signature, matching request ID/epoch/share amount.
- Settlement: actual settled on-chain epoch, not merely elapsed wall-clock time.
- Claim: matching `FlpClaimed` event (`kind = 1`) and amount/epoch/request ID.
- Full round trip: `summary.fullLifecycleComplete` is true. A partial exit only
  sets `partialClaimComplete`; the report gives the unwithdrawn smoke shares.

## Receipts and uncertain outcomes

Receipts are machine-readable JSON containing public addresses, signatures,
Solscan URLs, amounts/caps, blockhash validity, status, parsed events and balance/NAV
observations. They contain no keys, RPC URLs, authentication tokens or raw logs.
The default `.flp-smoke/` directory is ignored by Git. Store custom receipts outside
tracked paths and review them before sharing.

A timeout, null history result, processed-only status or missing transaction stays
`unknown`. Even an expired blockhash does not cause an automatic replacement.
An already recorded action cannot be submitted again from the same receipt.
A failed action stops the run; inspect the original transaction before deliberately
starting a separate test. Do not interpret a null RPC response as proof of failure.

The receipt uses an exclusive `.lock` and atomic/fsynced writes. After a process
crash, first establish that no other runner is active. Inspect the receipt and
original signature before manually removing a stale lock. Do not remove a `.tmp`
or lock file just to bypass an unresolved transaction. A `prepared` record without
a signature requires manual review; the runner does not guess whether to retry.

RPC/state reads are not atomic and endpoints can lag. The chain rechecks account,
phase, balance, slippage and settlement conditions at execution. Use an RPC you
trust. Program upgrades require a reviewed SDK pin update before this runner can
proceed, including for receipt reconciliation; Solscan remains available for manual
inspection of the stored public signatures.
