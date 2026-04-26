#!/usr/bin/env node

import 'dotenv/config';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Cluster, Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  Group,
  MANGO_V4_ID,
  MangoAccount,
  MangoClient,
} from '@blockworks-foundation/mango-v4';
import { loadKeypair, toPublicKey } from '../context';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

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

function commitmentFromEnv() {
  return (process.env.COMMITMENT ||
    AnchorProvider.defaultOptions().commitment) as ReturnType<
    typeof AnchorProvider.defaultOptions
  >['commitment'];
}

async function createClientAndGroup(): Promise<{
  user: Keypair;
  connection: Connection;
  client: MangoClient;
  group: Group;
}> {
  const cluster = (process.env.CLUSTER || 'devnet') as Cluster;
  const user = loadKeypair(requiredEnv('USER_KEYPAIR'));
  const connection = new Connection(
    requiredEnv('CLUSTER_URL'),
    commitmentFromEnv(),
  );
  const provider = new AnchorProvider(
    connection,
    new Wallet(user),
    AnchorProvider.defaultOptions(),
  );
  const programId = process.env.PROGRAM_ID
    ? toPublicKey(process.env.PROGRAM_ID)
    : MANGO_V4_ID[cluster];
  const client = await MangoClient.connect(provider, cluster, programId, {
    idsSource: 'get-program-accounts',
  });
  const group = await client.getGroup(toPublicKey(requiredEnv('GROUP_PK')));
  return { user, connection, client, group };
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
  const { user, connection, client, group } = await createClientAndGroup();
  const mangoAccount = await resolveMangoAccount({
    client,
    group,
    owner: user.publicKey,
    mangoAccountPk: process.env.MANGO_ACCOUNT_PK,
    accountNumber: parseAccountNum(),
  });

  const mintPk = process.env.USDC_MINT
    ? toPublicKey(process.env.USDC_MINT)
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
