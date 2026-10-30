/** Build-only workflows: the caller chooses the wallet and submits complete arrays. */
import { Connection, PublicKey } from '@solana/web3.js';
import { FermiV1AccountClient, FlpV4Client, FLP_V4_RELEASE, buildFlpPricingContext, flpV4 } from '../src';

export function mainnetFlp(connection: Connection) {
  return new FlpV4Client(connection, new PublicKey(FLP_V4_RELEASE.vaultProgram));
}

export async function publicDeposit(client: FlpV4Client, vault: PublicKey, user: PublicKey, quote: bigint) {
  const state = await client.fetchVault(vault);
  return state.status & flpV4.STATUS.preDeposit
    ? client.preDepositInstructions(vault, state, user, quote)
    : client.requestDepositInstructions(vault, state, user, quote);
}

export async function approvedDeposit(core: FermiV1AccountClient, client: FlpV4Client,
  vault: PublicKey, user: PublicKey, quote: bigint, minimumShares: bigint) {
  const state = await client.fetchVault(vault);
  const context = await buildFlpPricingContext(core, client, vault, state);
  return client.permissionedDepositInstructions(vault, state, user, quote, minimumShares,
    context.pricingAccounts, context.pricingHealth);
}

export async function refundPublicPrincipal(client: FlpV4Client, vault: PublicKey, user: PublicKey, quote: bigint) {
  const state = await client.fetchVault(vault);
  if (!(state.status & flpV4.STATUS.preDeposit)) throw new Error('Principal has already graduated');
  return client.preWithdrawInstructions(vault, state, user, quote);
}

export async function requestWithdrawal(client: FlpV4Client, vault: PublicKey, user: PublicKey, shares: bigint) {
  const state = await client.fetchVault(vault);
  return client.requestWithdrawInstructions(vault, state, user, shares);
}

export async function settleDeposit(client: FlpV4Client, vault: PublicKey, user: PublicKey) {
  const state = await client.fetchVault(vault);
  const depositor = await client.fetchDepositor(vault, user);
  if (depositor.dep.epoch.eq(flpV4.NONE_EPOCH)) throw new Error('No deposit ticket');
  const record = await client.fetchEpoch(vault, depositor.dep.epoch);
  return client.settleDepositInstructions(vault, state, user, record);
}

export async function closeEpoch(core: FermiV1AccountClient, client: FlpV4Client, vault: PublicKey, payer: PublicKey) {
  const state = await client.fetchVault(vault);
  const context = await buildFlpPricingContext(core, client, vault, state);
  return client.closeEpoch(vault, state, { ...context.accounts, payer }, context.health);
}

export async function claimWithdrawal(client: FlpV4Client, vault: PublicKey, user: PublicKey) {
  const state = await client.fetchVault(vault);
  const depositor = await client.fetchDepositor(vault, user);
  if (depositor.wd.epoch.eq(flpV4.NONE_EPOCH)) throw new Error('No withdrawal ticket');
  return client.claimWithdrawalInstructions(vault, state, user, depositor.wd.epoch);
}

/** Call after assembling ALL setup, operation and compute-budget instructions.
 * Lookup table addresses must come from the deployment's verified configuration.
 * Pass wallet.supportedTransactionVersions?.has(0) === true as supportsV0.
 */
export async function prepareForWallet(connection: Connection, payer: PublicKey,
  instructions: import('@solana/web3.js').TransactionInstruction[], supportsV0: boolean,
  lookupTableAddresses: PublicKey[]) {
  const lookupTables = await Promise.all(lookupTableAddresses.map(async address => {
    const { value } = await connection.getAddressLookupTable(address, { commitment: 'confirmed' });
    if (!value) throw new Error(`Missing lookup table ${address}`);
    return value;
  }));
  return flpV4.prepareFlpWalletTransaction(connection, { payer, instructions, supportsV0, lookupTables });
}
