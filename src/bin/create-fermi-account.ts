#!/usr/bin/env node

import 'dotenv/config';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  Group,
  MangoAccount,
  MangoClient as FermiV1AccountClient,
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
} from './env';

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

async function createClientAndGroup(): Promise<{
  user: Keypair;
  connection: Connection;
  client: FermiV1AccountClient;
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
  const client = await FermiV1AccountClient.connect(provider, cluster, programId, {
    idsSource: 'get-program-accounts',
  });
  const group = await client.getGroup(groupPk);
  return { user, connection, client, group, programId, deployment: deployment?.name };
}

async function resolveCreatedAccount(params: {
  client: FermiV1AccountClient;
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
    `created Fermi v1 account not found for owner=${params.owner.publicKey.toBase58()} account_num=${
      params.accountNumber
    }`,
  );
}

async function main(): Promise<void> {
  const accountNumber = optionalIntEnv('FERMI_ACCOUNT_NUM') ?? 0;
  const tokenCount = optionalIntEnv('FERMI_ACCOUNT_TOKEN_COUNT');
  const serum3Count = optionalIntEnv('FERMI_ACCOUNT_SERUM3_COUNT');
  const perpCount = optionalIntEnv('FERMI_ACCOUNT_PERP_COUNT');
  const perpOoCount = optionalIntEnv('FERMI_ACCOUNT_PERP_OO_COUNT');
  const accountName = process.env.FERMI_ACCOUNT_NAME || '';

  const { user, client, group, programId, deployment } = await createClientAndGroup();
  const existing = await client.getMangoAccountForOwner(
    group,
    user.publicKey,
    accountNumber,
  );
  if (existing) {
    throw new Error(
      `Fermi v1 account already exists for owner=${user.publicKey.toBase58()} account_num=${accountNumber}: ${existing.publicKey.toBase58()}`,
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
        deployment,
        program_id: programId.toBase58(),
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
