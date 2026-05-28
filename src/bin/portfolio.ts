#!/usr/bin/env node

import 'dotenv/config';
import { ContinuumHarnessClient, QueueView } from '../harness';
import { apiKeyFromEnv, gatewayUrlFromEnv, requiredEnv } from './env';

function fmtUsd(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pickN(o: any, ...keys: string[]): number | undefined {
  for (const k of keys) {
    if (o && o[k] !== undefined && o[k] !== null) {
      const n = Number(o[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const owner = requiredEnv('OWNER');
  const view = ((process.env.VIEW || 'optimistic') as QueueView);

  const harness = new ContinuumHarnessClient({
    gatewayUrl: gatewayUrlFromEnv(),
    apiKey: apiKeyFromEnv(),
  });
  const [user, balances] = await Promise.all([
    harness.getUserState(owner, view),
    harness.getBalances(owner, view).catch(() => null),
  ]);

  console.log(`portfolio for ${owner}  (view=${view})`);
  console.log('');
  console.log(`mango_accounts: ${(user.mango_accounts || []).join(', ') || '(none)'}`);

  const ms: any = user.margin_summary || (balances as any)?.margin_summary || {};
  const equity = pickN(ms, 'equity_ui_quote', 'total_equity_ui_quote', 'equity');
  const initH = pickN(ms, 'init_health_ui_quote', 'total_init_health_ui_quote');
  const maintH = pickN(ms, 'maint_health_ui_quote', 'total_maint_health_ui_quote');
  const initR = pickN(ms, 'init_health_ratio', 'total_init_health_ratio');
  const maintR = pickN(ms, 'maint_health_ratio', 'total_maint_health_ratio');

  console.log('');
  console.log('margin');
  console.log('------');
  if (equity !== undefined) console.log(`  equity         ${fmtUsd(equity)}`);
  if (initH !== undefined) console.log(`  init_health    ${fmtUsd(initH)}` + (initR !== undefined ? `   (${initR.toFixed(2)}%)` : ''));
  if (maintH !== undefined) console.log(`  maint_health   ${fmtUsd(maintH)}` + (maintR !== undefined ? `   (${maintR.toFixed(2)}%)` : ''));
  if (equity === undefined && initH === undefined) {
    console.log('  (no margin_summary data — try VIEW=confirmed for an on-chain enriched read)');
  }

  const positions = user.per_market || [];
  if (positions.length) {
    console.log('');
    console.log('per_market');
    console.log('----------');
    console.log('  market           base_pos     quote_pos      bids        asks');
    for (const p of positions as any[]) {
      const market = String(p.market || '?').padEnd(15);
      const base = String(p.base_position_lots ?? '0').padStart(11);
      const quote = String(p.quote_position_native ?? '0').padStart(13);
      const bids = String(p.open_order_base_lots_bid ?? '0').padStart(10);
      const asks = String(p.open_order_base_lots_ask ?? '0').padStart(10);
      console.log(`  ${market} ${base}  ${quote}  ${bids}  ${asks}`);
    }
  }

  const orders = user.open_orders || [];
  if (orders.length) {
    console.log('');
    console.log(`open_orders (${orders.length})`);
    console.log('------------');
    for (const o of orders) {
      const m = String(o.market || '?').padEnd(15);
      const side = String(o.side || '?').padEnd(4);
      const price = String(o.price_lots || '?').padStart(10);
      const base = String(o.base_lots || '?').padStart(10);
      const cli = o.client_order_id ? `coid=${o.client_order_id}` : '';
      console.log(`  ${m} ${side} ${price} x ${base}  ${cli}`);
    }
  }
}

main().catch((err) => {
  console.error(err?.body || err?.message || err);
  process.exit(1);
});
