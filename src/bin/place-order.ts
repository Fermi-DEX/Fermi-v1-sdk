#!/usr/bin/env node

import 'dotenv/config';
import {
  PerpOrderSide,
  PerpOrderType,
  PerpSelfTradeBehavior,
} from '@blockworks-foundation/mango-v4';
import { createFermiV1Context } from '../context';
import { FermiV1RelayerClient } from '../relayerClient';
import { submitPerpOrderViaRelayer } from '../trading';
import {
  apiKeyFromEnv,
  clusterFromEnv,
  clusterUrlFromEnv,
  gatewayGrpcAddrFromEnv,
  gatewayUrlFromEnv,
  groupPkFromEnv,
  requiredEnv,
} from './env';

function optionalNumberEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`env var ${name} must be a finite number`);
  }
  return parsed;
}

function optionalBigIntEnv(name: string): bigint | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return undefined;
  }
  return BigInt(value);
}

function optionalU64Env(name: string): bigint | undefined {
  const parsed = optionalBigIntEnv(name);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed < 0n || parsed > (1n << 64n) - 1n) {
    throw new Error(`env var ${name} must fit in u64`);
  }
  return parsed;
}

function optionalBoolEnv(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return undefined;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`env var ${name} must be 'true' or 'false'`);
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
      throw new Error(`unsupported PERP_ORDER_SIDE: ${value}`);
  }
}

function parseOrderType(value: string): PerpOrderType {
  switch (value.toLowerCase()) {
    case 'limit':
      return PerpOrderType.limit;
    case 'ioc':
    case 'immediateorcancel':
      return PerpOrderType.immediateOrCancel;
    case 'postonly':
      return PerpOrderType.postOnly;
    case 'market':
      return PerpOrderType.market;
    case 'postonlyslide':
      return PerpOrderType.postOnlySlide;
    default:
      throw new Error(`unsupported PERP_ORDER_TYPE: ${value}`);
  }
}

function parseSelfTradeBehavior(value: string): PerpSelfTradeBehavior {
  switch (value.toLowerCase()) {
    case 'decrementtake':
      return PerpSelfTradeBehavior.decrementTake;
    case 'cancelprovide':
      return PerpSelfTradeBehavior.cancelProvide;
    case 'aborttransaction':
      return PerpSelfTradeBehavior.abortTransaction;
    default:
      throw new Error(`unsupported PERP_ORDER_SELF_TRADE_BEHAVIOR: ${value}`);
  }
}

async function main(): Promise<void> {
  const marketIndex = Number(process.env.PERP_ORDER_MARKET_INDEX || process.env.PERP_MARKET_INDEX || '0');
  if (!Number.isInteger(marketIndex) || marketIndex < 0) {
    throw new Error('PERP_ORDER_MARKET_INDEX must be a non-negative integer');
  }

  const apiKey = apiKeyFromEnv();
  const context = await createFermiV1Context({
    cluster: clusterFromEnv(),
    clusterUrl: clusterUrlFromEnv(),
    deployment: process.env.FERMI_DEPLOYMENT,
    gatewayUrl: gatewayUrlFromEnv(),
    gatewayGrpcAddr: gatewayGrpcAddrFromEnv(),
    apiKey,
    userKeypair: requiredEnv('USER_KEYPAIR'),
    groupPk: groupPkFromEnv(),
    fermiAccountPk: requiredEnv('FERMI_ACCOUNT_PK'),
    programId: process.env.PROGRAM_ID,
  });
  const relayer = new FermiV1RelayerClient({
    gatewayGrpcAddr: gatewayGrpcAddrFromEnv(),
    apiKey,
  });

  const clientOrderId =
    optionalU64Env('PERP_ORDER_CLIENT_ORDER_ID') ?? BigInt(Date.now());
  try {
    const result = await submitPerpOrderViaRelayer(relayer, context, {
      marketIndex,
      side: parseSide(process.env.PERP_ORDER_SIDE || 'bid'),
      price: Number(requiredEnv('PERP_ORDER_PRICE')),
      quantity: Number(requiredEnv('PERP_ORDER_QUANTITY')),
      maxQuoteQuantity: optionalNumberEnv('PERP_ORDER_MAX_QUOTE_QUANTITY'),
      clientOrderId,
      intentClientOrderId: optionalU64Env('PERP_INTENT_CLIENT_ORDER_ID'),
      orderType: parseOrderType(process.env.PERP_ORDER_TYPE || 'postOnlySlide'),
      selfTradeBehavior: parseSelfTradeBehavior(
        process.env.PERP_ORDER_SELF_TRADE_BEHAVIOR || 'decrementTake',
      ),
      reduceOnly: optionalBoolEnv('PERP_ORDER_REDUCE_ONLY') ?? false,
      expiryTimestamp: optionalNumberEnv('PERP_ORDER_EXPIRY_TIMESTAMP') ?? 0,
      limit: optionalNumberEnv('PERP_ORDER_MATCH_LIMIT') ?? 10,
      minExecuteSlot: optionalBigIntEnv('PERP_ORDER_MIN_EXECUTE_SLOT'),
      expiresAtSlot: optionalBigIntEnv('PERP_ORDER_EXPIRES_AT_SLOT'),
      maxFeeLamports:
        process.env.PERP_ORDER_MAX_FEE_LAMPORTS ||
        process.env.RELAYER_MAX_FEE_LAMPORTS ||
        'AUTO',
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          mode: 'relayer_commit_reveal',
          cluster: context.config.cluster,
          market_index: marketIndex,
          owner: context.user.publicKey.toBase58(),
          mango_account: context.fermiAccount.publicKey.toBase58(),
          client_order_id: clientOrderId.toString(),
          sequence: result.sequence,
          tx_signature: result.tx_signature,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    relayer.close();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack || err.message : `${err}`;
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
