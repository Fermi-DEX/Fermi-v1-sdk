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
  MangoAccount as FermiV1Account,
  MangoClient as FermiV1AccountClient,
  PerpMarketIndex,
  PerpMarket,
  Serum3Orders,
  TokenIndex,
  TokenPosition,
} from '@blockworks-foundation/mango-v4';
import fs from 'fs';
import path from 'path';
import {
  FermiV1Deployment,
  findFermiV1DeploymentByGroup,
  getFermiV1Deployment,
  requireFermiV1Deployment,
} from './deployments';
import { requireApiKey } from './auth';

export type FermiV1ContextConfig = {
  cluster?: Cluster;
  clusterUrl?: string;
  deployment?: string;
  /** Fermi v1 gateway REST base URL. Required. */
  gatewayUrl?: string;
  /** Fermi v1 gateway gRPC address `host:port`. Required if using the relayer. */
  gatewayGrpcAddr?: string;
  /** UUID API key — mandatory. Used as `x-api-key` on all SDK calls. */
  apiKey: string;
  userKeypair: string | number[] | Uint8Array;
  groupPk?: string | PublicKey;
  fermiAccountPk: string | PublicKey;
  /**
   * Legacy/default execution queue address. Current v5 helpers derive the
   * per-market queue PDA from `(programId, group, marketIndex)`.
   */
  executionQueuePk?: string | PublicKey;
  programId?: string | PublicKey;
  commitment?: Commitment;
};

export type ResolvedFermiV1ContextConfig = Omit<
  FermiV1ContextConfig,
  'cluster' | 'clusterUrl' | 'groupPk' | 'fermiAccountPk' | 'programId'
> & {
  cluster: Cluster;
  clusterUrl: string;
  groupPk: PublicKey;
  fermiAccountPk: PublicKey;
  programId: PublicKey;
};

export type FermiV1Context = {
  config: ResolvedFermiV1ContextConfig;
  connection: Connection;
  wallet: Wallet;
  user: Keypair;
  client: FermiV1AccountClient;
  group: Group;
  fermiAccount: FermiV1Account;
  executionQueuePk?: PublicKey;
  programId: PublicKey;
  /** Resolved proxy gateway REST base URL. */
  gatewayUrl?: string;
  /** Resolved proxy gateway gRPC `host:port`. */
  gatewayGrpcAddr?: string;
  /** Validated UUID API key. */
  apiKey: string;
  deployment?: FermiV1Deployment;
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

export function defaultClusterUrl(cluster: Cluster): string {
  switch (cluster) {
    case 'mainnet-beta':
      return 'https://api.mainnet-beta.solana.com';
    case 'testnet':
      return 'https://api.testnet.solana.com';
    case 'devnet':
    default:
      return 'https://api.devnet.solana.com';
  }
}

export function resolveDeploymentForGroup(
  groupPk: string | PublicKey,
  deploymentName?: string,
): FermiV1Deployment | undefined {
  const group = toPublicKey(groupPk).toBase58();
  if (deploymentName) {
    const deployment = requireFermiV1Deployment(deploymentName);
    if (deployment.group !== group) {
      throw new Error(
        `FERMI_DEPLOYMENT=${deploymentName} is for group ${deployment.group}, not ${group}`,
      );
    }
    return deployment;
  }
  return findFermiV1DeploymentByGroup(group);
}

export function resolveProgramIdForGroup(params: {
  cluster: Cluster;
  groupPk: string | PublicKey;
  programId?: string | PublicKey;
  deployment?: string;
}): PublicKey {
  const deployment = resolveDeploymentForGroup(
    params.groupPk,
    params.deployment,
  );
  if (deployment && deployment.cluster !== params.cluster) {
    throw new Error(
      `deployment ${deployment.name} is on ${deployment.cluster}, not ${params.cluster}`,
    );
  }

  if (params.programId !== undefined) {
    const programId = toPublicKey(params.programId);
    if (deployment && deployment.programId !== programId.toBase58()) {
      throw new Error(
        `PROGRAM_ID=${programId.toBase58()} does not match deployment ${deployment.name} program ${deployment.programId}`,
      );
    }
    return programId;
  }

  if (deployment) {
    return new PublicKey(deployment.programId);
  }
  return MANGO_V4_ID[params.cluster];
}

export async function createFermiV1Context(config: FermiV1ContextConfig): Promise<FermiV1Context> {
  const apiKey = requireApiKey(config.apiKey, 'createFermiV1Context');
  const user = loadKeypair(config.userKeypair);
  const namedDeployment = getFermiV1Deployment(config.deployment);
  if (config.deployment && !namedDeployment) {
    requireFermiV1Deployment(config.deployment);
  }
  const groupPk = config.groupPk
    ? toPublicKey(config.groupPk)
    : namedDeployment
      ? new PublicKey(namedDeployment.group)
      : undefined;
  if (!groupPk) {
    throw new Error('missing groupPk; set GROUP_PK or FERMI_DEPLOYMENT');
  }
  const deployment = resolveDeploymentForGroup(groupPk, config.deployment);
  const cluster = config.cluster ?? ((deployment?.cluster ?? 'devnet') as Cluster);
  const clusterUrl =
    config.clusterUrl ?? deployment?.rpcUrl ?? defaultClusterUrl(cluster);
  const programId = resolveProgramIdForGroup({
    cluster,
    groupPk,
    programId: config.programId,
    deployment: config.deployment,
  });
  const gatewayUrl = config.gatewayUrl ?? deployment?.gatewayUrl;
  const gatewayGrpcAddr = config.gatewayGrpcAddr ?? deployment?.gatewayGrpcAddr;
  const connection = new Connection(
    clusterUrl,
    config.commitment ?? AnchorProvider.defaultOptions().commitment,
  );
  const wallet = new Wallet(user);
  const provider = new AnchorProvider(
    connection,
    wallet,
    AnchorProvider.defaultOptions(),
  );
  const client = await FermiV1AccountClient.connect(provider, cluster, programId, {
    idsSource: 'get-program-accounts',
  });
  const fermiAccountPk = toPublicKey(config.fermiAccountPk);
  const fermiAccount = await client.getMangoAccount(fermiAccountPk);
  const group = await client.getGroup(groupPk);
  const resolvedConfig: ResolvedFermiV1ContextConfig = {
    ...config,
    cluster,
    clusterUrl,
    deployment: deployment?.name ?? config.deployment,
    groupPk,
    fermiAccountPk,
    programId,
    gatewayUrl,
    gatewayGrpcAddr,
    apiKey,
  };

  return {
    config: resolvedConfig,
    connection,
    wallet,
    user,
    client,
    group,
    fermiAccount,
    executionQueuePk:
      config.executionQueuePk !== undefined
        ? toPublicKey(config.executionQueuePk)
        : undefined,
    programId,
    gatewayUrl,
    gatewayGrpcAddr,
    apiKey,
    deployment,
  };
}


export async function buildCanonicalPerpRemainingAccounts(
  context: FermiV1Context,
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

  const tokenPositionIndices = context.fermiAccount.tokens.map(
    (token) => token.tokenIndex,
  );
  const settlementBank = context.group.getFirstBankForPerpSettlement();
  const tokenIndexUnset =
    TokenPosition.TokenIndexUnset as typeof settlementBank.tokenIndex;
  if (
    !tokenPositionIndices.includes(settlementBank.tokenIndex) &&
    tokenPositionIndices.includes(tokenIndexUnset)
  ) {
    tokenPositionIndices[
      tokenPositionIndices.findIndex((index) => index === tokenIndexUnset)
    ] = settlementBank.tokenIndex;
  }
  if (!tokenPositionIndices.includes(settlementBank.tokenIndex)) {
    throw new Error(
      'all Mango token positions are occupied; cannot build canonical perp execution-queue accounts',
    );
  }

  const mintInfos = uniqueBy(
    tokenPositionIndices
      .filter((tokenIndex) => tokenIndex !== tokenIndexUnset)
      .map((tokenIndex) => {
        const mintInfo = context.group.mintInfosMapByTokenIndex.get(
          tokenIndex as TokenIndex,
        );
        if (!mintInfo) {
          throw new Error(`missing mint info for token index ${tokenIndex}`);
        }
        return mintInfo;
      }),
    (mintInfo) => mintInfo.tokenIndex,
  );
  const allPerpMarkets = Array.from(
    context.group.perpMarketsMapByMarketIndex.values(),
  ).sort((left, right) => left.perpMarketIndex - right.perpMarketIndex);
  const fallbackMap = await context.client.deriveFallbackOracleContexts(
    context.group,
  );
  const fallbackOracles: PublicKey[] = [];
  for (const oracle of mintInfos.map((mintInfo) => mintInfo.oracle)) {
    const fallback = fallbackMap.get(oracle.toBase58());
    if (fallback) {
      fallbackOracles.push(...fallback);
    }
  }
  const serumOpenOrders = context.fermiAccount.serum3
    .filter(
      (serumPosition) =>
        serumPosition.marketIndex !== Serum3Orders.Serum3MarketIndexUnset,
    )
    .map((serumPosition) => serumPosition.openOrders);
  const openbookOpenOrders = (
    (
      context.fermiAccount as FermiV1Account & {
        openbookV2?: Array<{ marketIndex: number; openOrders: PublicKey }>;
      }
    ).openbookV2 ?? []
  )
    .filter((openbookPosition) => openbookPosition.marketIndex !== 65535)
    .map((openbookPosition) => openbookPosition.openOrders);
  const healthRemainingAccounts = buildExecutionQueueHealthRemainingAccountKeys(
    {
      bankAccounts: mintInfos.map((mintInfo) => mintInfo.firstBank()),
      tokenOracles: mintInfos.map((mintInfo) => mintInfo.oracle),
      perpMarkets: allPerpMarkets.map((market) => market.publicKey),
      perpOracles: allPerpMarkets.map((market) => market.oracle),
      serumOpenOrders,
      openbookOpenOrders,
      fallbackOracles,
    },
  );

  return [
    { pubkey: context.group.publicKey, isSigner: false, isWritable: false },
    { pubkey: context.fermiAccount.publicKey, isSigner: false, isWritable: true },
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

type HealthRemainingAccountSections = {
  bankAccounts?: PublicKey[];
  tokenOracles?: PublicKey[];
  perpMarkets?: PublicKey[];
  perpOracles?: PublicKey[];
  serumOpenOrders?: PublicKey[];
  openbookOpenOrders?: PublicKey[];
  fallbackOracles?: PublicKey[];
};

function buildExecutionQueueHealthRemainingAccountKeys(
  sections: HealthRemainingAccountSections,
): PublicKey[] {
  const fallbackSeen = new Set(
    (sections.tokenOracles ?? []).map((key) => key.toBase58()),
  );
  const fallbackOracles: PublicKey[] = [];
  for (const fallback of sections.fallbackOracles ?? []) {
    const key = fallback.toBase58();
    if (fallback.equals(PublicKey.default) || fallbackSeen.has(key)) {
      continue;
    }
    fallbackSeen.add(key);
    fallbackOracles.push(fallback);
  }

  return [
    ...(sections.bankAccounts ?? []),
    ...(sections.tokenOracles ?? []),
    ...(sections.perpMarkets ?? []),
    ...(sections.perpOracles ?? []),
    ...(sections.serumOpenOrders ?? []),
    ...(sections.openbookOpenOrders ?? []),
    ...fallbackOracles,
  ];
}

function uniqueBy<T, K>(values: T[], keyFn: (value: T) => K): T[] {
  const seen = new Set<K>();
  const unique: T[] = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(value);
  }
  return unique;
}
