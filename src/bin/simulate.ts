#!/usr/bin/env node

import 'dotenv/config';
import { ContinuumHarnessClient, SimulateResponse } from '../harness';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length ? value : undefined;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtRatio(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return `${n.toFixed(2)}%`;
}

async function main(): Promise<void> {
  const harnessUrl = requiredEnv('HARNESS_URL');
  const owner = requiredEnv('SIMULATE_OWNER');
  const mangoAccount = optionalEnv('SIMULATE_MANGO_ACCOUNT');
  const market = optionalEnv('SIMULATE_MARKET') || 'SOL-PERP';
  const side = (optionalEnv('SIMULATE_SIDE') || 'buy').toLowerCase();
  const quantity = Number(requiredEnv('SIMULATE_QUANTITY'));
  const priceRaw = optionalEnv('SIMULATE_PRICE');
  const orderType = optionalEnv('SIMULATE_ORDER_TYPE') || 'limit';
  const reduceOnly = optionalEnv('SIMULATE_REDUCE_ONLY') === 'true';

  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`SIMULATE_QUANTITY must be a positive number, got ${quantity}`);
  }
  if (side !== 'buy' && side !== 'sell') {
    throw new Error(`SIMULATE_SIDE must be 'buy' or 'sell', got ${side}`);
  }

  const harness = new ContinuumHarnessClient(harnessUrl);

  // Warm the cache. /simulate is cache-only; without a warm (or a recent
  // /state/users/<owner> hit) it returns 425.
  const warm = await harness.simulateWarm({ owner, mango_account: mangoAccount });
  console.log(
    `warm: owner=${warm.owner} accounts=${warm.cached_mango_accounts.length} load=${warm.load_ms}ms ttl=${warm.cache_ttl_ms}ms`,
  );

  let result: SimulateResponse;
  try {
    result = await harness.simulate({
      owner,
      mango_account: mangoAccount,
      trade: {
        kind: 'perp_place_order',
        market,
        side: side as 'buy' | 'sell',
        quantity,
        price: priceRaw !== undefined ? Number(priceRaw) : null,
        order_type: orderType as
          | 'limit'
          | 'market'
          | 'ioc'
          | 'postonly'
          | 'postonlyslide',
        reduce_only: reduceOnly,
      },
    });
  } catch (err: any) {
    console.error('simulate failed:', err?.body || err?.message || err);
    process.exit(1);
  }

  const t = result.trade;
  console.log('');
  console.log(`trade: ${t.side.toUpperCase()} ${t.quantity_ui} ${t.market} @ ${fmtUsd(t.price_ui)} (${t.price_source}, ${t.order_type})`);
  console.log(`account: ${result.mango_account}`);
  console.log(
    `freshness: cached_age=${result.cached_age_ms}ms snapshot_age=${result.snapshot_age_ms}ms overlay=${result.optimistic_overlay_applied} compute=${result.compute_ms}ms`,
  );
  console.log('');
  console.log('              before              after               delta');
  const rows: Array<[string, number, number]> = [
    ['equity        ', result.before.equity_ui_quote, result.after.equity_ui_quote],
    ['init_health   ', result.before.init_health_ui_quote, result.after.init_health_ui_quote],
    ['maint_health  ', result.before.maint_health_ui_quote, result.after.maint_health_ui_quote],
  ];
  for (const [label, b, a] of rows) {
    const d = a - b;
    console.log(
      `${label} ${fmtUsd(b).padStart(16)}    ${fmtUsd(a).padStart(16)}    ${(d >= 0 ? '+' : '') + fmtUsd(d).padStart(15)}`,
    );
  }
  console.log(
    `init_ratio     ${fmtRatio(result.before.init_health_ratio).padStart(16)}    ${fmtRatio(result.after.init_health_ratio).padStart(16)}`,
  );
  console.log(
    `maint_ratio    ${fmtRatio(result.before.maint_health_ratio).padStart(16)}    ${fmtRatio(result.after.maint_health_ratio).padStart(16)}`,
  );
  console.log('');
  if (result.would_reject) {
    console.log(`REJECT — reasons: ${result.reject_reasons.join(', ')}`);
    process.exit(2);
  }
  console.log('OK — trade fits available margin');
  if (result.warnings.length) {
    console.log(`warnings: ${result.warnings.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err?.body || err?.message || err);
  process.exit(1);
});
