import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import {
  Cluster,
  Commitment,
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import {
  Group,
  MANGO_V4_ID,
  MangoAccount,
  MangoClient,
  PerpMarketIndex,
  PerpMarket,
} from '@blockworks-foundation/mango-v4';
import fs from 'fs';
import path from 'path';

export type MangoContextConfig = {
  cluster: Cluster;
  clusterUrl: string;
  harnessBaseUrl?: string;
  userKeypair: string | number[] | Uint8Array;
  groupPk: string | PublicKey;
  mangoAccountPk: string | PublicKey;
  executionQueuePk: string | PublicKey;
  programId?: string | PublicKey;
  commitment?: Commitment;
};

export type MangoContext = {
  config: MangoContextConfig;
  connection: Connection;
  wallet: Wallet;
  user: Keypair;
  client: MangoClient;
  group: Group;
  mangoAccount: MangoAccount;
  executionQueuePk: PublicKey;
  programId: PublicKey;
  harnessBaseUrl?: string;
};

export function loadKeypair(rawPathOrJson: string | number[] | Uint8Array): Keypair {
  if (rawPathOrJson instanceof Uint8Array) {
    return Keypair.fromSecretKey(rawPathOrJson);
  }
  if (Array.isArray(rawPathOrJson)) {
    return Keypair.fromSecretKey(Uint8Array.from(rawPathOrJson));
  }

  const maybeFile = path.resolve(rawPathOrJson);
  const raw = fs.existsSync(maybeFile)
    ? fs.readFileSync(maybeFile, 'utf-8')
    : rawPathOrJson;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

export function toPublicKey(value: string | PublicKey): PublicKey {
  return value instanceof PublicKey ? value : new PublicKey(value);
}

export async function createMangoContext(config: MangoContextConfig): Promise<MangoContext> {
  const user = loadKeypair(config.userKeypair);
  const connection = new Connection(
    config.clusterUrl,
    config.commitment ?? AnchorProvider.defaultOptions().commitment,
  );
  const wallet = new Wallet(user);
  const provider = new AnchorProvider(
    connection,
    wallet,
    AnchorProvider.defaultOptions(),
  );
  const programId =
    config.programId !== undefined
      ? toPublicKey(config.programId)
      : MANGO_V4_ID[config.cluster];
  const client = await MangoClient.connect(provider, config.cluster, programId, {
    idsSource: 'get-program-accounts',
  });
  const mangoAccount = await client.getMangoAccount(toPublicKey(config.mangoAccountPk));
  const group = await client.getGroup(toPublicKey(config.groupPk));

  return {
    config,
    connection,
    wallet,
    user,
    client,
    group,
    mangoAccount,
    executionQueuePk: toPublicKey(config.executionQueuePk),
    programId,
    harnessBaseUrl: config.harnessBaseUrl,
  };
}

export async function buildCanonicalPerpRemainingAccounts(
  context: MangoContext,
  perpMarketIndex: number,
): Promise<
  Array<{
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }>
> {
  const perpMarket: PerpMarket =
    context.group.getPerpMarketByMarketIndex(
      perpMarketIndex as PerpMarketIndex,
    );
  const healthRemainingAccounts = await context.client.buildHealthRemainingAccounts(
    context.group,
    [context.mangoAccount],
    [context.group.getFirstBankForPerpSettlement()],
    [perpMarket],
  );

  return [
    { pubkey: context.group.publicKey, isSigner: false, isWritable: false },
    { pubkey: context.mangoAccount.publicKey, isSigner: false, isWritable: true },
    { pubkey: context.user.publicKey, isSigner: false, isWritable: false },
    { pubkey: perpMarket.publicKey, isSigner: false, isWritable: true },
    { pubkey: perpMarket.bids, isSigner: false, isWritable: true },
    { pubkey: perpMarket.asks, isSigner: false, isWritable: true },
    { pubkey: perpMarket.eventQueue, isSigner: false, isWritable: true },
    { pubkey: perpMarket.oracle, isSigner: false, isWritable: false },
    ...healthRemainingAccounts.map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: false,
    })),
  ];
}
