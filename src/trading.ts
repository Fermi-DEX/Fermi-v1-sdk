import {
  randomBytes,
} from 'crypto';
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
  buildPerpUserIntentMessageV2,
  encodePerpCancelAllOrdersQueuePayload,
  encodePerpCancelOrderByClientOrderIdQueuePayload,
  encodePerpPlaceOrderV2QueuePayload,
  findExecutionQueueAuthorityStatePda,
  findExecutionQueueV5DirectPda,
  findExecutionQueueV5Pda,
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
  clientOrderId?: number;
  orderType?: PerpOrderType;
  selfTradeBehavior?: PerpSelfTradeBehavior;
  reduceOnly?: boolean;
  expiryTimestamp?: number;
  limit?: number;
  minExecuteSlot?: bigint;
  expiresAtSlot?: bigint;
  baseFee?: string;
};

export type SubmitPerpCancelByClientIdParams = {
  marketIndex: number;
  clientOrderId: number;
  minExecuteSlot?: bigint;
  expiresAtSlot?: bigint;
  baseFee?: string;
};

export type SubmitPerpCancelAllParams = {
  marketIndex: number;
  limit?: number;
  minExecuteSlot?: bigint;
  expiresAtSlot?: bigint;
  baseFee?: string;
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
}): Promise<{
  remainingAccounts: AccountMeta[];
  userIntentMessage: Buffer;
  userSignature: Uint8Array;
}> {
  const remainingAccounts = await buildCanonicalPerpRemainingAccounts(
    params.context,
    params.marketIndex,
  );
  const { userIntentMessage } = buildPerpUserIntentMessageV2({
    group: params.context.group.publicKey,
    mangoAccount: params.context.mangoAccount.publicKey,
    userOwner: params.context.user.publicKey,
    marketIndex: params.marketIndex,
    payload: params.payload,
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
    nonce:
      params.nonce ??
      BigInt(`0x${randomBytes(8).toString('hex')}`),
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
    clientOrderId: params.clientOrderId ?? Date.now(),
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
  });

  return await relayer.submitIntent({
    group: context.group.publicKey.toBase58(),
    execution_queue: context.executionQueuePk.toBase58(),
    market: `${params.marketIndex}`,
    payload,
    remaining_accounts: signed.remainingAccounts.map(toRelayerAccountMeta),
    min_execute_slot: `${params.minExecuteSlot ?? 0n}`,
    expires_at_slot: `${params.expiresAtSlot ?? 0n}`,
    user_owner: context.user.publicKey.toBase58(),
    mango_account: context.mangoAccount.publicKey.toBase58(),
    user_signature: Buffer.from(signed.userSignature),
    base_fee: params.baseFee,
    intent_version: 2,
    target_kind: UserIntentTargetKind.PerpMarket,
    target_index: params.marketIndex,
  });
}

export async function submitPerpOrderDirect(
  context: MangoContext,
  params: SubmitPerpOrderParams & DirectSubmitOptions,
): Promise<DirectIntentSubmitResult> {
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
    clientOrderId: params.clientOrderId ?? Date.now(),
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
  const payload = encodePerpCancelOrderByClientOrderIdQueuePayload({
    clientOrderId: BigInt(params.clientOrderId),
  });
  const signed = await buildPerpIntentAuth({
    context,
    marketIndex: params.marketIndex,
    payload,
  });

  return await relayer.submitIntent({
    group: context.group.publicKey.toBase58(),
    execution_queue: context.executionQueuePk.toBase58(),
    market: `${params.marketIndex}`,
    payload,
    remaining_accounts: signed.remainingAccounts.map(toRelayerAccountMeta),
    min_execute_slot: `${params.minExecuteSlot ?? 0n}`,
    expires_at_slot: `${params.expiresAtSlot ?? 0n}`,
    user_owner: context.user.publicKey.toBase58(),
    mango_account: context.mangoAccount.publicKey.toBase58(),
    user_signature: Buffer.from(signed.userSignature),
    base_fee: params.baseFee,
    intent_version: 2,
    target_kind: UserIntentTargetKind.PerpMarket,
    target_index: params.marketIndex,
  });
}

export async function cancelPerpOrderByClientIdDirect(
  context: MangoContext,
  params: SubmitPerpCancelByClientIdParams & DirectSubmitOptions,
): Promise<DirectIntentSubmitResult> {
  const payload = encodePerpCancelOrderByClientOrderIdQueuePayload({
    clientOrderId: BigInt(params.clientOrderId),
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
  const payload = encodePerpCancelAllOrdersQueuePayload({
    limit: params.limit ?? 255,
  });
  const signed = await buildPerpIntentAuth({
    context,
    marketIndex: params.marketIndex,
    payload,
  });

  return await relayer.submitIntent({
    group: context.group.publicKey.toBase58(),
    execution_queue: context.executionQueuePk.toBase58(),
    market: `${params.marketIndex}`,
    payload,
    remaining_accounts: signed.remainingAccounts.map(toRelayerAccountMeta),
    min_execute_slot: `${params.minExecuteSlot ?? 0n}`,
    expires_at_slot: `${params.expiresAtSlot ?? 0n}`,
    user_owner: context.user.publicKey.toBase58(),
    mango_account: context.mangoAccount.publicKey.toBase58(),
    user_signature: Buffer.from(signed.userSignature),
    base_fee: params.baseFee,
    intent_version: 2,
    target_kind: UserIntentTargetKind.PerpMarket,
    target_index: params.marketIndex,
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
