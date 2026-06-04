# Build And Setup Notes

This SDK is meant to run independently from another machine, but the fastest path to a working environment still depends on the existing Fermi v1 and Fermi v1 build notes already in this workspace.

Rather than duplicating those instructions and letting them drift, keep these source documents nearby during setup:

- Fermi v1 TypeScript and workspace overview:
  - [`../../mng-v4/README.md`](../../mng-v4/README.md)
- Fermi v1 build and platform gotchas:
  - [`../../mng-v4/build-guide.md`](../../mng-v4/build-guide.md)
  - [`../../mng-v4/FAQ-DEV.md`](../../mng-v4/FAQ-DEV.md)
- Fermi v1 state API API reference:
  - [`../../mng-v4/api.md`](../../mng-v4/api.md)
- Professional deployment and service layout:
  - [`../../mng-v4/development.md`](../../mng-v4/development.md)
- Devnet deployment and runtime scripts:
  - [`../../deploy.sh`](../../deploy.sh)
  - [`../../scripts/run_devnet_harness.sh`](../../scripts/run_devnet_harness.sh)
  - [`../../scripts/run_devnet_relayer.sh`](../../scripts/run_devnet_relayer.sh)
  - [`../../scripts/run_devnet_quoter.sh`](../../scripts/run_devnet_quoter.sh)

## Suggested Fast Path

For a clean setup, treat the repo docs above as the source of truth for:

- how to build `fermi-v1-core`,
- how to build or validate the Rust relayer,
- how the harness and relayer ports are expected to be exposed,
- which env vars are already assumed by the running stack.

Then use this SDK only for the remote-client layer:

- connect to Solana RPC,
- connect to relayer gRPC,
- connect to harness HTTP,
- place/cancel quotes,
- read optimistic or confirmed state,
- perform direct Fermi v1 client actions from the same machine.

## Validation

Use the package validation script before handing the SDK to another operator:

```bash
npm install
npm run validate
```

`validate` runs TypeScript type checking, builds `dist/`, and performs an
`npm pack --dry-run` so the packaged files are visible before distribution.
`dist/` is generated locally by the package `prepare` hook and is intentionally
not committed.

## Dependency Audit Notes

`npm audit --omit=dev` currently reports transitive issues inherited through the
published Fermi v1/Solana client stack, mainly `@solana/web3.js` dependencies on
`uuid` plus `@solana/spl-token` / `@solana/buffer-layout-utils` dependencies on
`bigint-buffer`. As of this SDK update, the latest compatible
`@solana/web3.js` and `bigint-buffer` package versions still trigger the audit,
and npm's suggested forced fix would replace `@fermilabs/fermi-v1-sdk`
with an incompatible package version.

Do not run `npm audit fix --force` for this SDK without revalidating all Fermi v1
client behavior. Run the SDK as a trading-key process: keep the host isolated,
avoid exposing it to untrusted HTTP/gRPC inputs beyond the intended relayer and
harness endpoints, and revisit the audit once upstream Solana/Fermi v1 packages
ship patched dependency ranges.

## Why This Matters

The expensive setup time is still mostly in the upstream `fermi-v1-core` and relayer build path. Keeping the current docs intact and linked here avoids re-discovering known fixes like:

- Rust or Solana version mismatches,
- stale or unusable `mango_v4.so` artifacts,
- relayer build hangs or release/debug binary confusion,
- service port and runtime-env mismatches between harness, relayer, and clients.
