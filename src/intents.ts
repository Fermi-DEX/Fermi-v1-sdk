import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import {
  AccountMeta,
  Ed25519Program,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';

export const USER_INTENT_DOMAIN = 'mango-v4-user-intent-v2';
const USER_INTENT_DOMAIN_BYTES = Buffer.from(USER_INTENT_DOMAIN, 'utf-8');
const instructionDiscriminatorCache = new Map<string, Buffer>();
const EXECUTION_QUEUE_V5_SEED = Buffer.from('execution-queue-v5', 'utf-8');
const EXECUTION_QUEUE_V5_DIRECT_SEED = Buffer.from(
  'execution-queue-v5-direct',
  'utf-8',
);

export enum QueueItemKind {
  CtmWrapped = 0,
}

export enum UserIntentTargetKind {
  PerpMarket = 0,
  Token = 1,
}

export enum QueuePayloadVariant {
  PerpPlaceOrderV2 = 0,
  PerpCancelOrderByClientOrderId = 2,
  PerpCancelAllOrders = 3,
}

export type QueueSideLike =
  | { bid: Record<string, never> }
  | { ask: Record<string, never> };

export type QueuePlaceOrderTypeLike =
  | { limit: Record<string, never> }
  | { immediateOrCancel: Record<string, never> }
  | { postOnly: Record<string, never> }
  | { market: Record<string, never> }
  | { postOnlySlide: Record<string, never> };

export type QueueSelfTradeBehaviorLike =
  | { decrementTake: Record<string, never> }
  | { cancelProvide: Record<string, never> }
  | { abortTransaction: Record<string, never> };

export type BigNumberish = bigint | number;

export type IntentSigner =
  | { kind: 'keypair'; privateKey: Uint8Array; publicKey?: Uint8Array }
  | { kind: 'presigned'; publicKey: PublicKey; signature: Uint8Array };

export type CtmEnvelopeWire = {
  sequence: bigint;
  minExecuteSlot: bigint;
  kind: number;
  payloadHash: Buffer;
  accountsHash: Buffer;
  expiresAtSlot: bigint;
};

export type BuildExecutionQueueEnqueueDirectParams = {
  programId: PublicKey;
  group: PublicKey;
  executionQueue: PublicKey;
  marketIndex: number;
  remainingAccounts: AccountMeta[];
  envelope: CtmEnvelopeWire;
  payload: Uint8Array;
};

export type BuildExecutionQueueEnqueueDirectWithIntentParams = {
  programId: PublicKey;
  group: PublicKey;
  executionQueue: PublicKey;
  marketIndex: number;
  remainingAccounts: AccountMeta[];
  payload: Uint8Array;
  minExecuteSlot?: BigNumberish;
  expiresAtSlot?: BigNumberish;
  userOwner: PublicKey;
  mangoAccount: PublicKey;
  userSigner: IntentSigner;
};

export type DirectEnqueueArgsV5Wire = {
  payload: Uint8Array;
  kind: number;
  expiresAtSlot: BigNumberish;
  nonce: BigNumberish;
};

export type BuildExecutionQueueV5EnqueueDirectMarketParams = {
  programId: PublicKey;
  group: PublicKey;
  authorityState: PublicKey;
  queue: PublicKey;
  directPool: PublicKey;
  marketIndex: number;
  args: DirectEnqueueArgsV5Wire;
  remainingAccounts: AccountMeta[];
};

export type BuildExecutionQueueV5EnqueueDirectWithIntentParams = {
  programId: PublicKey;
  group: PublicKey;
  authorityState: PublicKey;
  queue: PublicKey;
  directPool: PublicKey;
  marketIndex: number;
  remainingAccounts: AccountMeta[];
  payload: Uint8Array;
  kind?: QueueItemKind;
  expiresAtSlot?: BigNumberish;
  nonce: BigNumberish;
  userOwner: PublicKey;
  mangoAccount: PublicKey;
  userSigner: IntentSigner;
};

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

function toBigInt(value: BigNumberish): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error('number inputs must be safe integers');
  }
  return BigInt(value);
}

function sha256(data: Uint8Array): Buffer {
  return Buffer.from(createHash('sha256').update(data).digest());
}

function u8(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`u8 out of range: ${value}`);
  }
  return Buffer.from([value]);
}

function u16ToLe(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > U16_MAX) {
    throw new Error(`u16 out of range: ${value}`);
  }
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value, 0);
  return out;
}

function u32ToLe(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new Error(`u32 out of range: ${value}`);
  }
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

function u64ToLe(value: BigNumberish): Buffer {
  const n = toBigInt(value);
  if (n < 0 || n > U64_MAX) {
    throw new Error(`u64 out of range: ${n.toString()}`);
  }
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(n);
  return out;
}

function i64ToLe(value: BigNumberish): Buffer {
  const n = toBigInt(value);
  if (n < I64_MIN || n > I64_MAX) {
    throw new Error(`i64 out of range: ${n.toString()}`);
  }
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(n);
  return out;
}

function encodeEnvelope(envelope: CtmEnvelopeWire): Buffer {
  if (envelope.payloadHash.length !== 32) {
    throw new Error('payloadHash must be 32 bytes');
  }
  if (envelope.accountsHash.length !== 32) {
    throw new Error('accountsHash must be 32 bytes');
  }
  return Buffer.concat([
    u64ToLe(envelope.sequence),
    u64ToLe(envelope.minExecuteSlot),
    u8(envelope.kind),
    Buffer.from(envelope.payloadHash),
    Buffer.from(envelope.accountsHash),
    u64ToLe(envelope.expiresAtSlot),
  ]);
}

export function anchorInstructionDiscriminator(ixName: string): Buffer {
  const cached = instructionDiscriminatorCache.get(ixName);
  if (cached) {
    return cached;
  }
  const discriminator = Buffer.from(
    sha256(Buffer.from(`global:${ixName}`, 'utf-8')).subarray(0, 8),
  );
  instructionDiscriminatorCache.set(ixName, discriminator);
  return discriminator;
}

export function hashExecutionQueuePayload(payload: Uint8Array): Buffer {
  return sha256(Buffer.from(payload));
}

function sideToU8(side: QueueSideLike): number {
  if ('bid' in side) {
    return 0;
  }
  if ('ask' in side) {
    return 1;
  }
  throw new Error('invalid side enum object');
}

function orderTypeToU8(orderType: QueuePlaceOrderTypeLike): number {
  if ('limit' in orderType) {
    return 0;
  }
  if ('immediateOrCancel' in orderType) {
    return 1;
  }
  if ('postOnly' in orderType) {
    return 2;
  }
  if ('market' in orderType) {
    return 3;
  }
  if ('postOnlySlide' in orderType) {
    return 4;
  }
  throw new Error('invalid orderType enum object');
}

function selfTradeBehaviorToU8(
  selfTradeBehavior: QueueSelfTradeBehaviorLike,
): number {
  if ('decrementTake' in selfTradeBehavior) {
    return 0;
  }
  if ('cancelProvide' in selfTradeBehavior) {
    return 1;
  }
  if ('abortTransaction' in selfTradeBehavior) {
    return 2;
  }
  throw new Error('invalid selfTradeBehavior enum object');
}

function encodeQueuePayloadV1(
  variant: QueuePayloadVariant,
  body: Uint8Array,
): Buffer {
  return Buffer.concat([
    Buffer.from([1, variant]),
    u16ToLe(0),
    Buffer.from(body),
  ]);
}

export function encodePerpPlaceOrderV2QueuePayload(fields: {
  side: QueueSideLike;
  priceLots: BigNumberish;
  maxBaseLots: BigNumberish;
  maxQuoteLots: BigNumberish;
  clientOrderId: BigNumberish;
  orderType: QueuePlaceOrderTypeLike;
  selfTradeBehavior: QueueSelfTradeBehaviorLike;
  reduceOnly: boolean;
  expiryTimestamp: BigNumberish;
  limit: number;
}): Buffer {
  return encodeQueuePayloadV1(
    QueuePayloadVariant.PerpPlaceOrderV2,
    Buffer.concat([
      u8(sideToU8(fields.side)),
      i64ToLe(fields.priceLots),
      i64ToLe(fields.maxBaseLots),
      i64ToLe(fields.maxQuoteLots),
      u64ToLe(fields.clientOrderId),
      u8(orderTypeToU8(fields.orderType)),
      u8(selfTradeBehaviorToU8(fields.selfTradeBehavior)),
      u8(fields.reduceOnly ? 1 : 0),
      u64ToLe(fields.expiryTimestamp),
      u8(fields.limit),
    ]),
  );
}

export function encodePerpCancelOrderByClientOrderIdQueuePayload(fields: {
  clientOrderId: BigNumberish;
}): Buffer {
  return encodeQueuePayloadV1(
    QueuePayloadVariant.PerpCancelOrderByClientOrderId,
    u64ToLe(fields.clientOrderId),
  );
}

export function encodePerpCancelAllOrdersQueuePayload(fields: {
  limit: number;
}): Buffer {
  return encodeQueuePayloadV1(
    QueuePayloadVariant.PerpCancelAllOrders,
    u8(fields.limit),
  );
}

export function hashExecutionQueueAccounts(accounts: AccountMeta[]): Buffer {
  const bytes = Buffer.alloc(accounts.length * 34);
  let offset = 0;
  for (const account of accounts) {
    bytes.set(account.pubkey.toBytes(), offset);
    offset += 32;
    bytes[offset] = account.isSigner ? 1 : 0;
    offset += 1;
    bytes[offset] = account.isWritable ? 1 : 0;
    offset += 1;
  }
  return sha256(bytes);
}

function mergeEffectiveRuntimeFlags(
  remainingAccounts: AccountMeta[],
  fixedAccounts: AccountMeta[],
): AccountMeta[] {
  const merged = new Map<string, { isSigner: boolean; isWritable: boolean }>();
  for (const account of [...fixedAccounts, ...remainingAccounts]) {
    const key = account.pubkey.toBase58();
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, {
        isSigner: !!account.isSigner,
        isWritable: !!account.isWritable,
      });
      continue;
    }
    prev.isSigner = prev.isSigner || !!account.isSigner;
    prev.isWritable = prev.isWritable || !!account.isWritable;
  }
  return remainingAccounts.map((account) => {
    const effective = merged.get(account.pubkey.toBase58());
    if (!effective) {
      return account;
    }
    return {
      pubkey: account.pubkey,
      isSigner: effective.isSigner,
      isWritable: effective.isWritable,
    };
  });
}

export function hashExecutionQueueAccountsForCtmEnqueue(
  group: PublicKey,
  executionQueue: PublicKey,
  remainingAccounts: AccountMeta[],
): Buffer {
  const effectiveRemaining = mergeEffectiveRuntimeFlags(remainingAccounts, [
    { pubkey: group, isSigner: false, isWritable: true },
    { pubkey: executionQueue, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
  ]);
  return hashExecutionQueueAccounts(effectiveRemaining);
}

export function hashExecutionQueueAccountsForV5DirectEnqueue(
  group: PublicKey,
  executionQueue: PublicKey,
  remainingAccounts: AccountMeta[],
  userOwner: PublicKey,
): Buffer {
  const effectiveRemaining = mergeEffectiveRuntimeFlags(remainingAccounts, [
    { pubkey: group, isSigner: false, isWritable: false },
    { pubkey: executionQueue, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
  ]).map((account) =>
    account.pubkey.equals(userOwner)
      ? { pubkey: account.pubkey, isSigner: false, isWritable: false }
      : account,
  );
  return hashExecutionQueueAccounts(effectiveRemaining);
}

export function findExecutionQueueAuthorityStatePda(
  programId: PublicKey,
  group: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('queue-authority', 'utf-8'), group.toBuffer()],
    programId,
  )[0];
}

export function findExecutionQueueV5Pda(
  programId: PublicKey,
  group: PublicKey,
  marketIndex: number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [EXECUTION_QUEUE_V5_SEED, group.toBuffer(), u16ToLe(marketIndex)],
    programId,
  )[0];
}

export function findExecutionQueueV5DirectPda(
  programId: PublicKey,
  group: PublicKey,
  marketIndex: number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [EXECUTION_QUEUE_V5_DIRECT_SEED, group.toBuffer(), u16ToLe(marketIndex)],
    programId,
  )[0];
}

export function buildPerpUserIntentMessageV2(params: {
  group: PublicKey;
  mangoAccount: PublicKey;
  userOwner: PublicKey;
  marketIndex: number;
  payload: Uint8Array;
  kind?: QueueItemKind;
}): { payloadHash: Buffer; userIntentMessage: Buffer } {
  const payloadHash = hashExecutionQueuePayload(params.payload);
  const userIntentMessage = sha256(
    Buffer.concat([
      USER_INTENT_DOMAIN_BYTES,
      Buffer.from(params.group.toBytes()),
      Buffer.from(params.mangoAccount.toBytes()),
      Buffer.from(params.userOwner.toBytes()),
      u8(params.kind ?? QueueItemKind.CtmWrapped),
      u8(UserIntentTargetKind.PerpMarket),
      u16ToLe(params.marketIndex),
      Buffer.from(payloadHash),
    ]),
  );
  return { payloadHash, userIntentMessage };
}

export function buildExecutionQueueV5DirectIntentMessage(params: {
  group: PublicKey;
  mangoAccount: PublicKey;
  userOwner: PublicKey;
  kind: number;
  marketIndex: number;
  payloadHash: Buffer;
  accountsHash: Buffer;
  expiresAtSlot: BigNumberish;
  nonce: BigNumberish;
}): Buffer {
  if (params.payloadHash.length !== 32) {
    throw new Error('payloadHash must be 32 bytes');
  }
  if (params.accountsHash.length !== 32) {
    throw new Error('accountsHash must be 32 bytes');
  }
  return sha256(
    Buffer.concat([
      Buffer.from('mango-v5-direct-intent-v1', 'utf-8'),
      params.group.toBuffer(),
      params.mangoAccount.toBuffer(),
      params.userOwner.toBuffer(),
      u8(params.kind),
      u8(UserIntentTargetKind.PerpMarket),
      u16ToLe(params.marketIndex),
      Buffer.from(params.payloadHash),
      Buffer.from(params.accountsHash),
      u64ToLe(params.expiresAtSlot),
      u64ToLe(params.nonce),
    ]),
  );
}

export function signIntentMessage(
  privateKey: Uint8Array,
  message: Uint8Array,
): Uint8Array {
  if (privateKey.length !== 64) {
    throw new Error('privateKey must be 64 bytes');
  }
  return nacl.sign.detached(message, privateKey);
}

export function buildIntentEd25519Instruction(
  message: Uint8Array,
  signer: IntentSigner,
): TransactionInstruction {
  if (signer.kind === 'keypair') {
    if (signer.privateKey.length !== 64) {
      throw new Error('keypair privateKey must be 64 bytes');
    }
    const publicKey = signer.publicKey ?? signer.privateKey.subarray(32, 64);
    const signature = nacl.sign.detached(message, signer.privateKey);
    return Ed25519Program.createInstructionWithPublicKey({
      publicKey,
      message,
      signature,
    });
  }
  if (signer.signature.length !== 64) {
    throw new Error('presigned signature must be 64 bytes');
  }
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: signer.publicKey.toBytes(),
    message,
    signature: signer.signature,
  });
}

export function buildExecutionQueueEnqueueDirectIx(
  params: BuildExecutionQueueEnqueueDirectParams,
): TransactionInstruction {
  const data = Buffer.concat([
    anchorInstructionDiscriminator('execution_queue_enqueue_direct'),
    u16ToLe(params.marketIndex),
    encodeEnvelope(params.envelope),
    u32ToLe(params.payload.length),
    Buffer.from(params.payload),
  ]);
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: params.group, isSigner: false, isWritable: true },
      { pubkey: params.executionQueue, isSigner: false, isWritable: true },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      ...params.remainingAccounts,
      { pubkey: params.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildExecutionQueueEnqueueDirectWithIntentIxs(
  params: BuildExecutionQueueEnqueueDirectWithIntentParams,
): {
  envelope: CtmEnvelopeWire;
  userIntentMessage: Buffer;
  userIntentPreInstruction: TransactionInstruction;
  enqueueInstruction: TransactionInstruction;
  instructions: TransactionInstruction[];
} {
  const { payloadHash, userIntentMessage } = buildPerpUserIntentMessageV2({
    group: params.group,
    mangoAccount: params.mangoAccount,
    userOwner: params.userOwner,
    marketIndex: params.marketIndex,
    payload: params.payload,
  });
  const accountsHash = hashExecutionQueueAccountsForCtmEnqueue(
    params.group,
    params.executionQueue,
    params.remainingAccounts,
  );
  const envelope: CtmEnvelopeWire = {
    sequence: 0n,
    minExecuteSlot: toBigInt(params.minExecuteSlot ?? 0),
    kind: QueueItemKind.CtmWrapped,
    payloadHash,
    accountsHash,
    expiresAtSlot: toBigInt(params.expiresAtSlot ?? 0),
  };
  const userIntentPreInstruction = buildIntentEd25519Instruction(
    userIntentMessage,
    params.userSigner,
  );
  const enqueueInstruction = buildExecutionQueueEnqueueDirectIx({
    programId: params.programId,
    group: params.group,
    executionQueue: params.executionQueue,
    marketIndex: params.marketIndex,
    remainingAccounts: params.remainingAccounts,
    envelope,
    payload: params.payload,
  });

  return {
    envelope,
    userIntentMessage,
    userIntentPreInstruction,
    enqueueInstruction,
    instructions: [userIntentPreInstruction, enqueueInstruction],
  };
}

export function buildExecutionQueueV5EnqueueDirectMarketIx(
  params: BuildExecutionQueueV5EnqueueDirectMarketParams,
): TransactionInstruction {
  const data = Buffer.concat([
    anchorInstructionDiscriminator('execution_queue_v5_enqueue_direct_market'),
    u16ToLe(params.marketIndex),
    u32ToLe(params.args.payload.length),
    Buffer.from(params.args.payload),
    u8(params.args.kind),
    u64ToLe(params.args.expiresAtSlot),
    u64ToLe(params.args.nonce),
  ]);
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: params.group, isSigner: false, isWritable: false },
      { pubkey: params.authorityState, isSigner: false, isWritable: false },
      { pubkey: params.queue, isSigner: false, isWritable: false },
      { pubkey: params.directPool, isSigner: false, isWritable: true },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      ...params.remainingAccounts,
    ],
    data,
  });
}

export function buildExecutionQueueV5EnqueueDirectWithIntentIxs(
  params: BuildExecutionQueueV5EnqueueDirectWithIntentParams,
): {
  directIntentMessage: Buffer;
  userIntentPreInstruction: TransactionInstruction;
  enqueueInstruction: TransactionInstruction;
  instructions: TransactionInstruction[];
} {
  const kind = params.kind ?? QueueItemKind.CtmWrapped;
  if (kind !== QueueItemKind.CtmWrapped) {
    throw new Error('v5 direct enqueue requires QueueItemKind.CtmWrapped');
  }

  const payloadHash = hashExecutionQueuePayload(params.payload);
  const expiresAtSlot = toBigInt(params.expiresAtSlot ?? 0);
  const accountsHash = hashExecutionQueueAccountsForV5DirectEnqueue(
    params.group,
    params.queue,
    params.remainingAccounts,
    params.userOwner,
  );
  const directIntentMessage = buildExecutionQueueV5DirectIntentMessage({
    group: params.group,
    mangoAccount: params.mangoAccount,
    userOwner: params.userOwner,
    kind,
    marketIndex: params.marketIndex,
    payloadHash,
    accountsHash,
    expiresAtSlot,
    nonce: params.nonce,
  });

  const userIntentPreInstruction = buildIntentEd25519Instruction(
    directIntentMessage,
    params.userSigner,
  );
  const enqueueInstruction = buildExecutionQueueV5EnqueueDirectMarketIx({
    programId: params.programId,
    group: params.group,
    authorityState: params.authorityState,
    queue: params.queue,
    directPool: params.directPool,
    marketIndex: params.marketIndex,
    args: {
      payload: params.payload,
      kind,
      expiresAtSlot,
      nonce: params.nonce,
    },
    remainingAccounts: params.remainingAccounts,
  });

  return {
    directIntentMessage,
    userIntentPreInstruction,
    enqueueInstruction,
    instructions: [userIntentPreInstruction, enqueueInstruction],
  };
}
