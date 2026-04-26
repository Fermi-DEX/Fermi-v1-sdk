#!/usr/bin/env node

import 'dotenv/config';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Cluster, Connection, Keypair } from '@solana/web3.js';
import {
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

function optionalIntEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`env var ${name} must be a non-negative integer`);
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

async function resolveCreatedAccount(params: {
  client: MangoClient;
  group: Group;
  owner: Keypair;
  accountNumber: number;
}): Promise<MangoAccount> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const found = await params.client.getMangoAccountForOwner(
      params.group,
      params.owner.publicKey,
      params.accountNumber,
    );
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `created mango account not found for owner=${params.owner.publicKey.toBase58()} account_num=${
      params.accountNumber
    }`,
  );
}

async function main(): Promise<void> {
  const accountNumber = optionalIntEnv('MANGO_ACCOUNT_NUM') ?? 0;
  const tokenCount = optionalIntEnv('MANGO_ACCOUNT_TOKEN_COUNT');
  const serum3Count = optionalIntEnv('MANGO_ACCOUNT_SERUM3_COUNT');
  const perpCount = optionalIntEnv('MANGO_ACCOUNT_PERP_COUNT');
  const perpOoCount = optionalIntEnv('MANGO_ACCOUNT_PERP_OO_COUNT');
  const accountName = process.env.MANGO_ACCOUNT_NAME || '';

  const { user, client, group } = await createClientAndGroup();
  const existing = await client.getMangoAccountForOwner(
    group,
    user.publicKey,
    accountNumber,
  );
  if (existing) {
    throw new Error(
      `mango account already exists for owner=${user.publicKey.toBase58()} account_num=${accountNumber}: ${existing.publicKey.toBase58()}`,
    );
  }

  const status = await client.createMangoAccount(
    group,
    accountNumber,
    accountName,
    tokenCount,
    serum3Count,
    perpCount,
    perpOoCount,
  );
  const created = await resolveCreatedAccount({
    client,
    group,
    owner: user,
    accountNumber,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        tx_signature: status.signature,
        group: group.publicKey.toBase58(),
        owner: user.publicKey.toBase58(),
        mango_account: created.publicKey.toBase58(),
        account_num: created.accountNum,
        name: accountName,
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
