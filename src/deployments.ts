export type ContinuumMarketDeployment = {
  symbol: 'SOL' | 'ETH' | 'BTC' | string;
  marketIndex: number;
  perpMarket: string;
  bids: string;
  asks: string;
  eventQueue: string;
  oracle: string;
  queue: string;
  directPool: string;
  baseDecimals: number;
  baseLotSize: number;
  quoteLotSize: number;
  tickSize: number;
  minBaseSize: number;
};

export type ContinuumDeployment = {
  name: string;
  cluster: 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';
  rpcUrl: string;
  programId: string;
  group: string;
  groupNum: number;
  groupAdmin: string;
  securityAdmin: string;
  authorityState: string;
  ctmSigner: string;
  usdcMint: string;
  usdcBank: string;
  usdcVault: string;
  usdcOracle: string;
  usdcTokenProgram: string;
  markets: ContinuumMarketDeployment[];
  harnessUrl?: string;
  relayerAddr?: string;
  feeHttpUrl?: string;
  directPoolsInitialized: boolean;
};

export const FERMI_R6_MAINNET: ContinuumDeployment = {
  name: 'fermi-r6-mainnet',
  cluster: 'mainnet-beta',
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  programId: 'FRMiKrj2hQGvcZQtSDdiFRZ4cmaTjuc1QVkM2B5ShUvA',
  group: '87qUKYQoK1f9gYQjYzw5NcRo7wx6VmfhTGJ7JenoeYAA',
  groupNum: 1,
  groupAdmin: 'FD2tQBXbC6SHA8cP1X7o9g3sXqcdAbTb2Tyz9NR5zjye',
  securityAdmin: '3S4dH6ToiwZcwJ7xXmd7BWa1cvtRYzxRJPQ4pu1UMv6Q',
  authorityState: '6UZcSHiFYdxCu7LQFhLP97YiM6DH8xMPXTCmuw9Zc1X',
  ctmSigner: '89mhgW2vZZiCdwRXDJe9sCp4SNTJL7VB1W2zeX6u1hC',
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  usdcBank: 'HiNH3WgCQa57zBNDR2a3EftfFDjZFRUzzrBSqn8RVygU',
  usdcVault: 'F7cXPkwe5zRocBMdgAWtxomQJyQKzk1PJSM5fWWE8C9j',
  usdcOracle: 'Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX',
  usdcTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  harnessUrl: 'http://127.0.0.1:9191',
  relayerAddr: '127.0.0.1:9190',
  feeHttpUrl: 'http://127.0.0.1:9193',
  directPoolsInitialized: false,
  markets: [
    {
      symbol: 'SOL',
      marketIndex: 0,
      perpMarket: 'VugpJNgQNdQmVonc24S2HLQrvfXYVkknxnPd4yssw4M',
      bids: 'BZKQi4RP4dqGb8Fi2V8SNbJSQxACCbV8p5PuN35q29WW',
      asks: '4WvEZ4EjU4ffLeywv1vtyAyFcfGDFftx67Mnu39sqQZu',
      eventQueue: 'Ai2RBmHHPq5vL7qLQJSLHCU4Ltd6PyRqZ6UXTf9hksqd',
      oracle: '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE',
      queue: 'H298eJU5b4uyAHpeeZQdXS9JUttmmaMh2U6RYkUHFfE9',
      directPool: 'AiGSZp9VP8JfMnBdzaAoU84rWj5ydS9zn42iRA7oAKVL',
      baseDecimals: 5,
      baseLotSize: 100,
      quoteLotSize: 1,
      tickSize: 0.001,
      minBaseSize: 0.001,
    },
    {
      symbol: 'ETH',
      marketIndex: 1,
      perpMarket: '95gqXmc8E6Pb9BTYGpQY157DzdP7MBvnaG7Fpj5FAH2y',
      bids: 'djrj2NfmhncAybWqz4uZmu6tkySwhMoqfo8kf278nvx',
      asks: 'GzzWThTSU56y86bMGQ8BnvrHhcWVcsLEd8A8CdQZRm7n',
      eventQueue: '9cupdjvXX4cdq61fFqo9V5zDd8YuqtNkJ7uxW277gKbF',
      oracle: '42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC',
      queue: '764RYGQACUpWqx3dtYUmfG2G3MK6wXT5WPPRHJxzCJQP',
      directPool: '7mGGoaCwhApNkmv2zJ24bxiycmhfY2xAsd8MUSxb9bf',
      baseDecimals: 6,
      baseLotSize: 100,
      quoteLotSize: 10,
      tickSize: 0.1,
      minBaseSize: 0.0001,
    },
    {
      symbol: 'BTC',
      marketIndex: 2,
      perpMarket: 'Fd3i4vXE7xwTThXSZWrjjdpNQZZgPSNmpPZNp6g7vKg8',
      bids: '2hdarJUX6A8yb7fqKsdBmLEvUsPAGxMfTR4qknHNXa95',
      asks: '5dPYYfQh43i51FvG4rHTebgpYDAesBP8yxRVXBjApJjZ',
      eventQueue: 'B1DjTnZ6BeFfRwV3LrmoVXuRViYj2mKH8wgnxAhxGt9W',
      oracle: '4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo',
      queue: 'ArvDdpYTojBbH4FkCxLxALmX3Sb5qr4VsmFFkgV2NSC3',
      directPool: '7ntaZ5g2waMBCXPPEdaaEq8iKo5WoDEnUGczyxERL8iL',
      baseDecimals: 6,
      baseLotSize: 100,
      quoteLotSize: 100,
      tickSize: 1,
      minBaseSize: 0.0001,
    },
  ],
};

export const CONTINUUM_DEPLOYMENTS: Record<string, ContinuumDeployment> = {
  [FERMI_R6_MAINNET.name]: FERMI_R6_MAINNET,
};

export function getContinuumDeployment(
  name: string | undefined,
): ContinuumDeployment | undefined {
  if (!name) {
    return undefined;
  }
  return CONTINUUM_DEPLOYMENTS[name];
}

export function requireContinuumDeployment(name: string): ContinuumDeployment {
  const deployment = getContinuumDeployment(name);
  if (!deployment) {
    throw new Error(
      `unknown Continuum deployment ${name}; known deployments: ${Object.keys(
        CONTINUUM_DEPLOYMENTS,
      ).join(', ')}`,
    );
  }
  return deployment;
}

export function findContinuumDeploymentByGroup(
  groupPk: string,
): ContinuumDeployment | undefined {
  return Object.values(CONTINUUM_DEPLOYMENTS).find(
    (deployment) => deployment.group === groupPk,
  );
}

export function findContinuumMarket(
  deployment: ContinuumDeployment,
  market: string | number,
): ContinuumMarketDeployment | undefined {
  if (typeof market === 'number') {
    return deployment.markets.find((candidate) => candidate.marketIndex === market);
  }
  const normalized = market.trim().toUpperCase().replace(/-PERP$/, '');
  return deployment.markets.find(
    (candidate) =>
      candidate.symbol.toUpperCase() === normalized ||
      String(candidate.marketIndex) === normalized,
  );
}

export function deploymentEnv(
  deployment: ContinuumDeployment,
): Record<string, string> {
  return {
    CONTINUUM_DEPLOYMENT: deployment.name,
    CLUSTER: deployment.cluster,
    CLUSTER_URL: deployment.rpcUrl,
    PROGRAM_ID: deployment.programId,
    GROUP_PK: deployment.group,
    USDC_MINT: deployment.usdcMint,
    HARNESS_URL: deployment.harnessUrl ?? '',
    RELAYER_ADDR: deployment.relayerAddr ?? '',
    FEE_HTTP_URL: deployment.feeHttpUrl ?? '',
  };
}
