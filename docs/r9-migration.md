# Migrate to r9 mainnet

Version `0.2.0` targets `fermi-r9-mainnet`.
The retired r6 program uses different accounts and addresses.
The SDK retains `FERMI_R6_MAINNET` as a deprecated address reference only.
The active deployment registry accepts r9.

## Deployment identity

| Item | r9 value |
| --- | --- |
| Program | `FRMiX94PWHbndvySq8xyRx185GvPeggUeKaLmZgVdd4` |
| Group | `2mDvxS4A6bJyR3RjLwvBWeNuFvCAaQ26ss7w1jUChRse` |
| Core source | `ea0a609c0283b1f9c475d269667ce5ccd049b216` |
| Recorded core ELF SHA-256 | `29c6167e1e0eb4577215cf5a85a9646ed36b97c479ace0a71631b7fe71358aa9` |

The address registry matches production `/config` on 2026-10-23.
The core release record supplies the source commit and ELF hash.
These records identify the target release. They do not prove a later program upgrade.

## Changed names and bytes

| Surface | Previous | r9 |
| --- | --- | --- |
| User-account PDA seed | `MangoAccount` | `FermiAccount` |
| Account discriminator, hex | `f3e4f703a934af1f` | `f52433085a7fe7f4` |
| Account discriminator, base58 | `ho5hwwEoHot` | `i1BN83QxYJw` |
| Anchor account namespace | `program.account.mangoAccount` | `program.account.fermiAccount` |
| Coder account name | `mangoAccount` | `fermiAccount` |
| Account-data event | `MangoAccountData` | `FermiAccountData` |
| Account-data event discriminator | `5f243b251fa2edbf` | `ea1387d50a836bd8` |
| Event group field | `mangoGroup` | `fermiGroup` |
| Event account field | `mangoAccount` | `fermiAccount` |
| Group field | `buybackFeesSwapMangoAccount` | `buybackFeesSwapFermiAccount` |
| `groupEdit` argument | `buybackFeesSwapMangoAccountOpt` | `buybackFeesSwapFermiAccountOpt` |
| v5 reveal/direct-item account field | `mangoAccount` | `fermiAccount` |

The account body layout remains unchanged by the rename.
The group is at offset 8 and the owner is at offset 40.
The delegate is at offset 104. Filters must use the new discriminator.

The SDK's `findFermiV1AccountPda` uses these seeds, in this order:

```text
["FermiAccount", group public key, owner public key, account number as u32 little-endian]
```

Instruction names, instruction discriminators, account-meta order, and signed-message
formats retain their existing wire identities. The queue and authority PDA prefixes
also remain unchanged. A new program or group still produces new PDA addresses.

## SDK changes

1. Replace the r6 environment template with `.env.fermi-r9-mainnet.example`.
2. Remove old `PROGRAM_ID` and `GROUP_PK` overrides.
3. Select `deployment: 'fermi-r9-mainnet'` in programmatic contexts.
4. Use an r9 `fermiAccountPk`.
5. Use `FermiV1AccountClient` for direct account operations.
6. Use `client.fermiProgram` for typed Anchor calls.

| Preferred method | Retained alias |
| --- | --- |
| `getFermiAccount` | `getMangoAccount` |
| `getFermiAccountForOwner` | `getMangoAccountForOwner` |
| `getFermiAccountsForOwner` | `getMangoAccountsForOwner` |
| `createFermiAccount` | `createMangoAccount` |

Every alias uses the r9 IDL and account identity. The SDK does not modify the
upstream package's coder or global discriminator functions. The upstream `Group`
model retains its legacy field alias, and the loaded group exposes the new field.

The CLIs add `fermi_account` to their output and retain `mango_account`.
The relayer's HTTP/gRPC fields still use names such as `mango_account`.
Do not rename protobuf fields or signed-message domains.

## IDL provenance and scope

`src/idl/fermi_v1.json` contains the runtime `IDL` from
`ts/client/src/mango_v4.ts` at the pinned r9 source commit.
`src/idl/fermi_v1.ts` contains its generated type and exported `FERMI_V1_IDL`.
The package copies the runtime JSON into `dist/idl/fermi_v1.json`.

The source IDL snapshot contains 104 instructions and predates the v5 queue API.
Its account, event, and argument names include the Fermi rename.
The SDK constructs v5 instructions with explicit encoders in `src/intents.ts`.
It does not offer missing v5 methods through `client.fermiProgram.methods`.

A raw v5 integration must use `fermiAccount` for renamed struct fields.
The positional wire bytes remain unchanged. The legacy signed-message domains
include `mango-v5-user-intent-v2` and `mango-v4-user-intent-v2`.

## r9 operational behavior

Account creation defaults to `[1, 0, 3, 32]` for token, Serum3, perp, and perp-order slots.
The SDK rejects non-zero Serum3 capacity before it constructs the transaction.
A custom group requires an explicit program ID.

The mainnet direct pools were absent at the 2026-10-23 check.
Use the relayer path. For a prepared custom deployment, direct helpers default
to current slot + 20. A zero expiry is invalid for r9 direct intents.
