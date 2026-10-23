import { createHash, randomBytes } from 'crypto';
import nacl from 'tweetnacl';
import { AccountMeta, PublicKey } from '@solana/web3.js';
import { PerpMarketIndex } from '@blockworks-foundation/mango-v4';
import { FermiV1Context, buildCanonicalPerpRemainingAccounts } from './context';
import { FermiV1StateClient } from './harness';
import {
  buildPerpUserIntentMessageV3,
  encodePerpPlaceOrderV2QueuePayload,
  findExecutionQueueV5Pda,
  hashExecutionQueueAccountsForCtmEnqueue,
} from './intents';
import {
  FermiV1RelayerClient,
  SubmitIntentRequest,
  SubmitIntentResponse,
  toRelayerAccountMeta,
  TriggerOrderTermsWire,
} from './relayerClient';
import {
  redactTriggerKeeperResponse,
  TriggerLegView,
} from './triggerOrderViews';

export type {
  TriggerLegView,
  TriggerLegKind,
  TriggerLegDirection,
} from './triggerOrderViews';
export const TRIGGER_SOURCE_COMMIT = '7afba98770b6bae99d839c296f3c7fd4750ab18c';
export enum TriggerKind {
  StopLoss = 0,
  TakeProfit = 1,
}
export enum TriggerDirection {
  AtOrAbove = 0,
  AtOrBelow = 1,
}
const I64_MAX = (1n << 63n) - 1n;
const U64_MAX = (1n << 64n) - 1n;

function integer(value: bigint, max: bigint, label: string, min = 0n): bigint {
  if (typeof value !== 'bigint' || value < min || value > max)
    throw new Error(`${label} is out of range; use bigint`);
  return value;
}
function marketIndex(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= 0xffff)
    throw new Error('marketIndex must be 0 to 65534');
}
function u64(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(integer(value, U64_MAX, 'u64'));
  return b;
}
function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}
function randomU64(): bigint {
  return randomBytes(8).readBigUInt64LE();
}

export type TriggerTerms = {
  kind: TriggerKind;
  direction: TriggerDirection;
  triggerPriceLots: bigint;
  ocoGroup: bigint;
  expiryTs: bigint;
  salt: bigint;
};

/** Exact keeper terms encoding. The signature binds its first eight hash bytes. */
export function triggerTermsBytes(
  group: PublicKey,
  fermiAccount: PublicKey,
  index: number,
  terms: TriggerTerms,
): Buffer {
  marketIndex(index);
  if (
    ![TriggerKind.StopLoss, TriggerKind.TakeProfit].includes(terms.kind) ||
    ![TriggerDirection.AtOrAbove, TriggerDirection.AtOrBelow].includes(
      terms.direction,
    )
  )
    throw new Error('invalid trigger kind or direction');
  const price = Buffer.alloc(8);
  price.writeBigInt64LE(
    integer(terms.triggerPriceLots, I64_MAX, 'triggerPriceLots', 1n),
  );
  integer(terms.expiryTs, U64_MAX, 'expiryTs', 1n);
  return Buffer.concat([
    Buffer.from('fermi-trigger-terms-v1'),
    group.toBuffer(),
    fermiAccount.toBuffer(),
    u16(index),
    Buffer.from([1, terms.kind, terms.direction, 0, 0]),
    price,
    u64(terms.ocoGroup),
    u64(terms.expiryTs),
    u64(terms.salt),
  ]);
}
export function triggerTermsCommitment(
  group: PublicKey,
  account: PublicKey,
  index: number,
  terms: TriggerTerms,
): bigint {
  return createHash('sha256')
    .update(triggerTermsBytes(group, account, index, terms))
    .digest()
    .readBigUInt64LE();
}
export function triggerAlreadyMet(
  direction: TriggerDirection,
  trigger: bigint,
  oracle: bigint,
): boolean {
  return direction === TriggerDirection.AtOrBelow
    ? oracle <= trigger
    : oracle >= trigger;
}

export type SlTpParams = {
  group: PublicKey;
  executionQueue: PublicKey;
  marketIndex: number;
  fermiAccount: PublicKey;
  signer: PublicKey;
  remainingAccounts: AccountMeta[];
  position: 'long' | 'short';
  size: bigint | 'all';
  stopLossPriceLots?: bigint;
  takeProfitPriceLots?: bigint;
  slippageBps: number;
  /** Non-zero Unix seconds. The keeper checks its configured TTL at intake. */
  expiryTs: bigint;
  oraclePriceLots?: bigint;
};
export type SlTpLeg = {
  kind: TriggerKind;
  terms: TriggerTerms;
  clientOrderId: bigint;
  payload: Buffer;
  intentHash: Buffer;
  params: SlTpParams;
};

/** Build one bounded reduce-only IOC leg. This function does not sign or submit it. */
export function buildTriggerOrderLeg(
  params: SlTpParams,
  kind: TriggerKind,
  triggerPriceLots: bigint,
  options: { ocoGroup?: bigint; salt?: bigint; limitPriceLots?: bigint } = {},
): SlTpLeg {
  marketIndex(params.marketIndex);
  if (params.position !== 'long' && params.position !== 'short')
    throw new Error('position must be long or short');
  if (params.size !== 'all') integer(params.size, I64_MAX, 'size', 1n);
  if (
    !Number.isInteger(params.slippageBps) ||
    params.slippageBps < 0 ||
    params.slippageBps >= 10000
  )
    throw new Error('slippageBps must be an integer from 0 to 9999');
  integer(triggerPriceLots, I64_MAX, 'triggerPriceLots', 1n);
  const ask = params.position === 'long';
  const direction =
    ask === (kind === TriggerKind.StopLoss)
      ? TriggerDirection.AtOrBelow
      : TriggerDirection.AtOrAbove;
  if (params.oraclePriceLots !== undefined) {
    integer(params.oraclePriceLots, I64_MAX, 'oraclePriceLots', 1n);
    if (triggerAlreadyMet(direction, triggerPriceLots, params.oraclePriceLots))
      throw new Error('trigger is already met by the oracle price');
  }
  const bps = BigInt(params.slippageBps);
  const limit =
    options.limitPriceLots ??
    (ask
      ? (triggerPriceLots * (10000n - bps)) / 10000n
      : (triggerPriceLots * (10000n + bps) + 9999n) / 10000n);
  integer(limit, I64_MAX, 'limitPriceLots', 1n);
  if (ask ? limit > triggerPriceLots : limit < triggerPriceLots)
    throw new Error('IOC limit is not marketable at the trigger');
  const terms: TriggerTerms = {
    kind,
    direction,
    triggerPriceLots,
    ocoGroup: options.ocoGroup ?? 0n,
    expiryTs: params.expiryTs,
    salt: options.salt ?? randomU64(),
  };
  let clientOrderId = triggerTermsCommitment(
    params.group,
    params.fermiAccount,
    params.marketIndex,
    terms,
  );
  while (clientOrderId === 0n) {
    terms.salt = randomU64();
    clientOrderId = triggerTermsCommitment(
      params.group,
      params.fermiAccount,
      params.marketIndex,
      terms,
    );
  }
  const payload = encodePerpPlaceOrderV2QueuePayload({
    side: ask ? { ask: {} } : { bid: {} },
    priceLots: limit,
    maxBaseLots: params.size === 'all' ? I64_MAX : params.size,
    maxQuoteLots: I64_MAX,
    clientOrderId,
    orderType: { immediateOrCancel: {} },
    selfTradeBehavior: { decrementTake: {} },
    reduceOnly: true,
    expiryTimestamp: Number(
      integer(params.expiryTs, BigInt(Number.MAX_SAFE_INTEGER), 'expiryTs', 1n),
    ),
    limit: 10,
  });
  const { userIntentMessage } = buildPerpUserIntentMessageV3({
    group: params.group,
    fermiAccount: params.fermiAccount,
    userOwner: params.signer,
    marketIndex: params.marketIndex,
    payload,
    accountsHash: hashExecutionQueueAccountsForCtmEnqueue(
      params.group,
      params.executionQueue,
      params.remainingAccounts,
    ),
    minExecuteSlot: 0n,
    expiresAtSlot: 0n,
    clientOrderId,
  });
  return {
    kind,
    terms,
    clientOrderId,
    payload,
    intentHash: userIntentMessage,
    params,
  };
}

/** SL and TP share one OCO group. A single leg is independent. */
export function buildSlTpLegs(params: SlTpParams): SlTpLeg[] {
  const wanted: Array<[TriggerKind, bigint]> = [];
  if (params.stopLossPriceLots !== undefined)
    wanted.push([TriggerKind.StopLoss, params.stopLossPriceLots]);
  if (params.takeProfitPriceLots !== undefined)
    wanted.push([TriggerKind.TakeProfit, params.takeProfitPriceLots]);
  if (!wanted.length)
    throw new Error('set stopLossPriceLots or takeProfitPriceLots');
  const ocoGroup = wanted.length > 1 ? randomU64() || 1n : 0n;
  return wanted.map(([kind, price]) =>
    buildTriggerOrderLeg(params, kind, price, { ocoGroup }),
  );
}

export type ContextSlTpParams = Omit<
  SlTpParams,
  'group' | 'executionQueue' | 'fermiAccount' | 'signer' | 'remainingAccounts'
>;
export async function prepareSlTpOrders(
  context: FermiV1Context,
  params: ContextSlTpParams,
): Promise<SlTpLeg[]> {
  return buildSlTpLegs({
    ...params,
    group: context.group.publicKey,
    fermiAccount: context.fermiAccount.publicKey,
    signer: context.user.publicKey,
    executionQueue: findExecutionQueueV5Pda(
      context.programId,
      context.group.publicKey,
      params.marketIndex,
    ),
    remainingAccounts: await buildCanonicalPerpRemainingAccounts(
      context,
      params.marketIndex,
    ),
  });
}
export type UiSlTpParams = Omit<
  ContextSlTpParams,
  'size' | 'stopLossPriceLots' | 'takeProfitPriceLots' | 'oraclePriceLots'
> & {
  size: number | 'all';
  stopLossPrice?: number;
  takeProfitPrice?: number;
};
export async function prepareSlTpOrdersUi(
  context: FermiV1Context,
  params: UiSlTpParams,
): Promise<SlTpLeg[]> {
  const market = context.group.getPerpMarketByMarketIndex(
    params.marketIndex as PerpMarketIndex,
  );
  const price = (n: number | undefined) => {
    if (n === undefined) return undefined;
    if (!Number.isFinite(n) || n <= 0)
      throw new Error('trigger price must be positive and finite');
    return BigInt(market.uiPriceToLots(n).toString());
  };
  if (
    params.size !== 'all' &&
    (!Number.isFinite(params.size) || params.size <= 0)
  )
    throw new Error('size must be positive and finite');
  return prepareSlTpOrders(context, {
    ...params,
    size:
      params.size === 'all'
        ? 'all'
        : BigInt(market.uiBaseToLots(params.size).toString()),
    stopLossPriceLots: price(params.stopLossPrice),
    takeProfitPriceLots: price(params.takeProfitPrice),
    oraclePriceLots: price(market.uiPrice),
  });
}

/** Local keypairs sign the raw hash. External wallets can sign intentHash themselves. */
export function signTriggerOrderLeg(
  leg: SlTpLeg,
  secretKey: Uint8Array,
): Uint8Array {
  const key = nacl.sign.keyPair.fromSecretKey(secretKey);
  if (!new PublicKey(key.publicKey).equals(leg.params.signer))
    throw new Error('trigger signer does not match the leg');
  return nacl.sign.detached(leg.intentHash, secretKey);
}
function assertSignature(
  hash: Buffer,
  signature: Uint8Array,
  signer: PublicKey,
): void {
  if (
    signature.length !== 64 ||
    !(
      nacl.sign.detached.verify(hash, signature, signer.toBytes()) ||
      nacl.sign.detached.verify(
        Buffer.from(hash.toString('hex')),
        signature,
        signer.toBytes(),
      )
    )
  )
    throw new Error('invalid trigger signature');
}
function wireTerms(terms: TriggerTerms): TriggerOrderTermsWire {
  return {
    version: 1,
    kind: terms.kind,
    direction: terms.direction,
    trigger_price_lots: terms.triggerPriceLots.toString(),
    oco_group: terms.ocoGroup.toString(),
    expiry_ts: terms.expiryTs.toString(),
    salt: terms.salt.toString(),
    price_source: 0,
    flags: 0,
  };
}
export function triggerOrderRequest(
  leg: SlTpLeg,
  signature: Uint8Array,
  maxFeeLamports = 'AUTO',
): SubmitIntentRequest {
  const commitment = triggerTermsCommitment(
    leg.params.group,
    leg.params.fermiAccount,
    leg.params.marketIndex,
    leg.terms,
  );
  if (
    commitment !== leg.clientOrderId ||
    leg.payload.length !== 49 ||
    leg.payload.readBigUInt64LE(29) !== commitment ||
    leg.payload.readBigUInt64LE(40) !== leg.terms.expiryTs ||
    leg.payload[37] !== 1 ||
    leg.payload[39] !== 1
  ) {
    throw new Error(
      'trigger terms or payload changed; rebuild and sign the leg again',
    );
  }
  const expected = buildPerpUserIntentMessageV3({
    group: leg.params.group,
    fermiAccount: leg.params.fermiAccount,
    userOwner: leg.params.signer,
    marketIndex: leg.params.marketIndex,
    payload: leg.payload,
    accountsHash: hashExecutionQueueAccountsForCtmEnqueue(
      leg.params.group,
      leg.params.executionQueue,
      leg.params.remainingAccounts,
    ),
    minExecuteSlot: 0n,
    expiresAtSlot: 0n,
    clientOrderId: leg.clientOrderId,
  }).userIntentMessage;
  if (!expected.equals(leg.intentHash))
    throw new Error(
      'trigger accounts or payload changed; rebuild and sign the leg again',
    );
  assertSignature(leg.intentHash, signature, leg.params.signer);
  const p = leg.params;
  return {
    group: p.group.toBase58(),
    execution_queue: p.executionQueue.toBase58(),
    market: String(p.marketIndex),
    payload: leg.payload,
    remaining_accounts: p.remainingAccounts.map(toRelayerAccountMeta),
    min_execute_slot: '0',
    expires_at_slot: '0',
    user_owner: p.signer.toBase58(),
    mango_account: p.fermiAccount.toBase58(),
    user_signature: signature,
    intent_version: 3,
    target_kind: 0,
    target_index: p.marketIndex,
    client_order_id: leg.clientOrderId.toString(),
    trigger_order: wireTerms(leg.terms),
    max_fee_lamports: maxFeeLamports,
  };
}
export function triggerOrderSubmitBody(
  leg: SlTpLeg,
  signature: Uint8Array,
  maxFeeLamports = 'AUTO',
) {
  const { payload, user_signature, ...request } = triggerOrderRequest(
    leg,
    signature,
    maxFeeLamports,
  );
  return {
    ...request,
    payload_b64: Buffer.from(payload).toString('base64'),
    user_signature_b64: Buffer.from(user_signature).toString('base64'),
  };
}
export type TriggerOrderAccepted = {
  trigger_order_id: string;
  trigger_order_status: string;
  status?: string;
};
function withheld<T extends TriggerOrderAccepted & { tx_signature?: string }>(
  response: T,
): T {
  if (
    !response.trigger_order_id ||
    !['pending', 'armed'].includes(response.trigger_order_status) ||
    response.tx_signature
  ) {
    throw new Error(
      'trigger hand-off was not acknowledged; inspect trigger status before retrying',
    );
  }
  return response;
}
export async function submitTriggerOrderViaRelayer(
  relayer: FermiV1RelayerClient,
  leg: SlTpLeg,
  signature: Uint8Array,
  maxFeeLamports = 'AUTO',
): Promise<TriggerOrderAccepted & SubmitIntentResponse> {
  const response = await relayer.submitIntent(
    triggerOrderRequest(leg, signature, maxFeeLamports),
  );
  return withheld(response as TriggerOrderAccepted & SubmitIntentResponse);
}

export type TriggerCancelScope = 'ids' | 'oco_group' | 'all';
export type TriggerCancelParams = {
  group: PublicKey;
  fermiAccount: PublicKey;
  signer: PublicKey;
  issuedAtMs: bigint;
  scope: TriggerCancelScope;
  clientOrderIds?: bigint[];
  ocoGroup?: bigint;
  marketIndex?: number;
};
export function triggerCancelMessageHash(params: TriggerCancelParams): Buffer {
  if (!['ids', 'oco_group', 'all'].includes(params.scope))
    throw new Error('invalid cancel scope');
  const ids = params.clientOrderIds ?? [];
  if (ids.length > 0xffff || (params.scope === 'ids' && !ids.length))
    throw new Error('ids scope needs 1 to 65535 clientOrderIds');
  if (params.scope === 'oco_group' && !params.ocoGroup)
    throw new Error('oco_group scope needs a non-zero ocoGroup');
  if (params.marketIndex !== undefined) marketIndex(params.marketIndex);
  const scope = { ids: 0, oco_group: 1, all: 2 }[params.scope];
  return createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from('fermi-trigger-cancel-v1'),
        params.group.toBuffer(),
        params.fermiAccount.toBuffer(),
        params.signer.toBuffer(),
        u64(params.issuedAtMs),
        Buffer.from([scope]),
        u16(params.marketIndex ?? 0xffff),
        u64(params.ocoGroup ?? 0n),
        u16(ids.length),
        ...ids.map(u64),
      ]),
    )
    .digest();
}
export function signTriggerCancel(
  params: TriggerCancelParams,
  secretKey: Uint8Array,
): Uint8Array {
  if (
    !new PublicKey(nacl.sign.keyPair.fromSecretKey(secretKey).publicKey).equals(
      params.signer,
    )
  )
    throw new Error('cancel signer does not match');
  return nacl.sign.detached(triggerCancelMessageHash(params), secretKey);
}
export type TriggerCancelOutcome =
  | 'cancelled'
  | 'cancel_pending'
  | 'already_terminal'
  | 'not_found';
export type TriggerCancelResponse = {
  results: Array<{ id: string; outcome: TriggerCancelOutcome; state: string }>;
  cancelled: string[];
  skipped?: string[];
};
export function triggerCancelIsFinal(response: TriggerCancelResponse): boolean {
  return response.results.every(
    (result) =>
      result.outcome === 'cancelled' || result.outcome === 'already_terminal',
  );
}
export type TriggerOrderListQuery = {
  fermiAccount?: PublicKey;
  accountOwner?: PublicKey;
  activeOnly?: boolean;
  marketIndex?: number;
  clientOrderId?: bigint;
  ocoGroup?: bigint;
  limit?: number;
};
export type TriggerOrderDetail = {
  order: TriggerLegView;
  history: Array<Record<string, unknown>>;
};

/** One HTTP request per action, through the authenticated gateway. No retry or v2 fallback. */
export class FermiV1TriggerClient extends FermiV1StateClient {
  async submitTriggerOrder(
    leg: SlTpLeg,
    signature: Uint8Array,
    maxFeeLamports = 'AUTO',
  ): Promise<TriggerOrderAccepted> {
    return withheld(
      await this.request<TriggerOrderAccepted>(
        'POST',
        '/relay/submit-intent',
        triggerOrderSubmitBody(leg, signature, maxFeeLamports),
      ),
    );
  }
  async getTriggerOrders(
    query: TriggerOrderListQuery,
  ): Promise<{ orders: TriggerLegView[] }> {
    if (!query.fermiAccount && !query.accountOwner)
      throw new Error('fermiAccount or accountOwner is required');
    const qs = new URLSearchParams();
    if (query.fermiAccount)
      qs.set('mango_account', query.fermiAccount.toBase58());
    if (query.accountOwner)
      qs.set('account_owner', query.accountOwner.toBase58());
    if (query.activeOnly !== undefined)
      qs.set('active', String(query.activeOnly));
    if (query.marketIndex !== undefined) {
      marketIndex(query.marketIndex);
      qs.set('market_index', String(query.marketIndex));
    }
    if (query.clientOrderId !== undefined)
      qs.set(
        'client_order_id',
        integer(query.clientOrderId, U64_MAX, 'clientOrderId').toString(),
      );
    if (query.ocoGroup !== undefined)
      qs.set(
        'oco_group',
        integer(query.ocoGroup, U64_MAX, 'ocoGroup').toString(),
      );
    if (query.limit !== undefined) {
      if (
        !Number.isInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > 1000
      )
        throw new Error('limit must be 1 to 1000');
      qs.set('limit', String(query.limit));
    }
    return redactTriggerKeeperResponse(
      await this.request('GET', `/trigger-orders?${qs}`),
    ) as { orders: TriggerLegView[] };
  }
  async getTriggerOrder(id: string): Promise<TriggerOrderDetail> {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id) || id === '.' || id === '..')
      throw new Error('invalid trigger order id');
    return redactTriggerKeeperResponse(
      await this.request('GET', `/trigger-orders/${encodeURIComponent(id)}`),
    ) as TriggerOrderDetail;
  }
  async cancelTriggerOrders(
    params: TriggerCancelParams,
    signature: Uint8Array,
  ): Promise<TriggerCancelResponse> {
    assertSignature(triggerCancelMessageHash(params), signature, params.signer);
    return redactTriggerKeeperResponse(
      await this.request('POST', '/trigger-orders/cancel', {
        mango_account: params.fermiAccount.toBase58(),
        signer: params.signer.toBase58(),
        issued_at_ms: params.issuedAtMs.toString(),
        scope: params.scope,
        client_order_ids: (params.clientOrderIds ?? []).map(String),
        oco_group: params.ocoGroup?.toString() ?? null,
        market_index: params.marketIndex ?? null,
        signature_b64: Buffer.from(signature).toString('base64'),
      }),
    ) as TriggerCancelResponse;
  }
  cancelForContext(
    context: FermiV1Context,
    params: Omit<
      TriggerCancelParams,
      'group' | 'fermiAccount' | 'signer' | 'issuedAtMs'
    > & { issuedAtMs?: bigint },
  ) {
    const request: TriggerCancelParams = {
      ...params,
      issuedAtMs: params.issuedAtMs ?? BigInt(Date.now()),
      group: context.group.publicKey,
      fermiAccount: context.fermiAccount.publicKey,
      signer: context.user.publicKey,
    };
    return this.cancelTriggerOrders(
      request,
      signTriggerCancel(request, context.user.secretKey),
    );
  }
}
