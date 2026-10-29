# FLP RC6.1 SDK integration review — 30 October 2026 (Singapore)

Reviewed SDK main `18a8d860e841e9a0b312abbd0de55c356b8db1cc` against candidate
`378060fa157db5e8d69c8c3134496b5109712576` (`feat/flp-rc6-1-v4`). The candidate
was one commit ahead, with no changes on main to reconcile. This integration adds
the candidate plus the corrections below. No on-chain program or account changes
are required.

## Corrections found during integration

1. **Valid mainnet RPC rejected:** `MAINNET_SMOKE.genesis` was truncated. Replace
   it with the full `getGenesisHash` response
   `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. A regression independently
   supplies that response, proves it reaches program verification, and rejects
   the truncated value. The old tool could not complete a valid mainnet preflight.
2. **Cached NAV appeared newer than its valuation:** receipt `navObservationSlot`
   incorrectly used the later clock slot. It now uses `lastNav.slot`, with a
   separate `accountReadSlot`. The live read exposed these distinct values:
   NAV slot `462938543`, account-read clock slot `462992569`.
3. **Integration documentation:** clarify that public pre-deposits convert at
   NAV_mid at graduation, while normal deposits price against NAV_high; identify
   the haircut exclusion in the graduation spread guard. Show the observed
   10-USDC minimum in the example, document queued approved-share exits before
   graduation, and distinguish legacy v3 source pins from RC6.1/v4.

## Source, layouts and instruction compatibility

The clean public source snapshot is
[`Fermi-DEX/fermi-v1-programs@623f113`](https://github.com/Fermi-DEX/fermi-v1-programs/tree/623f113075bd124948eabac8589bfbe8c53b11e8/flp).
`python3 scripts/verify-flp-v4.py ../public-programs` passed against that exact
checkout: **47 instructions**, their ordered account privileges and arguments,
**5 account layouts**, **11 types**, **48 events** and **53 errors** agree.
The packaged IDL byte hash is
`022363b3b6b18160c90fc10dc56f8dc2eb3416669ccdf2f5d2021db90e0cf7b7`.
The verifier also confirms the existing r9 core wire schema against the public
snapshot, normalizing only initial account-name capitalization.

Review covered public pre-deposit/refund, approved deposit and slippage bounds,
queued withdrawal/cancellation, funded withdrawal claims, held-deposit refunds,
graduation, account preparation, optional placeholders, funding windows and
recovery sidecars. Native integer share accounting matches source: virtual
assets/shares of 1,000,000, owed and burned-but-locked supply, deposit fee ceiling,
individual claim fee ceiling, batch fee floor and real-supply recovery ratios.

The r9 account client, deployments, core IDL, account creation/deposit/withdrawal
paths, order encoders, relayer, trading and trigger-order implementation files
are unchanged from SDK main. Existing tests retain r9 real-account decoding,
instruction construction, trigger Rust golden hashes/signatures, canonical
account ordering, cancellation, routing and protobuf coverage. `FlpV4Client` is
an explicit opt-in API; `FlpClient`, `FLP_IDL` and `flp` retain the legacy ABI.

## Read-only mainnet verification

The public Solana mainnet RPC was accessible during this review. This supersedes
the candidate's earlier report of HTTP 403 blocking live reads.

`node dist/bin/flp-mainnet-smoke.js --action preflight --owner
C72X2LJ8DbBYawwMcWr7qF9emiRQdbCTZGEpAhjGZQqx --receipt <local-receipt>` passed:

- Correct mainnet genesis, executable loader ownership and ProgramData linkage.
- Complete deployed vault ELF matched 1,776,216 bytes with SHA-256
  `4cd0f7787be53a52195ff21bc34797f3eb40de1810d17443d883f1533f59f36e`.
- Complete deployed r9 core ELF matched 3,777,264 bytes with SHA-256
  `29c6167e1e0eb4577215cf5a85a9646ed36b97c479ace0a71631b7fe71358aa9`.
- Allocation padding was zero for both programs.
- Vault `8aHdjxJzec6CfBngSFZYQvqZsBtXWXG6j1C3rW799pbP` decoded as version 4,
  status 8 (pre-deposit), epoch 3, with the expected group, USDC bank, escrows,
  share mint and core trading account. Core group/authority checks and pricing
  health/event-queue construction succeeded.
- Observed epoch duration 86,400 seconds, cutoff 3,600 seconds, minimum deposit
  10,000,000 native USDC, and zero deposit/withdrawal fees.
- A separate read confirmed Token-2022 non-transferable shares, six decimals and
  the vault PDA mint authority.

The [public account fixture](../test/fixtures/flp-v4-mainnet.json) captures Vault,
RecoveryTargets, FundingWindow, Depositor and EpochRecord in one confirmed
`getMultipleAccounts` response at context slot **462993024**. Tests decode all five
through the v4 client and build public deposit/refund and queued withdrawal/claim
instructions against those real identities. Fixture capture allowed only
`getGenesisHash`, `getAccountInfo` and `getMultipleAccounts` RPC methods.

Preflight itself uses multiple confirmed reads, not one atomic snapshot. NAV is
stored valuation state and can be older than the read. These checks establish
observed binary/layout compatibility; they do not guarantee future eligibility,
keeper liveness, oracle freshness at execution, or successful settlement.

## Validation results

Environment: Node **v24.22.1**, npm **11.9.0**, TypeScript **5.9.3**.
Dependencies were installed from the existing ranges with no dependency changes.

| Check | Result |
| --- | --- |
| Public source/IDL verifier | PASS, including r9 core wire compatibility |
| `npm run validate` | PASS: typecheck, build, **84 tests / 84 passed / 0 failed**, package dry run |
| Build-only `examples/flp-v4.ts` compilation | PASS with strict ES2020/CommonJS TypeScript settings |
| `npm pack` and extracted package imports | PASS: legacy/v4 root APIs, all CLI targets, declarations, three IDLs and trigger protobuf present |
| Extracted package's public-source verifier | PASS; copied v4 IDL preserves its byte hash |
| Read-only mainnet preflight | PASS, including both full binary hashes |
| Actual mainnet account fixture decoding | PASS for all five v4 account types |
| `git diff --check` | PASS |

No private key was loaded. No mainnet simulation, signing, transaction submission,
deposit, withdrawal, order, admin action or keeper action was performed. No fresh
SBF build or validator lifecycle run was performed; deployed binaries were read
and compared with the recorded source-release hashes. The npm package remains
private at version 0.3.0; merging this integration is not an npm publication.
