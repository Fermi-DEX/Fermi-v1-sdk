#!/usr/bin/env node

import 'dotenv/config';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  Group,
  MangoAccount,
  MangoClient,
} from '@blockworks-foundation/mango-v4';
import {
  loadKeypair,
  resolveProgramIdForGroup,
  toPublicKey,
} from '../context';
import {
  clusterFromEnv,
  clusterUrlFromEnv,
  commitmentFromEnv,
  deploymentFromEnv,
  groupPkFromEnv,
  requiredEnv,
  usdcMintFromEnv,
} from './env';

function parseAmountUi(name: string): number {
  const value = requiredEnv(name);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`env var ${name} must be a positive number`);
  }
  return parsed;
}

function parseAccountNum(): number {
  const value = process.env.MANGO_ACCOUNT_NUM;
  if (value === undefined || value === '') {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('env var MANGO_ACCOUNT_NUM must be a non-negative integer');
  }
  return parsed;
}

async function createClientAndGroup(): Promise<{
  user: Keypair;
  connection: Connection;
  client: MangoClient;
  group: Group;
  programId: PublicKey;
  deployment?: string;
}> {
  const deployment = deploymentFromEnv();
  const cluster = clusterFromEnv();
  const user = loadKeypair(requiredEnv('USER_KEYPAIR'));
  const connection = new Connection(clusterUrlFromEnv(), commitmentFromEnv());
  const provider = new AnchorProvider(
    connection,
    new Wallet(user),
    AnchorProvider.defaultOptions(),
  );
  const groupPk = toPublicKey(groupPkFromEnv());
  const programId = resolveProgramIdForGroup({
    cluster,
    groupPk,
    programId: process.env.PROGRAM_ID,
    deployment: deployment?.name,
  });
  const client = await MangoClient.connect(provider, cluster, programId, {
    idsSource: 'get-program-accounts',
  });
  const group = await client.getGroup(groupPk);
  return { user, connection, client, group, programId, deployment: deployment?.name };
}

async function resolveMangoAccount(params: {
  client: MangoClient;
  group: Group;
  owner: PublicKey;
  mangoAccountPk?: string;
  accountNumber: number;
}): Promise<MangoAccount> {
  if (params.mangoAccountPk) {
    return await params.client.getMangoAccount(
      toPublicKey(params.mangoAccountPk),
    );
  }
  const found = await params.client.getMangoAccountForOwner(
    params.group,
    params.owner,
    params.accountNumber,
  );
  if (!found) {
    throw new Error(
      `no mango account found for owner=${params.owner.toBase58()} account_num=${
        params.accountNumber
      }; set MANGO_ACCOUNT_PK or create the account first`,
    );
  }
  return found;
}

async function main(): Promise<void> {
  const amountUi = parseAmountUi('USDC_AMOUNT_UI');
  const { user, connection, client, group, programId, deployment } =
    await createClientAndGroup();
  const mangoAccount = await resolveMangoAccount({
    client,
    group,
    owner: user.publicKey,
    mangoAccountPk: process.env.MANGO_ACCOUNT_PK,
    accountNumber: parseAccountNum(),
  });

  const mint = usdcMintFromEnv();
  const mintPk = mint
    ? toPublicKey(mint)
    : group.getFirstBankForPerpSettlement().mint;
  const ownerTokenAccount = await getAssociatedTokenAddress(
    mintPk,
    user.publicKey,
    true,
  );

  let ownerBalanceUi: string | null = null;
  try {
    ownerBalanceUi =
      (await connection.getTokenAccountBalance(ownerTokenAccount)).value
        .uiAmountString ?? null;
  } catch {
    ownerBalanceUi = null;
  }

  const status = await client.tokenDeposit(
    group,
    mangoAccount,
    mintPk,
    amountUi,
    false,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        tx_signature: status.signature,
        deployment,
        program_id: programId.toBase58(),
        group: group.publicKey.toBase58(),
        owner: user.publicKey.toBase58(),
        mango_account: mangoAccount.publicKey.toBase58(),
        mint: mintPk.toBase58(),
        amount_ui: amountUi,
        owner_token_account: ownerTokenAccount.toBase58(),
        owner_token_balance_ui_before: ownerBalanceUi,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack || err.message : `${err}`;
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
