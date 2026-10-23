import { AccountMeta, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { FermiV1AccountClient } from './accountClient';
import {
  FlpClient,
  VaultAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from './flp';

/** Active-position CPI health accounts differ from the all-market v5 intent list. */
export async function buildFlpPricingContext(
  core: FermiV1AccountClient,
  client: FlpClient,
  vault: PublicKey,
  state: VaultAccount,
) {
  const account = await core.getFermiAccount(state.fermiAccount);
  const authority = client.authority(vault);
  if (!account.group.equals(state.group) || !account.owner.equals(authority)) {
    throw new Error(
      'FLP core account does not match the vault group and authority',
    );
  }
  const group = await core.getGroup(state.group);
  const bank = group.getFirstBankByMint(state.quoteMint);
  if (!bank.publicKey.equals(state.quoteBank))
    throw new Error('FLP quote bank does not match the group');
  if (!(state.feeRecipient instanceof PublicKey))
    throw new Error('FLP fee recipient is missing');
  const health: AccountMeta[] = (
    await core.buildHealthRemainingAccounts(group, [account], [bank])
  ).map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));
  const fermi = {
    'fermi.group': state.group,
    'fermi.fermiAccount': state.fermiAccount,
    'fermi.quoteBank': bank.publicKey,
    'fermi.quoteBankVault': bank.vault,
    'fermi.quoteOracle': bank.oracle,
    'fermi.fermiProgram': core.programId,
    'fermi.tokenProgram': TOKEN_PROGRAM_ID,
  };
  const accounts: Record<string, PublicKey> = {
    authority,
    ...fermi,
    feeShareAccount: getAssociatedTokenAddressSync(
      state.shareMint,
      state.feeRecipient,
      true,
      TOKEN_2022_PROGRAM_ID,
    ),
    idleAccount: getAssociatedTokenAddressSync(
      state.quoteMint,
      authority,
      true,
    ),
    shareMint: state.shareMint,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    systemProgram: PublicKey.default,
  };
  const pricingAccounts = Object.fromEntries(
    Object.entries(accounts)
      .filter(([key]) => key !== 'systemProgram')
      .map(([key, value]) => [`pricing.${key}`, value]),
  );
  return {
    group,
    account,
    health,
    pricingHealth: await client.withEventQueues(health),
    accounts,
    pricingAccounts,
  };
}
