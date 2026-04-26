#!/usr/bin/env node

import 'dotenv/config';
import { Cluster } from '@solana/web3.js';
import { PerpOrderSide } from '@blockworks-foundation/mango-v4';
import { createMangoContext } from '../context';
import { ContinuumHarnessClient } from '../harness';
import { ContinuumRelayerClient } from '../relayerClient';
import { CoinGeckoFairPriceProvider, RelayerPerpQuoterBot } from '../quoter';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

function parseSide(value: string): PerpOrderSide {
  switch (value.toLowerCase()) {
    case 'bid':
    case 'buy':
      return PerpOrderSide.bid;
    case 'ask':
    case 'sell':
      return PerpOrderSide.ask;
    default:
      throw new Error(`unsupported BOT_SIDE: ${value}`);
  }
}

async function main(): Promise<void> {
  const cluster = (process.env.CLUSTER || 'devnet') as Cluster;
  const context = await createMangoContext({
    cluster,
    clusterUrl: requiredEnv('CLUSTER_URL'),
    userKeypair: requiredEnv('USER_KEYPAIR'),
    groupPk: requiredEnv('GROUP_PK'),
    mangoAccountPk: requiredEnv('MANGO_ACCOUNT_PK'),
    executionQueuePk: process.env.EXECUTION_QUEUE_PK,
    programId: process.env.PROGRAM_ID,
  });
  const relayer = new ContinuumRelayerClient(requiredEnv('RELAYER_ADDR'));
  const harnessUrl = process.env.HARNESS_URL;
  const harness = harnessUrl ? new ContinuumHarnessClient(harnessUrl) : null;
  const fairPriceProvider = new CoinGeckoFairPriceProvider(
    process.env.COINGECKO_ASSET_ID || 'solana',
    process.env.COINGECKO_VS_CURRENCY || 'usd',
    Number(process.env.COINGECKO_REFRESH_MS || '10000'),
  );
  const bot = new RelayerPerpQuoterBot(
    context,
    relayer,
    harness,
    () => fairPriceProvider.get(),
    {
      marketIndex: Number(process.env.PERP_MARKET_INDEX || '0'),
      side: parseSide(process.env.BOT_SIDE || 'bid'),
      spreadBps: Number(process.env.BOT_SPREAD_BPS || '20'),
      size: Number(process.env.BOT_SIZE || '0.01'),
      intervalMs: Number(process.env.BOT_INTERVAL_MS || '2000'),
      maxFeeLamports:
        process.env.BOT_MAX_FEE_LAMPORTS ||
        process.env.RELAYER_MAX_FEE_LAMPORTS ||
        'AUTO',
      log: (message, fields) => {
        const event = {
          ts: new Date().toISOString(),
          message,
          ...(fields || {}),
        };
        process.stdout.write(`${JSON.stringify(event)}\n`);
      },
    },
  );

  const shutdown = () => {
    bot.stop();
    relayer.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.run();
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack || err.message : `${err}`;
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
