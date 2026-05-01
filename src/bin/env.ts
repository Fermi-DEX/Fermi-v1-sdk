import { AnchorProvider } from '@coral-xyz/anchor';
import { Cluster } from '@solana/web3.js';
import {
  ContinuumDeployment,
  requireContinuumDeployment,
} from '../deployments';

export function deploymentFromEnv(): ContinuumDeployment | undefined {
  const name = process.env.CONTINUUM_DEPLOYMENT;
  return name ? requireContinuumDeployment(name) : undefined;
}

export function optionalEnv(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

export function requiredEnv(name: string, fallback?: string): string {
  const value = optionalEnv(name, fallback);
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

export function clusterFromEnv(defaultCluster: Cluster = 'devnet'): Cluster {
  const deployment = deploymentFromEnv();
  return (process.env.CLUSTER || deployment?.cluster || defaultCluster) as Cluster;
}

export function clusterUrlFromEnv(): string {
  const deployment = deploymentFromEnv();
  return requiredEnv('CLUSTER_URL', deployment?.rpcUrl);
}

export function groupPkFromEnv(): string {
  const deployment = deploymentFromEnv();
  return requiredEnv('GROUP_PK', deployment?.group);
}

export function usdcMintFromEnv(): string | undefined {
  const deployment = deploymentFromEnv();
  return optionalEnv('USDC_MINT', deployment?.usdcMint);
}

export function harnessUrlFromEnv(): string | undefined {
  const deployment = deploymentFromEnv();
  return optionalEnv('HARNESS_URL', deployment?.harnessUrl);
}

export function relayerAddrFromEnv(): string | undefined {
  const deployment = deploymentFromEnv();
  return optionalEnv('RELAYER_ADDR', deployment?.relayerAddr);
}

export function feeHttpUrlFromEnv(): string | undefined {
  const deployment = deploymentFromEnv();
  return optionalEnv('FEE_HTTP_URL', deployment?.feeHttpUrl);
}

export function boolEnv(name: string, defaultValue: boolean): boolean {
  const value = optionalEnv(name);
  if (value === undefined) {
    return defaultValue;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`env var ${name} must be 'true' or 'false'`);
}

export function commitmentFromEnv() {
  return (process.env.COMMITMENT ||
    AnchorProvider.defaultOptions().commitment) as ReturnType<
    typeof AnchorProvider.defaultOptions
  >['commitment'];
}
