#!/usr/bin/env node

import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';
import { createMangoContext } from '../context';
import {
  apiKeyFromEnv,
  clusterFromEnv,
  clusterUrlFromEnv,
  gatewayGrpcAddrFromEnv,
  gatewayUrlFromEnv,
  groupPkFromEnv,
  requiredEnv,
} from './env';

function fmt(n: unknown): string {
  if (typeof n === 'number' && Number.isFinite(n)) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
  }
  return String(n);
}

function method<T>(target: unknown, name: string): ((...args: unknown[]) => T) | undefined {
  const candidate = (target as Record<string, unknown>)[name];
  return typeof candidate === 'function'
    ? (candidate.bind(target) as (...args: unknown[]) => T)
    : undefined;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof PublicKey) {
    return value.toBase58();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toString?: unknown }).toString === 'function' &&
    (value as { constructor?: { name?: string } }).constructor?.name === 'BN'
  ) {
    return String(value);
  }
  return value;
}

async function main(): Promise<void> {
  const context = await createMangoContext({
    cluster: clusterFromEnv(),
    clusterUrl: clusterUrlFromEnv(),
    deployment: process.env.CONTINUUM_DEPLOYMENT,
    gatewayUrl: gatewayUrlFromEnv(),
    gatewayGrpcAddr: gatewayGrpcAddrFromEnv(),
    apiKey: apiKeyFromEnv(),
    userKeypair: requiredEnv('USER_KEYPAIR'),
    groupPk: groupPkFromEnv(),
    mangoAccountPk: requiredEnv('MANGO_ACCOUNT_PK'),
    programId: process.env.PROGRAM_ID,
  });
  const account = await context.client.getMangoAccount(
    context.mangoAccount.publicKey,
  );

  console.log(`on-chain portfolio for ${context.user.publicKey.toBase58()}`);
  console.log(`mango_account: ${account.publicKey.toBase58()}`);
  console.log(`group: ${context.group.publicKey.toBase58()}`);

  const getHealthRatioUi = method<number>(account, 'getHealthRatioUi');
  const getEquityUi = method<number>(account, 'getEquityUi');
  if (getEquityUi || getHealthRatioUi) {
    console.log('');
    console.log('margin');
    console.log('------');
    if (getEquityUi) {
      console.log(`  equity_ui      ${fmt(getEquityUi(context.group))}`);
    }
    // Upstream Mango exports HealthType in some versions, but this CLI avoids
    // importing it so it stays compatible across SDK package cuts.
  }

  const tokensActive =
    method<unknown[]>(account, 'tokensActive')?.() ??
    (account.tokens as unknown[]).filter(
      (token) =>
        method<boolean>(token, 'isActive')?.() ??
        ((token as { tokenIndex?: number }).tokenIndex !== 65535),
    );
  console.log('');
  console.log('tokens');
  console.log('------');
  if (!tokensActive.length) {
    console.log('  (none)');
  }
  for (const token of tokensActive) {
    const tokenIndex = (token as { tokenIndex?: number }).tokenIndex;
    if (tokenIndex === undefined) {
      continue;
    }
    const bank = context.group.getFirstBankByTokenIndex(tokenIndex as never);
    const balanceUi =
      method<number>(token, 'balanceUi')?.(bank) ??
      method<number>(account, 'getTokenBalanceUi')?.(bank);
    console.log(
      `  ${String(bank.name || tokenIndex).padEnd(12)} token_index=${tokenIndex} balance_ui=${fmt(balanceUi ?? 'unknown')}`,
    );
  }

  const perpActive =
    method<unknown[]>(account, 'perpActive')?.() ??
    (account.perps as unknown[]).filter((perp) => method<boolean>(perp, 'isActive')?.() ?? false);
  console.log('');
  console.log('perps');
  console.log('-----');
  if (!perpActive.length) {
    console.log('  (none)');
  }
  for (const perp of perpActive) {
    const marketIndex = (perp as { marketIndex?: number }).marketIndex;
    if (marketIndex === undefined) {
      continue;
    }
    const market = context.group.getPerpMarketByMarketIndex(marketIndex as never);
    const baseLots = (perp as { basePositionLots?: unknown }).basePositionLots;
    const bidsLots = (perp as { bidsBaseLots?: unknown }).bidsBaseLots;
    const asksLots = (perp as { asksBaseLots?: unknown }).asksBaseLots;
    const baseUi =
      baseLots !== undefined
        ? method<number>(market, 'baseLotsToUi')?.(baseLots)
        : undefined;
    const bidsUi =
      bidsLots !== undefined
        ? method<number>(market, 'baseLotsToUi')?.(bidsLots)
        : undefined;
    const asksUi =
      asksLots !== undefined
        ? method<number>(market, 'baseLotsToUi')?.(asksLots)
        : undefined;
    console.log(
      `  ${String(market.name || marketIndex).padEnd(12)} base=${fmt(baseUi ?? baseLots ?? 0)} bids=${fmt(bidsUi ?? bidsLots ?? 0)} asks=${fmt(asksUi ?? asksLots ?? 0)}`,
    );
  }

  const openOrders = method<unknown[]>(account, 'perpOrdersActive')?.() ?? [];
  if (openOrders.length) {
    console.log('');
    console.log(`perp_open_orders: ${openOrders.length}`);
    for (const order of openOrders) {
      console.log(`  ${JSON.stringify(order, jsonReplacer)}`);
    }
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack || err.message : `${err}`;
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
