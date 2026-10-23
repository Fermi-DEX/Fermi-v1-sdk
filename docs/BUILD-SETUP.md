# Build and package

This repository builds independently. It needs Node.js 22 or later and npm.
It does not need Rust, Anchor CLI, a validator, or a sibling `fermi-v1` checkout.

## Install

```bash
npm install
npm run validate
```

The `prepare` hook builds `dist/`. The repository does not commit this directory.
The package pins Mango account models to `0.33.9` and Anchor to `0.29.0`.
The SDK constructs its own Anchor program with the bundled r9 IDL.

## Checks

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Check TypeScript without output files |
| `npm run build` | Generate JavaScript, declarations, and the bundled IDL |
| `npm test` | Build and run offline r9 regression tests |
| `npm run validate` | Check types, run tests, and inspect package contents |
| `npm pack` | Create an installable package archive |

The tests decode public mainnet snapshots and construct transactions offline.
They cover r9 account identity, PDA derivation, filters, creation, margin
instructions, event names, deployment mismatches, and direct-intent expiry.
They do not submit transactions or require a wallet file.

The package must contain `dist/idl/fermi_v1.json`, TypeScript declarations,
`proto/ctm_sequencer.proto`, documentation, examples, and the r9 environment template.

## Configure a client

```bash
cp .env.fermi-r9-mainnet.example .env
```

Set the wallet file and gateway API key in `.env`.
Use the [usage guide](../USAGE.md) for the account workflow.
The [migration guide](r9-migration.md) records the IDL source and compatibility rules.

## Update the IDL

The current snapshot comes from the r9 source commit
`ea0a609c0283b1f9c475d269667ce5ccd049b216`.
The JSON and TypeScript type describe the same schema.
The source snapshot predates v5 queue instructions. The SDK uses explicit v5 wire encoders.

For a future release, use the deployment's source and IDL together.
Do not replace the Fermi IDL with the upstream Mango IDL.
Run the r9 regression suite after any schema or account-model change.
