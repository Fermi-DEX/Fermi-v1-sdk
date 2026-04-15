import fs from 'fs';
import {
  PerpMarketIndex,
  PerpOrderSide,
  PerpOrderType,
} from '@blockworks-foundation/mango-v4';
import { createMangoContext } from './src/context';
import {
  cancelAllPerpOrdersDirect,
  submitPerpOrderDirect,
} from './src/trading';

type E2EConfig = {
  cluster: 'devnet' | 'mainnet-beta' | 'localnet';
  clusterUrl: string;
  programId: string;
  group: string;
  executionQueue: string;
  perpMarketIndex: number;
  maker: {
    keypairPath: string;
    mangoAccount: string;
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQueueDrain(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/state/queue/0?view=confirmed`);
    if (!response.ok) {
      throw new Error(`queue state request failed: ${response.status}`);
    }
    const queueState = (await response.json()) as { pending_count: number };
    if (queueState.pending_count === 0) {
      return;
    }
    await sleep(500);
  }
  throw new Error('timed out waiting for confirmed queue to drain');
}

async function loadOpenOrderCount(
  context: Awaited<ReturnType<typeof createMangoContext>>,
  marketIndex: number,
): Promise<number> {
  const fresh = await context.client.getMangoAccount(context.mangoAccount.publicKey);
  const orders = await fresh.loadPerpOpenOrdersForMarket(
    context.client,
    context.group,
    marketIndex as PerpMarketIndex,
    true,
  );
  return orders.length;
}

async function waitForOpenOrderCount(
  context: Awaited<ReturnType<typeof createMangoContext>>,
  marketIndex: number,
  expected: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await loadOpenOrderCount(context, marketIndex);
    if (count === expected) {
      return count;
    }
    await sleep(500);
  }
  return await loadOpenOrderCount(context, marketIndex);
}

async function main(): Promise<void> {
  const configPath =
    process.env.E2E_OUTPUT_CONFIG_PATH ??
    '/tmp/v2-intent-localnet/execution-queue-e2e-9301.json';
  const harnessBaseUrl =
    process.env.HARNESS_BASE_URL ?? 'http://127.0.0.1:19091';
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as E2EConfig;

  const context = await createMangoContext({
    cluster: 'devnet',
    clusterUrl: config.clusterUrl,
    harnessBaseUrl,
    userKeypair: config.maker.keypairPath,
    groupPk: config.group,
    mangoAccountPk: config.maker.mangoAccount,
    executionQueuePk: config.executionQueue,
    programId: config.programId,
  });

  const marketIndex = config.perpMarketIndex;
  const baselineCount = await loadOpenOrderCount(context, marketIndex);
  const clientOrderId = Date.now();

  const place = await submitPerpOrderDirect(context, {
    marketIndex,
    side: PerpOrderSide.ask,
    price: 105,
    quantity: 0.2,
    orderType: PerpOrderType.postOnlySlide,
    clientOrderId,
    limit: 10,
  });

  await waitForQueueDrain(harnessBaseUrl, 30000);
  const placedCount = await waitForOpenOrderCount(
    context,
    marketIndex,
    baselineCount + 1,
    30000,
  );
  if (placedCount !== baselineCount + 1) {
    throw new Error(
      `expected open order count ${baselineCount + 1}, got ${placedCount}`,
    );
  }

  const cancel = await cancelAllPerpOrdersDirect(context, {
    marketIndex,
    limit: 10,
  });

  await waitForQueueDrain(harnessBaseUrl, 30000);
  const finalCount = await waitForOpenOrderCount(
    context,
    marketIndex,
    baselineCount,
    30000,
  );
  if (finalCount !== baselineCount) {
    throw new Error(
      `expected open order count ${baselineCount} after cancel, got ${finalCount}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        placeTx: place.txSignature,
        cancelTx: cancel.txSignature,
        baselineCount,
        placedCount,
        finalCount,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
