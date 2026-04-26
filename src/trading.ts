import { randomBytes } from 'crypto';
import {
  AccountMeta,
  SendOptions,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  I64_MAX_BN,
  PerpMarketIndex,
  PerpOrderSide,
  PerpOrderType,
  PerpSelfTradeBehavior,
} from '@blockworks-foundation/mango-v4';
import { MangoContext, buildCanonicalPerpRemainingAccounts } from './context';
import {
  BigNumberish,
  buildExecutionQueueV5EnqueueDirectWithIntentIxs,
  buildPerpUserIntentMessageV3,
  encodePerpCancelAllOrdersQueuePayload,
  encodePerpCancelOrderByClientOrderIdQueuePayload,
  encodePerpPlaceOrderV2QueuePayload,
  findExecutionQueueAuthorityStatePda,
  findExecutionQueueV5DirectPda,
  findExecutionQueueV5Pda,
  hashExecutionQueueAccountsForCtmEnqueue,
  signIntentMessage,
  UserIntentTargetKind,
} from './intents';
import {
  ContinuumRelayerClient,
  SubmitIntentResponse,
  toRelayerAccountMeta,
} from './relayerClient';

export type SubmitPerpOrderParams = {
  marketIndex: number;
  side: PerpOrderSide;
  price: number;
  quantity: number;
  maxQuoteQuantity?: number;
  clientOrderId?: BigNumberish;
  intentClientOrderId?: BigNumberish;
  orderType?: PerpOrderType;
  selfTradeBehavior?: PerpSelfTradeBehavior;
  reduceOnly?: boolean;
  expiryTimestamp?: number;
  limit?: number;
  minExecuteSlot?: bigint;
  expiresAtSlot?: bigint;
  baseFee?: string;
  maxFeeLamports?: string;
};

export type SubmitPerpCancelByClientIdParams = {
  marketIndex: number;
  clientOrderId: BigNumberish;
  intentClientOrderId?: BigNumberish;
  minExecuteSlot?: bigint;
  expiresAtSlot?: bigint;
  baseFee?: string;
  maxFeeLamports?: string;
};

export type SubmitPerpCancelAllParams = {
  marketIndex: number;
  limit?: number;
  intentClientOrderId?: BigNumberish;
  minExecuteSlot?: bigint;
  expiresAtSlot?: bigint;
  baseFee?: string;
  maxFeeLamports?: string;
};

export type DirectIntentSubmitResult = {
  txSignature: string;
  directIntentMessage: Buffer;
  userIntentMessage: Buffer;
};

export type DirectSubmitOptions = {
  sendOptions?: SendOptions;
  nonce?: BigNumberish;
};

const U64_MAX = (1n << 64n) - 1n;

function toBigInt(value: BigNumberish): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error('number inputs must be safe integers');
  }
  return BigInt(value);
}

function u64String(value: BigNumberish): string {
  const parsed = toBigInt(value);
  if (parsed < 0 || parsed > U64_MAX) {
    throw new Error(`u64 out of range: ${parsed.toString()}`);
  }
  return parsed.toString();
}

function randomU64(): bigint {
  return BigInt(`0x${randomBytes(8).toString('hex')}`);
}

function executionQueueForMarket(context: MangoContext, marketIndex: number) {
  return findExecutionQueueV5Pda(
    context.programId,
    context.group.publicKey,
    marketIndex,
  );
}

async function maybeRegisterDirectLane(context: MangoContext): Promise<void> {
  if (!context.harnessBaseUrl) {
    return;
  }
  const response = await fetch(
    `${context.harnessBaseUrl.replace(/\/+$/, '')}/admin/register-lane`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: context.user.publicKey.toBase58() }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `lane registration failed (${response.status}): ${body || response.statusText}`,
    );
  }
}

async function buildPerpIntentAuth(params: {
  context: MangoContext;
  marketIndex: number;
  payload: Uint8Array;
  executionQueue: AccountMeta['pubkey'];
  minExecuteSlot?: bigint;
  expiresAtSlot?: bigint;
  clientOrderId: BigNumberish;
}): Promise<{
  remainingAccounts: AccountMeta[];
  userIntentMessage: Buffer;
  userSignature: Uint8Array;
}> {
  const remainingAccounts = await buildCanonicalPerpRemainingAccounts(
    params.context,
    params.marketIndex,
  );
  const accountsHash = hashExecutionQueueAccountsForCtmEnqueue(
    params.context.group.publicKey,
    params.executionQueue,
    remainingAccounts,
  );
  const { userIntentMessage } = buildPerpUserIntentMessageV3({
    group: params.context.group.publicKey,
    mangoAccount: params.context.mangoAccount.publicKey,
    userOwner: params.context.user.publicKey,
    marketIndex: params.marketIndex,
    payload: params.payload,
    accountsHash,
    minExecuteSlot: params.minExecuteSlot ?? 0n,
    expiresAtSlot: params.expiresAtSlot ?? 0n,
    clientOrderId: params.clientOrderId,
  });
  const userSignature = signIntentMessage(
    params.context.user.secretKey,
    userIntentMessage,
  );

  return {
    remainingAccounts,
    userIntentMessage,
    userSignature,
  };
}

async function submitPerpIntentDirect(params: {
  context: MangoContext;
  marketIndex: number;
  payload: Uint8Array;
  minExecuteSlot?: bigint;
  expiresAtSlot?: bigint;
  nonce?: BigNumberish;
  sendOptions?: SendOptions;
}): Promise<DirectIntentSubmitResult> {
  if ((params.minExecuteSlot ?? 0n) !== 0n) {
    throw new Error(
      'v5 direct enqueue does not support minExecuteSlot; use expiresAtSlot only',
    );
  }
  await maybeRegisterDirectLane(params.context);
  const remainingAccounts = await buildCanonicalPerpRemainingAccounts(
    params.context,
    params.marketIndex,
  );
  const built = buildExecutionQueueV5EnqueueDirectWithIntentIxs({
    programId: params.context.programId,
    group: params.context.group.publicKey,
    authorityState: findExecutionQueueAuthorityStatePda(
      params.context.programId,
      params.context.group.publicKey,
    ),
    queue: findExecutionQueueV5Pda(
      params.context.programId,
      params.context.group.publicKey,
      params.marketIndex,
    ),
    directPool: findExecutionQueueV5DirectPda(
      params.context.programId,
      params.context.group.publicKey,
      params.marketIndex,
    ),
    marketIndex: params.marketIndex,
    remainingAccounts,
    payload: params.payload,
    expiresAtSlot: params.expiresAtSlot ?? 0n,
    nonce: params.nonce ?? randomU64(),
    userOwner: params.context.user.publicKey,
    mangoAccount: params.context.mangoAccount.publicKey,
    userSigner: { kind: 'keypair', privateKey: params.context.user.secretKey },
  });

  const tx = new Transaction();
  tx.add(...built.instructions);
  const txSignature = await sendAndConfirmTransaction(
    params.context.connection,
    tx,
    [params.context.user],
    params.sendOptions,
  );

  return {
    txSignature,
    directIntentMessage: built.directIntentMessage,
    userIntentMessage: built.directIntentMessage,
  };
}

export async function submitPerpOrderViaRelayer(
  relayer: ContinuumRelayerClient,
  context: MangoContext,
  params: SubmitPerpOrderParams,
): Promise<SubmitIntentResponse> {
  const clientOrderId = params.clientOrderId ?? randomU64();
  const intentClientOrderId = params.intentClientOrderId ?? clientOrderId;
  const executionQueue = executionQueueForMarket(context, params.marketIndex);
  const perpMarket = context.group.getPerpMarketByMarketIndex(
    params.marketIndex as PerpMarketIndex,
  );
  const payload = encodePerpPlaceOrderV2QueuePayload({
    side: params.side,
    priceLots: BigInt(perpMarket.uiPriceToLots(params.price).toString()),
    maxBaseLots: BigInt(perpMarket.uiBaseToLots(params.quantity).toString()),
    maxQuoteLots: params.maxQuoteQuantity
      ? BigInt(perpMarket.uiQuoteToLots(params.maxQuoteQuantity).toString())
      : BigInt(I64_MAX_BN.toString()),
    clientOrderId,
    orderType: params.orderType ?? PerpOrderType.postOnlySlide,
    selfTradeBehavior:
      params.selfTradeBehavior ?? PerpSelfTradeBehavior.decrementTake,
    reduceOnly: params.reduceOnly ?? false,
    expiryTimestamp: params.expiryTimestamp ?? 0,
    limit: params.limit ?? 10,
  });
  const signed = await buildPerpIntentAuth({
    context,
    marketIndex: params.marketIndex,
    payload,
    executionQueue,
    minExecuteSlot: params.minExecuteSlot,
    expiresAtSlot: params.expiresAtSlot,
    clientOrderId: intentClientOrderId,
  });

  return await relayer.submitIntent({
    group: context.group.publicKey.toBase58(),
    execution_queue: executionQueue.toBase58(),
    market: `${params.marketIndex}`,
    payload,
    remaining_accounts: signed.remainingAccounts.map(toRelayerAccountMeta),
    min_execute_slot: `${params.minExecuteSlot ?? 0n}`,
    expires_at_slot: `${params.expiresAtSlot ?? 0n}`,
    user_owner: context.user.publicKey.toBase58(),
    mango_account: context.mangoAccount.publicKey.toBase58(),
    user_signature: Buffer.from(signed.userSignature),
    base_fee: params.baseFee,
    max_fee_lamports: params.maxFeeLamports ?? params.baseFee,
    intent_version: 2,
    target_kind: UserIntentTargetKind.PerpMarket,
    target_index: params.marketIndex,
    client_order_id: u64String(intentClientOrderId),
  });
}

export async function submitPerpOrderDirect(
  context: MangoContext,
  params: SubmitPerpOrderParams & DirectSubmitOptions,
): Promise<DirectIntentSubmitResult> {
  const clientOrderId = params.clientOrderId ?? randomU64();
  const perpMarket = context.group.getPerpMarketByMarketIndex(
    params.marketIndex as PerpMarketIndex,
  );
  const payload = encodePerpPlaceOrderV2QueuePayload({
    side: params.side,
    priceLots: BigInt(perpMarket.uiPriceToLots(params.price).toString()),
    maxBaseLots: BigInt(perpMarket.uiBaseToLots(params.quantity).toString()),
    maxQuoteLots: params.maxQuoteQuantity
      ? BigInt(perpMarket.uiQuoteToLots(params.maxQuoteQuantity).toString())
      : BigInt(I64_MAX_BN.toString()),
    clientOrderId,
    orderType: params.orderType ?? PerpOrderType.postOnlySlide,
    selfTradeBehavior:
      params.selfTradeBehavior ?? PerpSelfTradeBehavior.decrementTake,
    reduceOnly: params.reduceOnly ?? false,
    expiryTimestamp: params.expiryTimestamp ?? 0,
    limit: params.limit ?? 10,
  });

  return await submitPerpIntentDirect({
    context,
    marketIndex: params.marketIndex,
    payload,
    minExecuteSlot: params.minExecuteSlot,
    expiresAtSlot: params.expiresAtSlot,
    nonce: params.nonce,
    sendOptions: params.sendOptions,
  });
}

export async function cancelPerpOrderByClientIdViaRelayer(
  relayer: ContinuumRelayerClient,
  context: MangoContext,
  params: SubmitPerpCancelByClientIdParams,
): Promise<SubmitIntentResponse> {
  const intentClientOrderId = params.intentClientOrderId ?? randomU64();
  const executionQueue = executionQueueForMarket(context, params.marketIndex);
  const payload = encodePerpCancelOrderByClientOrderIdQueuePayload({
    clientOrderId: params.clientOrderId,
  });
  const signed = await buildPerpIntentAuth({
    context,
    marketIndex: params.marketIndex,
    payload,
    executionQueue,
    minExecuteSlot: params.minExecuteSlot,
    expiresAtSlot: params.expiresAtSlot,
    clientOrderId: intentClientOrderId,
  });

  return await relayer.submitIntent({
    group: context.group.publicKey.toBase58(),
    execution_queue: executionQueue.toBase58(),
    market: `${params.marketIndex}`,
    payload,
    remaining_accounts: signed.remainingAccounts.map(toRelayerAccountMeta),
    min_execute_slot: `${params.minExecuteSlot ?? 0n}`,
    expires_at_slot: `${params.expiresAtSlot ?? 0n}`,
    user_owner: context.user.publicKey.toBase58(),
    mango_account: context.mangoAccount.publicKey.toBase58(),
    user_signature: Buffer.from(signed.userSignature),
    base_fee: params.baseFee,
    max_fee_lamports: params.maxFeeLamports ?? params.baseFee,
    intent_version: 2,
    target_kind: UserIntentTargetKind.PerpMarket,
    target_index: params.marketIndex,
    client_order_id: u64String(intentClientOrderId),
  });
}

export async function cancelPerpOrderByClientIdDirect(
  context: MangoContext,
  params: SubmitPerpCancelByClientIdParams & DirectSubmitOptions,
): Promise<DirectIntentSubmitResult> {
  const payload = encodePerpCancelOrderByClientOrderIdQueuePayload({
    clientOrderId: params.clientOrderId,
  });
  return await submitPerpIntentDirect({
    context,
    marketIndex: params.marketIndex,
    payload,
    minExecuteSlot: params.minExecuteSlot,
    expiresAtSlot: params.expiresAtSlot,
    nonce: params.nonce,
    sendOptions: params.sendOptions,
  });
}

export async function cancelAllPerpOrdersViaRelayer(
  relayer: ContinuumRelayerClient,
  context: MangoContext,
  params: SubmitPerpCancelAllParams,
): Promise<SubmitIntentResponse> {
  const intentClientOrderId = params.intentClientOrderId ?? randomU64();
  const executionQueue = executionQueueForMarket(context, params.marketIndex);
  const payload = encodePerpCancelAllOrdersQueuePayload({
    limit: params.limit ?? 255,
  });
  const signed = await buildPerpIntentAuth({
    context,
    marketIndex: params.marketIndex,
    payload,
    executionQueue,
    minExecuteSlot: params.minExecuteSlot,
    expiresAtSlot: params.expiresAtSlot,
    clientOrderId: intentClientOrderId,
  });

  return await relayer.submitIntent({
    group: context.group.publicKey.toBase58(),
    execution_queue: executionQueue.toBase58(),
    market: `${params.marketIndex}`,
    payload,
    remaining_accounts: signed.remainingAccounts.map(toRelayerAccountMeta),
    min_execute_slot: `${params.minExecuteSlot ?? 0n}`,
    expires_at_slot: `${params.expiresAtSlot ?? 0n}`,
    user_owner: context.user.publicKey.toBase58(),
    mango_account: context.mangoAccount.publicKey.toBase58(),
    user_signature: Buffer.from(signed.userSignature),
    base_fee: params.baseFee,
    max_fee_lamports: params.maxFeeLamports ?? params.baseFee,
    intent_version: 2,
    target_kind: UserIntentTargetKind.PerpMarket,
    target_index: params.marketIndex,
    client_order_id: u64String(intentClientOrderId),
  });
}

export async function cancelAllPerpOrdersDirect(
  context: MangoContext,
  params: SubmitPerpCancelAllParams & DirectSubmitOptions,
): Promise<DirectIntentSubmitResult> {
  const payload = encodePerpCancelAllOrdersQueuePayload({
    limit: params.limit ?? 255,
  });
  return await submitPerpIntentDirect({
    context,
    marketIndex: params.marketIndex,
    payload,
    minExecuteSlot: params.minExecuteSlot,
    expiresAtSlot: params.expiresAtSlot,
    nonce: params.nonce,
    sendOptions: params.sendOptions,
  });
}
