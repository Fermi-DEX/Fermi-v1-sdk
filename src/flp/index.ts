// Synced from fermi-v1 7afba98770b6bae99d839c296f3c7fd4750ab18c.
import { BN, BorshAccountsCoder, BorshCoder, EventParser, Idl } from '@coral-xyz/anchor';
import { Buffer } from 'buffer';
import {
  AccountMeta, ComputeBudgetProgram, Connection, PublicKey, TransactionInstruction, TransactionMessage,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import schema from './idl/flp_vault.json';

export { BN, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };
export const FLP_IDL = schema as Idl;
export const FLP_SOURCE_COMMIT = '7afba98770b6bae99d839c296f3c7fd4750ab18c';
export const NONE_EPOCH = new BN('18446744073709551615');
/** Hard bound on the old deferred batches one close funds. More than
 * `DEFAULT_EQUITY_BATCHES` need a larger heap request (`LARGE_HEAP_BYTES`) and
 * compute; at thirteen markets compute limits a close to about two. */
export const MAX_EQUITY_BATCHES = 8;
/** Batches a close funds by default: the bound measured at the default 32 KiB heap. */
export const DEFAULT_EQUITY_BATCHES = 2;
/** Heap to request (`ComputeBudgetProgram.requestHeapFrame`) for a close past the default bound. */
export const LARGE_HEAP_BYTES = 256 * 1024;
export const MAX_VAULT_PERPS = 13;
/** Bounds of `params.equityWindowS`: seconds after the scheduled epoch end during which a close funds exits. */
export const MIN_EQUITY_WINDOW_S = 300;
/** Longest window for epochs up to eight hours; longer epochs allow up to a quarter of the epoch. */
export const MAX_EQUITY_WINDOW_S = 7200;
export const MAX_EQUITY_WINDOW_EPOCH_DIVISOR = 4;
/** Longest funding window the program accepts for an epoch of `epochDurationS`. */
export function maxEquityWindowSeconds(epochDurationS: number): number {
  unsigned(epochDurationS, 4);
  return Math.max(MAX_EQUITY_WINDOW_S, Math.floor(epochDurationS / MAX_EQUITY_WINDOW_EPOCH_DIVISOR));
}
export const MIN_DELEGATE_TIMELOCK_S = 0;
export function delegateDelaySeconds(timelockS: number): number {
  unsigned(timelockS, 4);
  return timelockS;
}
/** Legacy transaction packet limit. A v0 transaction with a lookup table has the same limit. */
export const LEGACY_PACKET_BYTES = 1232;
/** SIMD-0385 v1 transaction limits (prefix 0x81, no lookup tables). */
export const V1_TRANSACTION_BYTES = 4096;
export const V1_MAX_ADDRESSES = 64;
/** Core `PerpMarket` account: discriminator and the byte offset of its event queue key. */
export const PERP_MARKET_DISCRIMINATOR = BorshAccountsCoder.accountDiscriminator('PerpMarket');
export const PERP_MARKET_EVENT_QUEUE_OFFSET = 128;
/** `FundingCheck` reasons recorded for the deferred head (`headSkipReason`). */
export const FUNDING_FAILURE = { navNotPositive: 1, spotQuoteShort: 2, healthFloor: 3, bankLiquidity: 4 } as const;

/** Unique addresses of one transaction: the fee payer, every program id and every account. */
export function uniqueAddressCount(instructions: TransactionInstruction[], payer?: PublicKey): number {
  const keys = new Set<string>(payer ? [payer.toBase58()] : []);
  for (const ix of instructions) {
    keys.add(ix.programId.toBase58());
    for (const meta of ix.keys) keys.add(meta.pubkey.toBase58());
  }
  return keys.size;
}

function compileLegacy(instructions: TransactionInstruction[], payer: PublicKey) {
  return new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions })
    .compileToLegacyMessage();
}

function compactU16Bytes(value: number) {
  return value < 0x80 ? 1 : value < 0x4000 ? 2 : 3;
}

/** Serialized size of `instructions` as one legacy transaction, signatures included.
 * Computed, not serialized, so oversized messages report their size too. */
export function legacyTransactionBytes(instructions: TransactionInstruction[], payer: PublicKey): number {
  const message = compileLegacy(instructions, payer);
  const signatures = message.header.numRequiredSignatures;
  let bytes = compactU16Bytes(signatures) + 64 * signatures + 3
    + compactU16Bytes(message.accountKeys.length) + 32 * message.accountKeys.length + 32
    + compactU16Bytes(message.instructions.length);
  for (const ix of message.instructions) {
    const data = bs58Decode(ix.data).length;
    bytes += 1 + compactU16Bytes(ix.accounts.length) + ix.accounts.length + compactU16Bytes(data) + data;
  }
  return bytes;
}

/** Serialized size of `instructions` as one SIMD-0385 v1 transaction: fixed header,
 * addresses, five 4-byte compute-budget config values, a 4-byte header per
 * instruction with its account indexes and data, then the signatures. Do not
 * pass compute-budget instructions: a v1 transaction carries that config itself. */
export function v1TransactionBytes(instructions: TransactionInstruction[], payer: PublicKey): number {
  const message = compileLegacy(instructions, payer);
  let bytes = 1 + 3 + 4 + 32 + 1 + 1 + 32 * message.accountKeys.length + 4 * 5;
  for (const ix of message.instructions) bytes += 4 + ix.accounts.length + bs58Decode(ix.data).length;
  return bytes + 64 * message.header.numRequiredSignatures;
}

/** Whether user instructions fit one legacy packet (with the wallet's compute
 * budget instructions when `computeBudget` is set). If they do not, send a v0
 * transaction with the deployment's user lookup table, or a v1 transaction where
 * the wallet supports v1. */
export function fitsLegacyPacket(instructions: TransactionInstruction[], payer: PublicKey, computeBudget = true) {
  const all = computeBudget ? [...computeBudgetInstructions(), ...instructions] : instructions;
  const bytes = legacyTransactionBytes(all, payer);
  return { fits: bytes <= LEGACY_PACKET_BYTES, bytes, addresses: uniqueAddressCount(all, payer) };
}

/** Operator packets (keeper, recovery, admin): a legacy transaction with a compute
 * limit and priority fee when it fits 1,232 bytes, otherwise a v1 transaction.
 * Never a lookup table. Throws when even v1 does not fit. */
export function operatorTransactionFormat(instructions: TransactionInstruction[], payer: PublicKey): 'legacy' | 'v1' {
  if (fitsLegacyPacket(instructions, payer).fits) return 'legacy';
  const addresses = uniqueAddressCount(instructions, payer);
  const bytes = v1TransactionBytes(instructions, payer);
  if (addresses > V1_MAX_ADDRESSES || bytes > V1_TRANSACTION_BYTES) {
    throw new Error(`Operator packet needs ${addresses} addresses and ${bytes} bytes; v1 allows ${V1_MAX_ADDRESSES} and ${V1_TRANSACTION_BYTES}`);
  }
  return 'v1';
}

function computeBudgetInstructions() {
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })];
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const digit = BASE58.indexOf(c);
    if (digit < 0) throw new Error('Invalid base58');
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of text) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

/** `publicDepositsPaused` stops public intake (pre-deposits and queued deposits)
 * while approved wallets keep depositing; `depositsPaused` stops every path. */
export const STATUS = { depositsPaused: 1, withdrawalsPaused: 2, breaker: 4, preDeposit: 8, unwind: 16, closed: 32, publicDepositsPaused: 64 } as const;
export function vaultMode(status: number): 'pre-deposit' | 'live' | 'unwind' | 'closed' {
  if (status & STATUS.closed) return 'closed';
  if (status & STATUS.preDeposit) return 'pre-deposit';
  if (status & STATUS.unwind) return 'unwind';
  return 'live';
}

function unsigned(value: number | bigint | BN, bytes: number): Buffer {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Use bigint or BN for large integers');
  const n = new BN(value.toString());
  if (n.isNeg() || n.bitLength() > bytes * 8) throw new Error(`Value does not fit u${bytes * 8}`);
  return n.toArrayLike(Buffer, 'le', bytes);
}

export function deriveVaultAddresses(programId: PublicKey, group: PublicKey, vaultId: number) {
  const derive = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  const vault = derive([Buffer.from('flp-vault'), group.toBuffer(), unsigned(vaultId, 2)]);
  return {
    vault,
    authority: derive([Buffer.from('flp-authority'), vault.toBuffer()]),
    shareMint: derive([Buffer.from('flp-shares'), vault.toBuffer()]),
    depositEscrow: derive([Buffer.from('flp-escrow'), vault.toBuffer(), Buffer.from('dep')]),
    redemptionEscrow: derive([Buffer.from('flp-escrow'), vault.toBuffer(), Buffer.from('red')]),
  };
}

export function deriveDepositor(programId: PublicKey, vault: PublicKey, user: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('flp-user'), vault.toBuffer(), user.toBuffer()], programId)[0];
}
export function deriveEpoch(programId: PublicKey, vault: PublicKey, epoch: BN | bigint) {
  return PublicKey.findProgramAddressSync([Buffer.from('flp-epoch'), vault.toBuffer(), unsigned(epoch, 8)], programId)[0];
}
export function deriveRecoveryTargets(programId: PublicKey, vault: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('flp-recovery'), vault.toBuffer()], programId)[0];
}
export function deriveFermiAccount(coreProgramId: PublicKey, group: PublicKey, authority: PublicKey, vaultId: number) {
  unsigned(vaultId, 2);
  return PublicKey.findProgramAddressSync([
    Buffer.from('FermiAccount'), group.toBuffer(), authority.toBuffer(), unsigned(vaultId, 4),
  ], coreProgramId)[0];
}

export interface Ticket { requestId: BN; epoch: BN; amount: BN; aux: BN }
export interface DepositorAccount {
  vault: PublicKey; user: PublicKey; bump: number; dep: Ticket; wd: Ticket;
  sharesHeld: BN; costBasis: BN; realizedPnl: BN; totalDeposited: BN; totalWithdrawn: BN;
  firstDepositTs: BN; lastActionTs: BN; preDepositAmount: BN; depositApproved: boolean;
}
export interface VaultAccount {
  expandedRecovery?: boolean;
  /** Reason the latest eligible close failed to fund the deferred head (`FUNDING_FAILURE`), 0 if none. */
  headSkipReason?: number;
  /** Time of that head's first funding failure at an eligible close, 0 if none. */
  headEligibleFailTs?: BN;
  /** Delegate a proportional recovery removed; `finishUnwind` restores it (and
   * reopens deposits when `restoreDepositsOpen`) unless the breaker trips or the
   * guardian or admin removes the delegate first. Default key when none. */
  delegateRestore?: PublicKey;
  restoreDepositsOpen?: boolean;
  scheduledTiming: { enabled: boolean; epochDurationS: number; requestCutoffS: number };
  version: number; status: number; vaultId: number; group: PublicKey; fermiAccount: PublicKey;
  quoteBank: PublicKey; quoteMint: PublicKey; shareMint: PublicKey;
  depositEscrow: PublicKey; redemptionEscrow: PublicKey; admin: PublicKey; delegate: PublicKey;
  epoch: BN; epochStartedAt: BN; owedUnmintedShares: BN; lockedShares: BN;
  deferredHead: BN; deferredTail: BN;
  preDepositTotal: BN; liveStartedAt: BN; terminalAssets: BN; terminalSupply: BN; heldDeposits: BN;
  graduationNum: BN; graduationDen: BN; graduationRemainingQuote: BN; graduationRemainingShares: BN;
  recoveryParams: { graceProportionalS: number; graceFullS: number; oracleBandBps: number; maxStepQuote: BN };
  unwind: { mode: number; batchEpoch: BN; startedAt: BN; marketIndexes: number[]; targetBaseLots: BN[] };
  params: { epochDurationS: number; requestCutoffS: number; equityWindowS: number; minDeposit: BN; minWithdrawShares: BN; [key: string]: unknown };
  [key: string]: unknown;
}
export interface EpochAccount {
  vault: PublicKey; epoch: BN; depGross: BN; depNum: BN; depDen: BN; wdStatus: number;
  wdNum: BN; wdDen: BN; nextDeferred: BN; [key: string]: unknown;
}
/** The epoch closed with its deposits held (during an unwind, or because the core refused the deposit): they bought no shares and are refund-only. */
export function depositsHeld(record: EpochAccount) {
  return record.depDen.isZero() && !record.depGross.isZero();
}

/** Effective open-epoch timing remains in params; these values apply at its close. */
export function scheduledEpochTiming(state: VaultAccount) {
  const timing = state.scheduledTiming ?? decodeVaultExtension(state).scheduledTiming;
  return timing.enabled ? {
    epochDurationS: timing.epochDurationS,
    requestCutoffS: timing.requestCutoffS,
  } : null;
}

/** Normalize PR23 reserved bytes without changing the stored legacy schema. */
export function decodeVaultExtension(state: VaultAccount): VaultAccount {
  const bytes = Buffer.from(state.reserved as number[]);
  if (bytes.length !== 67) throw new Error('Unsupported Vault extension');
  if (bytes[18] > 1) throw new Error('Unsupported recovery capability');
  return { ...state,
    expandedRecovery: bytes[18] === 1,
    headSkipReason: bytes[19],
    headEligibleFailTs: new BN(bytes.readBigInt64LE(20).toString()),
    delegateRestore: new PublicKey(bytes.subarray(28, 60)),
    restoreDepositsOpen: (bytes[60] & 1) !== 0,
    params: { ...state.params, equityWindowS: bytes.readUInt32LE(10) || MIN_EQUITY_WINDOW_S },
    scheduledTiming: { enabled: bytes[0] !== 0, epochDurationS: bytes.readUInt32LE(1), requestCutoffS: bytes.readUInt32LE(5) },
  };
}

/** Earliest time anyone (not the admin or guardian) may start recovery against
 * the deferred head, or null while it cannot open. Mirrors the program: a cash (2)
 * or health (3) failure at an eligible close opens proportional recovery
 * `graceProportionalS` after the first failure. Full recovery is permanent: a
 * stranger may start it only from an active proportional recovery that has not
 * cured the head, `graceFullS` after that first failure. A missed window or a
 * bank-liquidity failure opens nothing: anyone may close the next epoch. */
export function permissionlessTriggerAt(state: VaultAccount, full: boolean): BN | null;
/** @deprecated `headClosedAt` is ignored; the keeper-abandonment path was removed. */
export function permissionlessTriggerAt(state: VaultAccount, headClosedAt: BN | number, full: boolean): BN | null;
export function permissionlessTriggerAt(state: VaultAccount, a: boolean | BN | number, b?: boolean): BN | null {
  const full = typeof a === 'boolean' ? a : b === true;
  const extended = state.headSkipReason === undefined ? decodeVaultExtension(state) : state;
  const reason = extended.headSkipReason!;
  const since = extended.headEligibleFailTs!;
  const { graceProportionalS, graceFullS } = state.recoveryParams;
  if (since.isZero() || (reason !== FUNDING_FAILURE.spotQuoteShort && reason !== FUNDING_FAILURE.healthFloor)) return null;
  if (full && state.unwind.mode !== 1) return null;
  return since.addn(full ? graceFullS : graceProportionalS);
}

/** Staged `VaultParams` (IDL names, as for `stageParamsV3`). */
export interface VaultParamsInput {
  epochDurationS: number; requestCutoffS: number; timelockS: number;
  mgmtFeeBps: number; perfFeeBps: number; depositFeeBps: number; withdrawFeeBps: number;
  upnlHaircutBps: number; minPostWithdrawInitRatioBps: number;
  breakerDrawdownBps: number; breakerMinInitRatioBps: number; breakerWindowS: number;
  tvlCap: BN; minDeposit: BN; minWithdrawShares: BN; equityWindowS: number;
}
/** Seconds `stageParamsV3` makes `next` wait. Changes no current LP can lose by
 * (lower fee rates, lower deposit and withdrawal minimums, any deposit cap, all
 * else equal to the timing and window that apply next) wait the vault's
 * `timelockS`; anything else waits the parameter delay (at least the epoch plus
 * its request cutoff, including a scheduled timing change). */
export function stagedParamsDelaySeconds(state: VaultAccount, next: VaultParamsInput): number {
  const extended = state.scheduledTiming === undefined ? decodeVaultExtension(state) : state;
  const p = extended.params as unknown as VaultParamsInput;
  const timing = extended.scheduledTiming;
  const epoch = timing.enabled ? timing.epochDurationS : p.epochDurationS;
  const cutoff = timing.enabled ? timing.requestCutoffS : p.requestCutoffS;
  const favourable = next.mgmtFeeBps <= p.mgmtFeeBps && next.perfFeeBps <= p.perfFeeBps
    && next.depositFeeBps <= p.depositFeeBps && next.withdrawFeeBps <= p.withdrawFeeBps
    && next.minDeposit.lte(p.minDeposit) && next.minWithdrawShares.lte(p.minWithdrawShares)
    && next.epochDurationS === epoch && next.requestCutoffS === cutoff && next.timelockS === p.timelockS
    && next.upnlHaircutBps === p.upnlHaircutBps && next.minPostWithdrawInitRatioBps === p.minPostWithdrawInitRatioBps
    && next.breakerDrawdownBps === p.breakerDrawdownBps && next.breakerMinInitRatioBps === p.breakerMinInitRatioBps
    && next.breakerWindowS === p.breakerWindowS && next.equityWindowS === p.equityWindowS;
  if (favourable) return p.timelockS;
  const pending = timing.enabled ? timing.epochDurationS + timing.requestCutoffS : 0;
  return Math.max(p.timelockS, p.epochDurationS + p.requestCutoffS, pending);
}

/** (market, bids, asks) of one active perp position. */
export interface RecoveryMarket { market: PublicKey; bids: PublicKey; asks: PublicKey }
/** One writable (market, bids, asks) triple per active perp position, in position
 * order: the remaining accounts of recovery triggers and `cancel_orders`. No event
 * queues: a proportional target checks only the vault's own unconsumed fills. */
export function recoveryMarketMetas(markets: RecoveryMarket[]): AccountMeta[] {
  return markets.flatMap(m => [m.market, m.bids, m.asks].map(pubkey => ({ pubkey, isSigner: false, isWritable: true })));
}

/** Read/build only. The caller's wallet signs and sends transactions. */
export class FlpClient {
  /** Perp market -> event queue (null for any other account); keys never change. */
  private readonly marketQueues = new Map<string, PublicKey | null>();
  readonly coder = new BorshCoder(FLP_IDL);
  readonly accountsCoder = this.coder.accounts;
  readonly instructionCoder = this.coder.instruction;
  readonly eventCoder = this.coder.events;
  constructor(readonly connection: Connection, readonly programId: PublicKey) {}
  parseEvents(logs: string[]) { return [...new EventParser(this.programId, this.coder).parseLogs(logs)]; }

  /** Nested account groups use dot paths, e.g. fermi.quoteBank. */
  instruction(name: string, accounts: Record<string, PublicKey>, args: Record<string, unknown> = {}, remaining: AccountMeta[] = []) {
    const definition = FLP_IDL.instructions.find(ix => ix.name === name);
    if (!definition) throw new Error(`Unknown FLP instruction: ${name}`);
    const keys: AccountMeta[] = [];
    const visit = (items: typeof definition.accounts, prefix = '') => {
      for (const item of items) {
        const path = prefix + item.name;
        if ('accounts' in item) visit(item.accounts, path + '.');
        else {
          const pubkey = accounts[path];
          // An omitted optional account is passed as the program id, read-only (Anchor's None).
          if (item.isOptional && (!pubkey || pubkey.equals(this.programId))) keys.push({ pubkey: this.programId, isWritable: false, isSigner: false });
          else if (!pubkey) throw new Error(`Missing FLP account: ${path}`);
          else keys.push({ pubkey, isWritable: item.isMut, isSigner: item.isSigner });
        }
      }
    };
    visit(definition.accounts);
    return new TransactionInstruction({ programId: this.programId, keys: [...keys, ...remaining], data: this.instructionCoder.encode(name, args) });
  }

  async fetch<T>(name: 'Vault' | 'Depositor' | 'EpochRecord', address: PublicKey): Promise<T> {
    const account = await this.connection.getAccountInfo(address, 'confirmed');
    if (!account || !account.owner.equals(this.programId)) throw new Error(`Missing or wrong-owner ${name}: ${address}`);
    const definition = FLP_IDL.accounts!.find(account => account.name === name)!;
    if (account.data.length !== this.accountsCoder.size(definition)) throw new Error(`Unsupported ${name} layout`);
    const decoded = this.accountsCoder.decode<T>(name, account.data);
    return name === 'Vault' ? decodeVaultExtension(decoded as VaultAccount) as T : decoded;
  }
  async fetchVault(address: PublicKey) {
    const state = await this.fetch<VaultAccount>('Vault', address);
    if (state.version !== 3) throw new Error(`Unsupported vault version: ${state.version}`);
    if (state.expandedRecovery && state.unwind.mode !== 0) {
      const info = await this.connection.getAccountInfo(deriveRecoveryTargets(this.programId, address), 'confirmed');
      if (!info || !info.owner.equals(this.programId)) throw new Error('Missing or wrong-owner recovery targets');
      if (info.data.length !== 187) throw new Error('Unsupported recovery target layout');
      const targets = this.accountsCoder.decode('RecoveryTargets', info.data) as {
        vault: PublicKey; mode: number; batchEpoch: BN; startedAt: BN;
        marketIndexes: number[]; targetBaseLots: BN[];
      };
      if (!targets.vault.equals(address) || targets.mode !== state.unwind.mode ||
          !targets.batchEpoch.eq(state.unwind.batchEpoch) || !targets.startedAt.eq(state.unwind.startedAt)) {
        throw new Error('Recovery changed; refresh vault state');
      }
      state.unwind = { ...state.unwind, marketIndexes: targets.marketIndexes, targetBaseLots: targets.targetBaseLots };
    }
    return state;
  }

  /** Event queues of the active perp positions, in position order, read from the
   * perp markets in `health` (the core's health order lists them in position
   * order). Pricing instructions (close, approved deposit, graduation, breaker
   * check and reset) take them after the health accounts. Cached per account. */
  async eventQueueMetas(health: AccountMeta[]): Promise<AccountMeta[]> {
    const unknown = [...new Set(health.map(m => m.pubkey.toBase58()))].filter(key => !this.marketQueues.has(key));
    if (unknown.length) {
      const end = PERP_MARKET_EVENT_QUEUE_OFFSET + 32;
      const infos = await this.connection.getMultipleAccountsInfo(unknown.map(key => new PublicKey(key)),
        { commitment: 'confirmed', dataSlice: { offset: 0, length: end } });
      unknown.forEach((key, i) => {
        const data = infos[i]?.data;
        const market = data !== undefined && data.length >= end && Buffer.from(data.subarray(0, 8)).equals(PERP_MARKET_DISCRIMINATOR);
        this.marketQueues.set(key, market ? new PublicKey(data!.subarray(PERP_MARKET_EVENT_QUEUE_OFFSET, end)) : null);
      });
    }
    const queues: AccountMeta[] = [];
    const seen = new Set<string>();
    for (const meta of health) {
      const key = meta.pubkey.toBase58();
      const queue = this.marketQueues.get(key);
      if (queue && !seen.has(key)) {
        seen.add(key);
        queues.push({ pubkey: queue, isSigner: false, isWritable: false });
      }
    }
    return queues;
  }
  /** `health` followed by its event queues: the remaining accounts of
   * `permissionedDepositInstructions` and `graduate` once the vault trades perps. */
  async withEventQueues(health: AccountMeta[]): Promise<AccountMeta[]> {
    return [...health, ...await this.eventQueueMetas(health)];
  }

  /** Appended AFTER FIFO/health/queue/market metas; never forward this to the core CPI. */
  recoveryMetas(vault: PublicKey, state: VaultAccount, writable = false): AccountMeta[] {
    return state.expandedRecovery ? [{pubkey: deriveRecoveryTargets(this.programId, vault), isSigner: false, isWritable: writable}] : [];
  }

  authority(vault: PublicKey) {
    return PublicKey.findProgramAddressSync([Buffer.from('flp-authority'), vault.toBuffer()], this.programId)[0];
  }

  /** Admin, once per vault instead of `initFermiAccountV3`: a quote-only
   * FermiAccount with up to thirteen perp slots and the thirteen-target recovery
   * store in one instruction, so a multi-market vault needs no later
   * `expandMarketCapacity`. The runtime creates at most 10 KiB of account data per
   * instruction: thirteen perp slots fit up to 58 order slots; expand for more. */
  initFermiAccountV4(vault: PublicKey, state: VaultAccount, admin: PublicKey, coreProgram: PublicKey,
    perpCount: number, perpOoCount: number) {
    unsigned(perpCount, 1); unsigned(perpOoCount, 1);
    if (perpCount < 1 || perpCount > MAX_VAULT_PERPS || perpOoCount < 1 || perpOoCount > 64) throw new Error('Unsupported market capacity');
    if (!state.fermiAccount.equals(PublicKey.default)) throw new Error('The vault already has its FermiAccount');
    const authority = this.authority(vault);
    return this.instruction('initFermiAccountV4', { vault, authority, admin,
      'fermi.group': state.group, 'fermi.fermiAccount': deriveFermiAccount(coreProgram, state.group, authority, state.vaultId),
      'fermi.fermiProgram': coreProgram, recoveryTargets: deriveRecoveryTargets(this.programId, vault),
      systemProgram: PublicKey.default }, { perpCount, perpOoCount, tokenCount: 1 });
  }

  expandMarketCapacity(vault: PublicKey, state: VaultAccount, admin: PublicKey,
    coreProgram: PublicKey, perpCount: number, perpOoCount: number) {
    unsigned(perpCount, 1); unsigned(perpOoCount, 1);
    if (perpCount < 1 || perpCount > MAX_VAULT_PERPS || perpOoCount < 1 || perpOoCount > 64) throw new Error('Unsupported market capacity');
    // Growth adds empty slots: quoting and deposits continue (P-03).
    if (state.status & (STATUS.unwind | STATUS.closed)) throw new Error('Capacity cannot grow during recovery or after closure');
    const authority = this.authority(vault);
    return this.instruction('expandMarketCapacity', {vault, authority, admin,
      'fermi.group': state.group, 'fermi.fermiAccount': state.fermiAccount, 'fermi.fermiProgram': coreProgram,
      recoveryTargets: deriveRecoveryTargets(this.programId, vault), systemProgram: PublicKey.default,
    }, {perpCount, perpOoCount});
  }


  /** Fetch the FIFO prefix (the head, then up to `maxBatches - 1` more) and append
   * the event queues of the active perp positions after `health`. Refresh state and
   * rebuild after any race. Operator packet: send it as a legacy transaction when it
   * fits (`operatorTransactionFormat`), otherwise as a v1 transaction; never with a
   * lookup table. The fee share ATA is needed only when the close mints fee shares
   * (any fee rate above zero); create it in a separate transaction. Funding is
   * attempted when the close lands within `params.equityWindowS` of the scheduled
   * end. `maxBatches` defaults to `DEFAULT_EQUITY_BATCHES`; up to
   * `MAX_EQUITY_BATCHES` drain a backlog in one close when the transaction also
   * requests `LARGE_HEAP_BYTES` of heap and enough compute. Pass `maxBatches: 1`
   * when two exceed the budget: the head alone is a valid prefix. Consume every
   * vault fill first. The recovery sidecar is appended on expanded vaults; the
   * program reads it only during recovery. */
  async closeEpoch(vault: PublicKey, state: VaultAccount, accounts: Record<string, PublicKey>, health: AccountMeta[],
    options: { maxBatches?: number } = {}) {
    const maxBatches = options.maxBatches ?? DEFAULT_EQUITY_BATCHES;
    if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > MAX_EQUITY_BATCHES) throw new Error(`maxBatches must be 1 to ${MAX_EQUITY_BATCHES}`);
    const batches: AccountMeta[] = [];
    const seen = new Set<string>();
    let next = state.deferredHead;
    while (!next.eq(NONE_EPOCH) && batches.length < maxBatches) {
      if (seen.has(next.toString())) throw new Error('Invalid deferred queue cycle');
      seen.add(next.toString());
      const record = await this.fetchEpoch(vault, next);
      if (!record.vault.equals(vault) || !record.epoch.eq(next) || record.wdStatus !== 2) {
        throw new Error('Deferred queue changed; refresh vault state');
      }
      batches.push({ pubkey: deriveEpoch(this.programId, vault, next), isWritable: true, isSigner: false });
      next = record.nextDeferred;
    }
    return this.instruction('closeEpochV3', {
      ...accounts, vault, epochRecord: deriveEpoch(this.programId, vault, state.epoch),
      deferredTailRecord: state.deferredTail.eq(NONE_EPOCH) ? this.programId : deriveEpoch(this.programId, vault, state.deferredTail),
      depositEscrow: state.depositEscrow, redemptionEscrow: state.redemptionEscrow, shareMint: state.shareMint,
    }, { deferredBatchCount: batches.length },
    [...batches, ...health, ...await this.eventQueueMetas(health), ...this.recoveryMetas(vault, state, true)]);
  }
  /** Permissionless circuit breaker. `accounts`: authority, idleAccount and the
   * `fermi.*` keys. Consume every vault fill first; the queues are appended. */
  async checkBreaker(vault: PublicKey, state: VaultAccount, accounts: Record<string, PublicKey>, health: AccountMeta[]) {
    return this.instruction('checkBreaker', { ...accounts, vault, shareMint: state.shareMint },
      {}, await this.withEventQueues(health));
  }
  /** Admin: clear the breaker and restart its reference from the current price. */
  async resetBreaker(vault: PublicKey, state: VaultAccount, admin: PublicKey, accounts: Record<string, PublicKey>, health: AccountMeta[]) {
    return this.instruction('resetBreaker', { ...accounts, vault, admin, shareMint: state.shareMint },
      {}, await this.withEventQueues(health));
  }
  /** Admin: leave recovery and return to live trading with deposits paused and no
   * delegate. Unfunded batches stay queued; re-open deposits and re-delegate
   * through the timelocked paths afterwards. Expanded vaults pass the sidecar. */
  abortUnwind(vault: PublicKey, state: VaultAccount, admin: PublicKey) {
    if (!(state.status & STATUS.unwind) || state.status & STATUS.closed) throw new Error('The vault is not in recovery');
    return this.instruction('abortUnwind', { vault, admin }, {}, this.recoveryMetas(vault, state, true));
  }
  /** Delegate or admin: fund the deferred head before the next close, at the price
   * of its own close, while today's NAV_low price after accruable fees is at or
   * above it (`CureBelowClosePrice` otherwise), with the funding checks of a close
   * (spot quote, bank liquidity, post-payout health floor). Not during recovery.
   * `accounts`: authority, idleAccount and the `fermi.*` keys. Consume every vault
   * fill first; the event queues are appended after `health`. */
  async cureDeferred(vault: PublicKey, state: VaultAccount, signer: PublicKey, accounts: Record<string, PublicKey>, health: AccountMeta[]) {
    if (state.deferredHead.eq(NONE_EPOCH)) throw new Error('No deferred batch to cure');
    if (state.status & (STATUS.unwind | STATUS.closed)) throw new Error('Cures are unavailable during recovery or after closure');
    return this.instruction('cureDeferred', { ...accounts, vault, signer,
      headRecord: deriveEpoch(this.programId, vault, state.deferredHead),
      redemptionEscrow: state.redemptionEscrow, shareMint: state.shareMint }, {}, await this.withEventQueues(health));
  }
  private triggerAccounts(vault: PublicKey, state: VaultAccount, signer: PublicKey, coreProgram: PublicKey, deferredRecord?: PublicKey) {
    return { vault, authority: this.authority(vault), 'fermi.group': state.group, 'fermi.fermiAccount': state.fermiAccount,
      'fermi.fermiProgram': coreProgram, shareMint: state.shareMint, deferredRecord: deferredRecord ?? this.programId, signer };
  }
  /** Recovery trigger. The admin or guardian starts full recovery at once and
   * proportional recovery after its grace from the deferred head's close; anyone
   * else follows `permissionlessTriggerAt` and passes the head. `markets`: one
   * triple per active perp position (`recoveryMarketMetas`); the sidecar follows
   * on expanded vaults. Operator packet (`operatorTransactionFormat`). */
  triggerUnwind(vault: PublicKey, state: VaultAccount, signer: PublicKey, coreProgram: PublicKey,
    markets: RecoveryMarket[], full: boolean, deferredHead?: BN | bigint) {
    if (state.status & STATUS.closed) throw new Error('The vault is closed');
    const record = deferredHead === undefined ? undefined : deriveEpoch(this.programId, vault, deferredHead);
    return this.instruction('triggerUnwind', this.triggerAccounts(vault, state, signer, coreProgram, record), { full },
      [...recoveryMarketMetas(markets), ...this.recoveryMetas(vault, state, true)]);
  }
  /** Admin or guardian: cut every active position by `fractionBps` (1 to 10,000)
   * of its size without a deferred batch. Quoting stops until `finishUnwind`, which
   * gives it back to the removed delegate (and reopens deposits if they were open)
   * unless the breaker trips or the guardian or admin removes the delegate first
   * (`delegateRestore`). Same accounts as `triggerUnwind`. */
  triggerPartialUnwind(vault: PublicKey, state: VaultAccount, signer: PublicKey, coreProgram: PublicKey,
    markets: RecoveryMarket[], fractionBps: number) {
    unsigned(fractionBps, 2);
    if (fractionBps < 1 || fractionBps > 10_000) throw new Error('fractionBps must be 1 to 10,000');
    if (state.status & (STATUS.unwind | STATUS.closed)) throw new Error('A recovery is already running or the vault is closed');
    return this.instruction('triggerPartialUnwind', this.triggerAccounts(vault, state, signer, coreProgram), { fractionBps },
      [...recoveryMarketMetas(markets), ...this.recoveryMetas(vault, state, true)]);
  }
  /** `PricingAccounts` metas in program order from IDL dot paths
   * (`pricing.authority`, `pricing.fermi.quoteBank`, ...), as accepted by
   * `permissionedDepositInstructions` and `graduate`. */
  pricingMetas(pricingAccounts: Record<string, PublicKey>): AccountMeta[] {
    const graduate = FLP_IDL.instructions.find(ix => ix.name === 'graduate')!;
    const group = graduate.accounts.find(item => item.name === 'pricing') as { accounts: typeof graduate.accounts };
    const keys: AccountMeta[] = [];
    const visit = (items: typeof graduate.accounts, prefix: string) => {
      for (const item of items) {
        const path = prefix + item.name;
        if ('accounts' in item) visit(item.accounts, path + '.');
        else {
          const pubkey = pricingAccounts[path];
          if (!pubkey) throw new Error(`Missing FLP account: ${path}`);
          keys.push({ pubkey, isWritable: item.isMut, isSigner: item.isSigner });
        }
      }
    };
    visit(group.accounts, 'pricing.');
    return keys;
  }
  /** Admin, once staged params are due (`stagedParamsDelaySeconds`). A management
   * or performance fee-rate change needs fees accrued under the old rates in the
   * same second: pass `pricing` (the pricing accounts and `health` ending with the
   * event queues) and the instruction accrues them itself. */
  applyParams(vault: PublicKey, admin: PublicKey, pricing?: { accounts: Record<string, PublicKey>; health: AccountMeta[] }) {
    const remaining = pricing ? [...this.pricingMetas(pricing.accounts), ...pricing.health] : [];
    return this.instruction('applyParams', { vault, admin }, {}, remaining);
  }
  /** Anyone: create a wallet's Depositor record (deposit approval stays off), for
   * example for a new fee recipient before it queues its fee shares. */
  initDepositor(vault: PublicKey, user: PublicKey, payer: PublicKey) {
    return this.instruction('initDepositor', { vault, user, depositor: deriveDepositor(this.programId, vault, user),
      payer, systemProgram: PublicKey.default });
  }
  /** Permissionless: release a flat perp slot so NAV reads and closes stop depending on
   * that market's oracle. The core rejects it while the slot holds lots, quote, resting
   * orders or unconsumed fills; `FlpPerpPositionDeactivated` confirms the release. */
  deactivatePerpPosition(vault: PublicKey, state: VaultAccount, perpMarket: PublicKey, fermiProgram: PublicKey) {
    const authority = PublicKey.findProgramAddressSync([Buffer.from('flp-authority'), vault.toBuffer()], this.programId)[0];
    return this.instruction('deactivatePerpPosition', {
      vault, authority, 'fermi.group': state.group, 'fermi.fermiAccount': state.fermiAccount, 'fermi.fermiProgram': fermiProgram, perpMarket,
    });
  }
  fetchDepositor(vault: PublicKey, user: PublicKey) { return this.fetch<DepositorAccount>('Depositor', deriveDepositor(this.programId, vault, user)); }
  fetchEpoch(vault: PublicKey, epoch: BN | bigint) { return this.fetch<EpochAccount>('EpochRecord', deriveEpoch(this.programId, vault, epoch)); }

  requestDeposit(vault: PublicKey, state: VaultAccount, user: PublicKey, amount: BN | bigint) {
    if (vaultMode(state.status) !== 'live') throw new Error('Use phase-aware deposit instructions');
    unsigned(amount, 8);
    return this.instruction('requestDeposit', {
      vault, depositor: deriveDepositor(this.programId, vault, user), user,
      userQuoteAccount: getAssociatedTokenAddressSync(state.quoteMint, user, true), depositEscrow: state.depositEscrow,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: new PublicKey('11111111111111111111111111111111'),
    }, { amount: new BN(amount.toString()) });
  }
  requestWithdraw(vault: PublicKey, state: VaultAccount, user: PublicKey, shares: BN | bigint) {
    if (state.status & STATUS.unwind) throw new Error('Trading withdrawals wait until recovery completes');
    unsigned(shares, 8);
    return this.instruction('requestWithdraw', {
      vault, depositor: deriveDepositor(this.programId, vault, user), user, shareMint: state.shareMint,
      userShareAccount: getAssociatedTokenAddressSync(state.shareMint, user, true, TOKEN_2022_PROGRAM_ID),
      token2022Program: TOKEN_2022_PROGRAM_ID,
    }, { shares: new BN(shares.toString()) });
  }
  private userAccounts(vault: PublicKey, state: VaultAccount, user: PublicKey) {
    const authority = PublicKey.findProgramAddressSync([Buffer.from('flp-authority'), vault.toBuffer()], this.programId)[0];
    return {
      vault, depositor: deriveDepositor(this.programId, vault, user), authority, user,
      userQuoteAccount: getAssociatedTokenAddressSync(state.quoteMint, user, true),
      userShareAccount: getAssociatedTokenAddressSync(state.shareMint, user, true, TOKEN_2022_PROGRAM_ID),
      shareMint: state.shareMint, depositEscrow: state.depositEscrow, redemptionEscrow: state.redemptionEscrow,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: new PublicKey('11111111111111111111111111111111'),
    };
  }
  cancelDeposit(vault: PublicKey, state: VaultAccount, user: PublicKey) {
    return this.instruction('cancelDeposit', this.userAccounts(vault, state, user));
  }
  cancelWithdraw(vault: PublicKey, state: VaultAccount, user: PublicKey) {
    return this.instruction('cancelWithdraw', this.userAccounts(vault, state, user));
  }
  claimDeposit(vault: PublicKey, state: VaultAccount, user: PublicKey, epoch: BN | bigint) {
    return this.instruction('claimDeposit', { ...this.userAccounts(vault, state, user), epochRecord: deriveEpoch(this.programId, vault, epoch) });
  }
  claimWithdrawal(vault: PublicKey, state: VaultAccount, user: PublicKey, epoch: BN | bigint) {
    return this.instruction('claimWithdrawal', { ...this.userAccounts(vault, state, user), epochRecord: deriveEpoch(this.programId, vault, epoch) });
  }
  /** Pass `heldEpoch` when the ticket's epoch closed with its deposits held (see `depositsHeld`). */
  refundPendingDeposit(vault: PublicKey, state: VaultAccount, user: PublicKey, heldEpoch?: BN | bigint) {
    const accounts: Record<string, PublicKey> = this.userAccounts(vault, state, user);
    if (heldEpoch !== undefined) accounts.epochRecord = deriveEpoch(this.programId, vault, heldEpoch);
    return this.instruction('refundPendingDeposit', accounts);
  }
  /** Claims shares for a settled deposit ticket, or refunds one whose epoch held its deposits. */
  settleDepositInstruction(vault: PublicKey, state: VaultAccount, user: PublicKey, record: EpochAccount) {
    return depositsHeld(record) ? this.refundPendingDeposit(vault, state, user, record.epoch)
      : this.claimDeposit(vault, state, user, record.epoch);
  }
  preDeposit(vault: PublicKey, state: VaultAccount, user: PublicKey, amount: BN | bigint) {
    unsigned(amount, 8);
    return this.instruction('preDepositV3', this.userAccounts(vault, state, user), { amount: new BN(amount.toString()) });
  }
  preWithdraw(vault: PublicKey, state: VaultAccount, user: PublicKey, amount: BN | bigint) {
    unsigned(amount, 8);
    return this.instruction('preWithdrawV3', this.userAccounts(vault, state, user), { amount: new BN(amount.toString()) });
  }
  terminalRedeem(vault: PublicKey, state: VaultAccount, user: PublicKey, shares: BN | bigint) {
    unsigned(shares, 8);
    return this.instruction('terminalRedeem', this.userAccounts(vault, state, user), { shares: new BN(shares.toString()) });
  }
  depositInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey, amount: BN | bigint) {
    const mode = vaultMode(state.status);
    if (state.status & (STATUS.depositsPaused | STATUS.publicDepositsPaused | STATUS.breaker | STATUS.unwind) || mode === 'unwind' || mode === 'closed') throw new Error('Deposits are unavailable');
    return mode === 'pre-deposit' ? [this.preDeposit(vault, state, user, amount)]
      : [this.requestDeposit(vault, state, user, amount)];
  }
  withdrawalInstruction(vault: PublicKey, state: VaultAccount, user: PublicKey, shares: BN | bigint) {
    // A v3 vault whose trading closed before graduation still holds public principal
    // in escrow: that stays a pre_withdraw refund, not a terminal redemption.
    if (state.status & STATUS.preDeposit) return this.preWithdraw(vault, state, user, shares);
    return this.tradingWithdrawalInstruction(vault, state, user, shares);
  }
  /** Trading shares use the queue even while public funds remain in escrow. */
  tradingWithdrawalInstruction(vault: PublicKey, state: VaultAccount, user: PublicKey, shares: BN | bigint) {
    if (state.status & STATUS.closed) return this.terminalRedeem(vault, state, user, shares);
    if (state.status & STATUS.withdrawalsPaused) throw new Error('Withdrawals are paused');
    return this.requestWithdraw(vault, state, user, shares);
  }

  setDepositPermission(vault: PublicKey, admin: PublicKey, user: PublicKey, approved: boolean) {
    return this.instruction('setDepositPermission', { vault, admin, user,
      depositor: deriveDepositor(this.programId, vault, user), systemProgram: PublicKey.default }, { approved });
  }
  /** Pricing account keys use IDL dot paths, including pricing.fermi.*. Once the
   * vault holds perp positions, `health` must end with their event queues:
   * pass `await client.withEventQueues(coreHealth)`. */
  permissionedDepositInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey,
    amount: BN | bigint, minShares: BN | bigint, pricingAccounts: Record<string, PublicKey>, health: AccountMeta[]) {
    if (state.version !== 3 || state.status & (STATUS.depositsPaused | STATUS.breaker | STATUS.unwind | STATUS.closed)) throw new Error('Permissioned deposits are unavailable');
    unsigned(amount, 8); unsigned(minShares, 8);
    return [this.shareAtaInstructions(state, user).instruction,
      this.instruction('permissionedDeposit', { ...pricingAccounts, vault, depositor: deriveDepositor(this.programId, vault, user), user,
        userQuoteAccount: getAssociatedTokenAddressSync(state.quoteMint, user, true),
        userShareAccount: getAssociatedTokenAddressSync(state.shareMint, user, true, TOKEN_2022_PROGRAM_ID),
        depositEscrow: state.depositEscrow }, { amount: new BN(amount.toString()), minShares: new BN(minShares.toString()) }, health)];
  }
  /** Approved wallet, before graduation only: redeem `shares` at once at the
   * current NAV_low price (after fee accrual) less the withdrawal fee, with the
   * payout checks of a close, while no older batch is deferred (FIFO,
   * `DeferredWithdrawalFirst`); `minQuote` bounds the net quote received. Pricing
   * accounts and `health` (ending with the event queues) as for
   * `permissionedDepositInstructions`. After graduation use the epoch queue. */
  permissionedWithdraw(vault: PublicKey, state: VaultAccount, user: PublicKey, shares: BN | bigint, minQuote: BN | bigint,
    pricingAccounts: Record<string, PublicKey>, health: AccountMeta[]) {
    if (state.version !== 3 || vaultMode(state.status) !== 'pre-deposit' || state.status & (STATUS.breaker | STATUS.unwind)) throw new Error('Approved-wallet withdrawals are available only before graduation, outside recovery');
    if (state.status & STATUS.withdrawalsPaused) throw new Error('Withdrawals are paused');
    if (!state.deferredHead.eq(NONE_EPOCH)) throw new Error('An older withdrawal batch is deferred; it is funded first');
    unsigned(shares, 8); unsigned(minQuote, 8);
    return this.instruction('permissionedWithdraw', { ...pricingAccounts, vault, depositor: deriveDepositor(this.programId, vault, user), user,
      userQuoteAccount: getAssociatedTokenAddressSync(state.quoteMint, user, true),
      userShareAccount: getAssociatedTokenAddressSync(state.shareMint, user, true, TOKEN_2022_PROGRAM_ID) },
      { shares: new BN(shares.toString()), minQuote: new BN(minQuote.toString()) }, health);
  }
  /** Graduation activates a matured delegate proposal on the way but does not
   * need one. `health` must end with the event queues of any active perp positions
   * (`await client.withEventQueues(coreHealth)`). */
  graduate(vault: PublicKey, state: VaultAccount, admin: PublicKey, pricingAccounts: Record<string, PublicKey>, health: AccountMeta[]) {
    if (state.version !== 3 || vaultMode(state.status) !== 'pre-deposit') throw new Error('Graduation is unavailable');
    // Public principal must stay refundable up to the conversion; the program refuses otherwise.
    if (state.status & STATUS.withdrawalsPaused) throw new Error('Withdrawals are paused; graduation must wait');
    return this.instruction('graduate', { ...pricingAccounts, vault, admin, depositEscrow: state.depositEscrow }, {}, health);
  }
  claimPreDeposit(vault: PublicKey, state: VaultAccount, originalUser: PublicKey) {
    return this.instruction('claimPreDeposit', this.userAccounts(vault, state, originalUser));
  }
  /** Public principal can still be refunded if internal trading closes before graduation. */
  publicRefundInstruction(vault: PublicKey, state: VaultAccount, user: PublicKey, amount: BN | bigint) {
    if (!(state.status & STATUS.preDeposit)) throw new Error('Public principal already graduated; claim shares and use the withdrawal queue');
    return this.preWithdraw(vault, state, user, amount);
  }
  /** Buy residual core inventory during full recovery. The program enforces a
   * conservative oracle/stable price and the caller's maximum quote payment. */
  recoverTokenInstructions(vault: PublicKey, state: VaultAccount, buyer: PublicKey,
    tokenMint: PublicKey, amount: BN | bigint, maxQuote: BN | bigint,
    recoveryAccounts: Record<string, PublicKey>, health: AccountMeta[]) {
    if (!(state.status & STATUS.unwind) || state.unwind.mode !== 2) throw new Error('Full recovery is required');
    unsigned(amount, 8); unsigned(maxQuote, 8);
    const authority = this.userAccounts(vault, state, buyer).authority;
    const idleAccount = getAssociatedTokenAddressSync(state.quoteMint, authority, true);
    const buyerTokenAccount = getAssociatedTokenAddressSync(tokenMint, buyer, true);
    return [
      createAssociatedTokenAccountIdempotentInstruction(buyer, idleAccount, authority, state.quoteMint),
      createAssociatedTokenAccountIdempotentInstruction(buyer, buyerTokenAccount, buyer, tokenMint),
      this.instruction('recoverToken', { ...recoveryAccounts, vault, authority, buyer,
        buyerQuoteAccount: getAssociatedTokenAddressSync(state.quoteMint, buyer, true),
        buyerTokenAccount, idleAccount }, { amount: new BN(amount.toString()), maxQuote: new BN(maxQuote.toString()) }, health),
    ];
  }
  shareAtaInstructions(state: VaultAccount, user: PublicKey, payer = user) {
    const address = getAssociatedTokenAddressSync(state.shareMint, user, true, TOKEN_2022_PROGRAM_ID);
    return { address, instruction: createAssociatedTokenAccountIdempotentInstruction(payer, address, user, state.shareMint, TOKEN_2022_PROGRAM_ID) };
  }
}
