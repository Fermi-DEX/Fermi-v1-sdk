#!/usr/bin/env node

import 'dotenv/config';
import { Connection } from '@solana/web3.js';
import {
  ContinuumHarnessClient,
  HarnessDeploymentConfig,
} from '../harness';
import { ContinuumRelayerClient } from '../relayerClient';
import { ContinuumFeeClient } from '../fees';
import { toPublicKey } from '../context';
import { ContinuumDeployment } from '../deployments';
import {
  apiKeyFromEnv,
  deploymentFromEnv,
  gatewayGrpcAddrFromEnv,
  gatewayUrlFromEnv,
} from './env';

type Probe = {
  name: string;
  required: boolean;
  fn: () => Promise<string>;
};

async function timed(fn: () => Promise<string>): Promise<{
  ok: boolean;
  ms: number;
  detail: string;
}> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { ok: true, ms: Date.now() - t0, detail };
  } catch (err: any) {
    return {
      ok: false,
      ms: Date.now() - t0,
      detail: err?.body || err?.message || String(err),
    };
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function validateHarnessConfig(
  config: HarnessDeploymentConfig,
  deployment: ContinuumDeployment,
): void {
  const mismatches: string[] = [];
  if (config.program_id !== deployment.programId) {
    mismatches.push(`program_id=${config.program_id}`);
  }
  if (config.group !== deployment.group) {
    mismatches.push(`group=${config.group}`);
  }

  const usdc = config.tokens?.['0'];
  if (usdc?.mint && usdc.mint !== deployment.usdcMint) {
    mismatches.push(`usdc_mint=${usdc.mint}`);
  }

  const configMarkets = new Map(
    config.markets.map((market) => [market.market_index, market]),
  );
  for (const market of deployment.markets) {
    const configMarket = configMarkets.get(market.marketIndex);
    if (!configMarket) {
      mismatches.push(`missing_market=${market.marketIndex}`);
      continue;
    }
    if (configMarket.perp_market !== market.perpMarket) {
      mismatches.push(
        `market_${market.marketIndex}.perp_market=${configMarket.perp_market}`,
      );
    }
    if (configMarket.execution_queue?.address !== market.queue) {
      mismatches.push(
        `market_${market.marketIndex}.queue=${configMarket.execution_queue?.address}`,
      );
    }
    if (
      configMarket.execution_queue?.direct_pool &&
      configMarket.execution_queue.direct_pool !== market.directPool
    ) {
      mismatches.push(
        `market_${market.marketIndex}.direct_pool=${configMarket.execution_queue.direct_pool}`,
      );
    }
  }

  if (mismatches.length) {
    throw new Error(
      `harness /config does not match ${deployment.name}: ${mismatches.join(
        ', ',
      )}`,
    );
  }
}

async function main(): Promise<void> {
  const deployment = deploymentFromEnv();
  const probes: Probe[] = [];

  const clusterUrl = process.env.CLUSTER_URL || deployment?.rpcUrl;
  probes.push({
    name: 'rpc',
    required: true,
    fn: async () => {
      if (!clusterUrl) throw new Error('CLUSTER_URL not set');
      const slot = await new Connection(clusterUrl, 'confirmed').getSlot();
      return `slot=${slot}`;
    },
  });

  // All gateway-backed probes share one API key; load once so a missing key
  // surfaces as a single failure rather than three.
  const apiKey = process.env.FERMI_API_KEY ? apiKeyFromEnv() : undefined;
  const gatewayUrl = process.env.FERMI_API_URL ? gatewayUrlFromEnv() : undefined;
  const gatewayGrpcAddr = process.env.FERMI_API_GRPC_ADDR
    ? gatewayGrpcAddrFromEnv()
    : undefined;

  probes.push({
    name: 'gateway-rest',
    required: gatewayUrl !== undefined,
    fn: async () => {
      if (!gatewayUrl || !apiKey) {
        throw new Error('FERMI_API_URL / FERMI_API_KEY not set (skip)');
      }
      const client = new ContinuumHarnessClient({ gatewayUrl, apiKey });
      const h = await client.healthz();
      let configDetail = '';
      if (deployment) {
        const config = await client.getConfig();
        validateHarnessConfig(config, deployment);
        configDetail = ` config=ok/${config.markets.length}m`;
      }
      return `mode=${h.mode || '?'} backend=${h.backend || '?'} markets=${h.markets_total ?? '?'} users=${h.users_total ?? '?'}${configDetail}`;
    },
  });

  probes.push({
    name: 'gateway-grpc',
    required: gatewayGrpcAddr !== undefined,
    fn: async () => {
      if (!gatewayGrpcAddr || !apiKey) {
        throw new Error('FERMI_API_GRPC_ADDR / FERMI_API_KEY not set (skip)');
      }
      // gRPC clients connect lazily; force a real call so we surface
      // dial failures here rather than at first submit.
      const client = new ContinuumRelayerClient({
        gatewayGrpcAddr,
        apiKey,
      });
      try {
        // No public ping today. Submit a deliberately malformed intent and
        // treat any structured server reply (success OR rejection) as proof
        // the channel is up. Real connect failures surface as
        // UNAVAILABLE / ECONNREFUSED / DNS errors.
        await client.submitIntent({
          group: '11111111111111111111111111111111',
          execution_queue: '11111111111111111111111111111111',
          market: '0',
          payload: new Uint8Array(0),
          remaining_accounts: [],
          user_owner: '11111111111111111111111111111111',
          mango_account: '11111111111111111111111111111111',
          user_signature: new Uint8Array(64),
        });
        return 'reachable (probe accepted — unexpected)';
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (
          /UNAVAILABLE|ECONNREFUSED|name resolution|DEADLINE_EXCEEDED|EAI_AGAIN/i.test(
            msg,
          )
        ) {
          throw new Error(`unreachable: ${msg}`);
        }
        return `reachable (server replied: ${msg.slice(0, 80)})`;
      } finally {
        client.close();
      }
    },
  });

  const userOwner = process.env.USER_OWNER_PK || process.env.OWNER;
  const mangoAccount = process.env.MANGO_ACCOUNT_PK;
  probes.push({
    name: 'gateway-fees',
    required: gatewayUrl !== undefined && !!userOwner && !!mangoAccount,
    fn: async () => {
      if (!gatewayUrl || !apiKey) {
        throw new Error('FERMI_API_URL / FERMI_API_KEY not set (skip)');
      }
      if (!userOwner || !mangoAccount) {
        return 'set USER_OWNER_PK + MANGO_ACCOUNT_PK for a real fee balance probe';
      }
      const fees = new ContinuumFeeClient({ gatewayUrl, apiKey });
      const status = await fees.getStatus({
        userOwner: toPublicKey(userOwner),
        mangoAccount: toPublicKey(mangoAccount),
      });
      const balance = status.fee_account?.available_balance_lamports ?? '?';
      return `deposit=${status.deposit?.deposit_address || '?'} balance=${balance}`;
    },
  });

  let allRequiredOk = true;
  console.log('continuum smoke-check');
  console.log('---------------------');
  for (const probe of probes) {
    const res = await timed(probe.fn);
    const tag = res.ok ? 'PASS' : probe.required ? 'FAIL' : 'SKIP';
    console.log(
      `${pad(tag, 4)}  ${pad(probe.name, 12)}  ${pad(res.ms + 'ms', 8)}  ${res.detail}`,
    );
    if (!res.ok && probe.required) allRequiredOk = false;
  }
  process.exit(allRequiredOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
