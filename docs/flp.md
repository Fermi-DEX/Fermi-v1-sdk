# FLP instructions and metadata

The SDK includes the current FLP client, all 56 IDL instructions, account decoders,
PDA helpers, event parsing and transaction-size helpers.
It targets the v3 vault layout and the RC4 extensions in source
`7afba98770b6bae99d839c296f3c7fd4750ab18c`.

FLP is a separate program from the r9 trading core.
Supply the actual FLP program ID and vault PDA from the operator.
The IDL metadata contains a test placeholder. It is not a mainnet deployment preset.
This SDK update does not deploy or upgrade a vault.

## Public deposits and withdrawals

```ts
import { Connection, PublicKey } from '@solana/web3.js';
import { FlpClient, flp, loadKeypair } from '@fermilabs/fermi-v1-sdk';

const connection = new Connection(process.env.CLUSTER_URL!, 'confirmed');
const client = new FlpClient(connection, new PublicKey(process.env.FLP_PROGRAM_ID!));
const vault = new PublicKey(process.env.FLP_VAULT_PK!);
const user = loadKeypair(process.env.USER_KEYPAIR!);
const state = await client.fetchVault(vault);

// Builders return instructions. They do not sign or send transactions.
const deposits = client.depositInstructions(vault, state, user.publicKey, 5_000_000n);
const packet = flp.fitsLegacyPacket(deposits, user.publicKey);
console.log(flp.vaultMode(state.status), packet, deposits);
```

Amounts use native quote units. For six-decimal USDC, `5_000_000n` means 5 USDC.
Share quantities use native share units. Use `BN` or `bigint` for balances and tickets.

The phase-aware helpers select these paths:

| Operation | Helper and behavior |
| --- | --- |
| Public deposit | `depositInstructions`: pre-deposit escrow before graduation, epoch deposit afterward |
| Public refund | `publicRefundInstruction`: refund principal before graduation |
| Public shares | `claimPreDeposit`: materialize the original owner's graduation entitlement |
| Trading withdrawal | `tradingWithdrawalInstruction`: epoch queue, or terminal redemption after closure |
| Phase-aware withdrawal | `withdrawalInstruction`: public refund before graduation, trading withdrawal afterward |
| Deposit settlement | `settleDepositInstruction`: claim priced shares or refund a held deposit |
| Claims and cancellations | `claimDeposit`, `claimWithdrawal`, `cancelDeposit`, `cancelWithdraw` |

Approved trading shares and public pre-deposit principal are separate balances.
Use `tradingWithdrawalInstruction` for approved-wallet shares before graduation.
Use `publicRefundInstruction` for the public principal in escrow.

## Pricing accounts for approved capital

`buildFlpPricingContext` reads the vault's core account and group.
It checks the vault authority and quote bank.
It builds active-position health accounts and appends the relevant event queues.

```ts
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  FlpClient, FermiV1AccountClient, buildFlpPricingContext, loadKeypair,
} from '@fermilabs/fermi-v1-sdk';

const connection = new Connection(process.env.CLUSTER_URL!, 'confirmed');
const user = loadKeypair(process.env.USER_KEYPAIR!);
const provider = new AnchorProvider(connection, new Wallet(user), { commitment: 'confirmed' });
const core = FermiV1AccountClient.connect(
  provider,
  'mainnet-beta', // Select the actual cluster for the supplied programs.
  new PublicKey(process.env.PROGRAM_ID!),
);
const client = new FlpClient(connection, new PublicKey(process.env.FLP_PROGRAM_ID!));
const vault = new PublicKey(process.env.FLP_VAULT_PK!);
const state = await client.fetchVault(vault);
const pricing = await buildFlpPricingContext(core, client, vault, state);

const deposit = client.permissionedDepositInstructions(
  vault, state, user.publicKey, 5_000_000n, 1n,
  pricing.pricingAccounts, pricing.pricingHealth,
);
console.log(deposit);
```

Replace `minShares: 1n` with the minimum acceptable share amount for the transaction.
The native program still checks approval, phase, price and account health.
Consume vault maker fills before pricing. Appending event queues alone does not consume them.

The same `pricingAccounts` and `pricingHealth` serve `graduate` and
`permissionedWithdraw`. Graduation requires the admin.
Approved immediate withdrawals apply before graduation and respect the deferred FIFO head.

The helper returns two health lists. `health` excludes event queues for methods
that append them internally. `pricingHealth` already includes queues for direct pricing methods.
Do not pass the all-market v5 intent list to these FLP CPI instructions.

## Current operator and admin instructions

| Capability | Helpers or IDL instructions |
| --- | --- |
| Fresh initialization | `initializeVaultV3`, `seedVault`, `initFermiAccountV3`, `initFermiAccountV4` |
| Market capacity | `expandMarketCapacity`, up to 13 perp slots |
| Depositor records and approval | `initDepositor`, `setDepositPermission` |
| Epoch settlement | `closeEpoch`, which builds `closeEpochV3` |
| Deferred withdrawals | `cureDeferred`, `claimWithdrawal` |
| Partial and full recovery | `triggerPartialUnwind`, `triggerUnwind`, `unwindStep`, `finishUnwind`, `abortUnwind` |
| Residual assets | `recoverTokenInstructions`, `terminalRedeem` |
| Circuit breaker | `checkBreaker`, `resetBreaker` |
| Public-only pause | `setStatus` with `flp.STATUS.publicDepositsPaused` |
| Delegate changes | `proposeDelegate`, `activateDelegate`, `removeDelegate` |
| Parameter changes | `stageParamsV3`, `applyParams`, `stageRecoveryParams`, `applyRecoveryParams` |

Named methods handle phase checks, optional accounts, recovery sidecars or FIFO
accounts where required. `client.instruction(name, accounts, args, remaining)`
exposes every IDL instruction. Nested accounts use dot paths such as
`pricing.fermi.quoteBank`. Instruction names use Anchor camel case.

Example of an admin instruction without a specialized method:

```ts
const pause = client.instruction('setStatus', {
  vault,
  signer: state.admin,
}, {
  setFlags: flp.STATUS.publicDepositsPaused,
  clearFlags: 0,
});
```

The transaction still needs the required admin or guardian signature.
No SDK builder can bypass the program's authorization or timelock.

`closeEpoch` defaults to two deferred batches. Up to eight require a larger heap
and enough compute. Thirteen-market resource limits can require a smaller FIFO prefix.
Expanded recovery uses the sidecar that the named builders append.

User instructions can use a lookup table when the wallet and deployment support it.
Operator packets use legacy transactions when they fit, otherwise v1 with a compatible sender.
`operatorTransactionFormat` reports the required format. The SDK does not send v1 transactions.

## Read metadata through the gateway

```ts
import { FermiV1StateClient } from '@fermilabs/fermi-v1-sdk';

const stateClient = new FermiV1StateClient({
  gatewayUrl: process.env.FERMI_API_URL!,
  apiKey: process.env.FERMI_API_KEY!,
});
const snapshot = await stateClient.getFlpVault(process.env.FLP_VAULT_PK!);
const portfolio = await stateClient.getFlpVaultPortfolio(process.env.FLP_VAULT_PK!);
const user = await stateClient.getFlpVaultUser(
  process.env.FLP_VAULT_PK!, process.env.USER_OWNER_PK!,
);
console.log(snapshot.source, portfolio.data, user.data.user);
```

The operator must enable the FLP metadata routes.
The SDK returns schema version 1 and preserves native quantities as decimal strings.
It preserves null history and source warnings. An indicative portfolio valuation
is not an executable redemption quote.

`FlpClient` and `FLP_IDL` are root exports.
The `flp` namespace contains all constants, types and utility functions.
The package bundles the FLP IDL in `dist/flp/idl/flp_vault.json`.
The regression suite checks current instruction bytes, account privileges,
recovery extensions and the preserved PR23 layouts against Rust fixtures.
