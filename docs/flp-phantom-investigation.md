# FLP Phantom warning investigation — 31 October 2026 (Singapore)

## Finding

Packet size is a credible cause, but Phantom causation is not proven. No Phantom
security instruction or wallet simulation trace was available. The landed transaction
contains only compute budget instructions, InitDepositor, ATA CreateIdempotent and
PermissionedDeposit. A successful landed transaction does not establish what Phantom
attempted during security simulation or why its UI displayed the warning.

Source: SDK main `2e4572e` (PR #1), the public Solana mainnet RPC and
[reported transaction](https://explorer.solana.com/tx/4oFZb1tH2HEWkBCcTM4gbX1m7MZK3mds5thnbxeNVVL4QoMC3zDHTc15QS5Kojvnphct9VXZt2mUKihXRCNMvjth).

| Measurement | Result |
| --- | --- |
| Landed slot | 462938543 |
| Operation | PermissionedDeposit, 10 USDC, minimum 8,322,427 share atoms |
| Format / signatures | legacy / 1 |
| Serialized transaction including signature | 1,196 bytes |
| Space below 1,232-byte packet limit | 36 bytes |
| Accounts / writable accounts | 31 / 12 |
| Top-level instructions | 5 |
| Explicit compute limit | 300,000 CU |
| Historical execution consumption | 138,480 CU |
| Remaining compute budget | 161,520 CU |
| Plain v0, no lookup table | 1,198 bytes (does not solve size) |
| v0 with synthetic full-coverage table | 395 bytes; 837 bytes free |

The 395-byte measurement is an offline encoding experiment, **not a deployed table
or a successful on-chain v0 simulation**. Address lookup tables compress addresses;
they do not reduce the number of runtime accounts. Compute was only 46.16% of the
explicit budget. There is no observed account-count or compute exhaustion.

A hypothetical extra instruction with one new program, one new nonsigner account
and zero data adds 68 bytes, producing 1,264 bytes. Even a new program with no
accounts consumes 35 of the 36 free bytes before instruction data. These are size
sensitivity examples, not a reconstruction of Phantom's private security logic.

## Read-only current-state simulation

The exact landed payload was simulated through `https://api.mainnet-beta.solana.com`
with base64 encoding, `sigVerify:false`, `replaceRecentBlockhash:true`, confirmed
commitment. The result at slot 463399561 was 104,860 CU, 8,040,763 loaded-account
data bytes, and instruction 4 error 6034 (`SlippageExceeded`: fewer shares than the
minimum). The ATA now exists, reducing its cost from 18,226 to 4,356 CU. This replay
uses current balances, NAV, epoch and account existence, not the historical state.
It cannot validate the original wallet simulation or a successful fresh deposit.
The minimum-share constraint was retained. No funds were moved.

Raw evidence is in `test/fixtures/flp-phantom-reported.json` and
`docs/evidence/flp-phantom-current-simulation.json`. Reproduce the offline inspection:

```sh
npm run build
node scripts/inspect-flp-wallet.cjs
```

Retrieve a fresh RPC response using `getTransaction(signature,
{encoding:'base64',maxSupportedTransactionVersion:0})`. Replay using
`simulateTransaction(base64,{encoding:'base64',sigVerify:false,
replaceRecentBlockhash:true,commitment:'confirmed'})`; record its slot and full
error/log output. Do not interpret current-state replay as historical execution.

## Small SDK mitigation

`flpV4.prepareFlpWalletTransaction` is an additive, opt-in pre-sign path. It retains
all instruction bytes, order, account privileges, compute/fee settings and slippage
bounds. Initialization, ATA creation and deposit stay atomic. It selects legacy
when there is space and v0 with supplied active lookup tables when necessary. It
requires explicit wallet v0 support, rejects insufficient headroom before signing,
and simulates the final message with signature verification disabled. RPC failures
and simulation errors stop preparation. It never signs or submits.

The default 128-byte reserve is application policy, **not a known Phantom requirement**.
It can be configured. No reserve guarantees warning-free approval. The existing
instruction builders remain unchanged, so existing clients are not silently affected.
This helper must be integrated into the deployed frontend to change production behavior.
`examples/flp-v4.ts:prepareForWallet` shows fetching configured tables before preparation.

Fetch tables from the correct cluster and wait until extensions are usable. Simulation
catches missing/unusable table entries. Sign the returned transaction promptly without
changing it; if its blockhash expires, rebuild and simulate again. Preserve preflight
on submission and confirm with the returned blockhash and lastValidBlockHeight. A
successful RPC simulation is still not a promise about Phantom's simulation or later
state changes. Do not automatically weaken minShares or skip simulation after failure.

Removing setup is unsafe for first-time users; splitting changes atomicity. Merely
switching to v0 without a table adds bytes. Raising compute limits does not create
packet space and can increase priority fees. No v1 migration is needed for this
mitigation; v1 wallet/codec support would need separate integration qualification.

## Validation and remaining deployment work

93 tests pass (84 existing plus 9 new), including the exact landed fixture, size
sensitivity, v0 instruction/privilege equivalence, separate payer signatures,
unsupported wallets, ineffective/deactivated tables, simulation failures and RPC
failures. Build passes. The compression table in tests is synthetic, never submitted.

The accessible `fermi-pro-frontend` checkout has a generic v0 signing path in
`src/solana/utils/rpc.ts`, but no FLP integration. It is not evidence of the deployed
FLP frontend's signing path. The public SDK itself builds instructions and has a
keypair-driven smoke CLI; it does not invoke Phantom. The deployed frontend commit,
its lookup-table configuration and Phantom provider/version were not established.
No production frontend was changed and no real Phantom approval was exercised.

To complete rollout: identify the deployed FLP frontend, wire this preparation path
before wallet signing, supply a real confirmed mainnet lookup table with sufficient
coverage, then test first/existing-depositor and first/existing-ATA combinations on
the deployed domain. Use freshly quoted amount/minShares and record the exact
pre-wallet bytes, wallet version, signing API and warning. Test wallet cancellation
and blockhash expiry without retrying a possibly submitted deposit blindly.

## Follow-up evidence for Phantom (prepared, not sent)

The original PermissionedDeposit transaction is 1,196 bytes with 31 accounts and
one signature. It used 138,480 of an explicit 300,000 CU budget and succeeded at
slot 462938543. There are only 36 bytes of spare packet capacity. A synthetic added
instruction with one new program and one new account exceeds the packet limit;
this supports your size hypothesis but does not prove the warning's cause.

Please provide the security simulation's error/logs or reason code for this
signature and the added instruction's program IDs, account metas, data length and
compute use (or the transformed serialized message). Was this a transaction-size
failure, simulation failure, domain/reputation flag, or unsupported Token-2022
interpretation? Are the security additions simulation-only? What headroom should
integrators reserve, and are addresses in our lookup tables reused by the security
simulation? These details distinguish a Fermi packet-construction issue from a
Phantom scanner issue.

Attach the raw landed RPC fixture, current-state replay explicitly labeled as such,
and the SDK PR. For a new reproduction also capture the deployed origin, frontend
commit, Phantom version/platform, provider method, original unsigned message,
actual lookup table IDs and contents, simulation slot/logs, exact warning screenshot,
and post-wallet message if signing proceeds. Those wallet-specific fields remain
unavailable in this investigation.
