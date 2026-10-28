# RC6.1/v4 SDK validation and proposed PR

Base: `18a8d860e841e9a0b312abbd0de55c356b8db1cc`, verified after a fresh public
`Fermi-DEX/Fermi-v1-sdk` checkout. Local branch: `feat/flp-rc6-1-v4`.
Public program snapshot: `623f113075bd124948eabac8589bfbe8c53b11e8`.

## Proposed PR

**Title:** Add FLP RC6.1/v4 support and an opt-in mainnet smoke workflow

The public SDK previously exposed the v3/RC4 FLP interface. Add an explicit
`FlpV4Client` / `flpV4` API for the deployed mainnet program, with its current IDL,
account readers, prepared user instructions, funding-window and recovery builders,
integer share/NAV helpers, usage examples and migration guide. Keep the existing
FLP v3 exports, r9 core and trigger-order behavior compatible.

Add an approved-wallet mainnet smoke CLI with read-only preflight/simulation as
the default. Transaction mode requires a user-selected amount/cap, explicit risk
acknowledgement, matching keypair file, fee/rent caps, successful simulation and
verified deployment identities/binaries. Deposit, withdrawal request, settlement
observation and claim are separate invocations. Public receipts preserve the
original signatures before submission and never automatically replace unknown
transactions. No admin, keeper, recovery or public-predeposit transaction mode is
exposed by this runner.

No existing public API is removed. v4 integration requires opting into the new
client and prepared instruction arrays; it is not an account migration. The package
version/private setting and dependency ranges remain unchanged.

## Validation

Environment: Node `v24.19.0`, npm `11.9.0`, TypeScript `5.9.3`.
Dependencies installed from the existing package ranges; no dependency changes.
The environment's default npm cache path was not writable/available. Commands
succeeded with `npm_config_cache=/workspace/.npm` (or `--cache`); no credential or
global configuration changes were made.

| Check | Result |
| --- | --- |
| `python3 scripts/verify-flp-v4.py /path/to/public-snapshot` | PASS: clean source pin, metadata/mainnet ID, exact IDL hash, 47 instructions including ordered accounts/privileges, 5 account layouts, 11 types, 48 events, 53 errors |
| Existing r9 IDL against the same public snapshot | PASS: wire equality after normalizing initial account-name capitalization; existing core IDL unchanged |
| `npm run typecheck` | PASS |
| `npm test` | PASS: 80 tests, zero failures/skips; includes legacy FLP, r9 and trigger-order suites |
| Build-only example compilation with TypeScript | PASS |
| `npm run validate` with writable npm cache | PASS: typecheck, build/tests and package dry run |
| Local `npm pack` and extracted entrypoint smoke check | PASS: new and legacy exports; no transactions or network reads on import |
| Extracted package's public-source verifier | PASS; build preserves pinned IDL bytes rather than TypeScript's reformatted JSON |
| `git diff --check` | PASS |

The tests cover instruction encoding, optional placeholders, FIFO account order,
health/event-queue/sidecar order, malformed account owners/layouts/generations,
public deposit/refund, approved deposit slippage arguments, withdrawal requests,
settled claims and held refunds, admin/recovery builders, virtual offsets,
integer bounds, and distinct batch-floor versus individual-claim-ceil fee rounding.

Smoke tests use offline mocks for whitelist/caps, wrong genesis and binary identity,
receipt replay prevention, persistence-before-send, disk/network failures, unknown
outcomes, original-signature reconciliation, ticket/epoch settlement gates and
full-versus-partial completion. These are construction and control-flow tests, not
proof that a wallet can execute the live lifecycle.

## Unverified and blocked

- Live read-only validation: the attempt to call `getGenesisHash` at
  `https://api.mainnet-beta.solana.com` was **blocked** by the environment proxy:
  `HTTP/1.1 403 Forbidden`, `CONNECT tunnel failed`. No usable RPC response was
  received, and the subsequent vault read was not reached. No alternate route or
  access-control bypass was used. An operator must run preflight through an
  authorized mainnet RPC before deciding whether to execute today.
- No live keypair was loaded; no live simulation, signing, transaction submission,
  deposit, withdrawal request, settlement or claim was performed.
- No validator/SBF integration run or fresh Docker/ELF build was performed. The SDK
  interface was checked against public Rust source; binary equality remains the
  public snapshot's recorded evidence until the CLI checks the live accounts.
- The source snapshot records remote verification as pending resubmission. This
  work does not assert a current explorer verification badge or unchanged upgrade
  state.
- A full lifecycle can span multiple daily epochs or deferred funding. No claim of
  same-day settlement is made. Admin/keeper actions remain outside this harness.

No push, PR creation, package publication, merge, deployment, credential changes or
chain transactions were authorized or performed. The local archive is only a
package-validation artifact, not a published release.
