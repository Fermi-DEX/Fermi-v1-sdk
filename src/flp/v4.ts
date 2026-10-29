/** Mainnet RC6.1/v4 builders. Legacy FLP callers continue to use ./index. */
import { Buffer } from 'buffer';
import { BN, BorshCoder, EventParser, Idl } from '@coral-xyz/anchor';
import { AccountMeta, Connection, PublicKey, SYSVAR_RENT_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import schema from './idl/flp_vault_v4.json';
import { FlpClient, VaultAccount, VaultParamsInput, EpochAccount, DepositorAccount, NONE_EPOCH, STATUS,
  DEFAULT_EQUITY_BATCHES, MAX_EQUITY_BATCHES, RecoveryMarket, recoveryMarketMetas,
  deriveVaultAddresses, deriveDepositor, deriveEpoch, deriveFermiAccount, deriveRecoveryTargets,
  decodeVaultExtension, depositsHeld } from './index';

/** Public source and recorded mainnet build evidence; not a live deployment attestation. */
export const FLP_V4_RELEASE = Object.freeze({
  sourceRepository: 'https://github.com/Fermi-DEX/fermi-v1-programs',
  sourceCommit: '623f113075bd124948eabac8589bfbe8c53b11e8',
  integrationProfile: 'rc6.1', vaultVersion: 4, fundingWindowVersion: 1,
  cluster: 'mainnet-beta',
  vaultProgram: 'FLPRrDPN5tJpLx6wY6FUiGFN5Kws8gHUCYMCcs6Goa9Q',
  coreProgram: 'FRMiX94PWHbndvySq8xyRx185GvPeggUeKaLmZgVdd4',
  vaultElfBytes: 1776216,
  vaultElfSha256: '4cd0f7787be53a52195ff21bc34797f3eb40de1810d17443d883f1533f59f36e',
  executableHash: '5e03fd650b2d724636460edfa8f46d2b1435a4530f9999855d5573504b12c263',
  deploymentSlot: 461700429,
  idlSha256: '022363b3b6b18160c90fc10dc56f8dc2eb3416669ccdf2f5d2021db90e0cf7b7',
});
export const FLP_V4_IDL = schema as Idl;
export type V4Accounts = Record<string, PublicKey>;
export interface FundingWindowAccount {
  vault: PublicKey; version: number; closedEpoch: BN; scheduledStart: BN; deadline: BN; eligible: boolean;
}
export function deriveFundingWindow(program: PublicKey, vault: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('funding_window'), vault.toBuffer()], program)[0];
}
export function fundingWindowIsCurrent(window: FundingWindowAccount, vault: PublicKey, state: VaultAccount): boolean {
  return window.version === 1 && window.vault.equals(vault) && !window.closedEpoch.isNeg() && window.closedEpoch.bitLength() <= 64 && window.closedEpoch.lt(new BN(2).pow(new BN(64)).subn(1)) && window.closedEpoch.addn(1).eq(state.epoch);
}
export function fundingWindowIsOpen(window: FundingWindowAccount, now: BN | bigint): boolean {
  const time = new BN(now.toString());
  return window.eligible && time.gte(window.scheduledStart) && time.lte(window.deadline);
}
/** `extendPartialUnwindV2` reduction bounds in bps: the program cuts each remaining
 * target by at least half (`recovery.rs` extend_targets). `triggerPartialUnwind` takes 1 to 10,000. */
export const PARTIAL_EXTENSION_BPS = Object.freeze({ min: 5000, max: 10000 });
/** RC6 has no numerical Init-health breaker or pending-settlement skip reason. */
export const V4_FUNDING_FAILURE = { fundable: 0, nonpositiveNav: 1, cashShortage: 2, bankLiquidity: 4, coreFundingRequired: 6 } as const;
/** Only a current cash-shortage failure opens the public recovery clock. */
export function permissionlessTriggerAt(state: VaultAccount, full: boolean): BN | null {
  if (state.version !== 4) throw new Error('Expected a fresh v4 vault');
  const current = state.headSkipReason === undefined ? decodeVaultExtension(state) : state;
  if (current.headSkipReason !== V4_FUNDING_FAILURE.cashShortage || !current.headEligibleFailTs || current.headEligibleFailTs.lten(0)) return null;
  if (full && current.unwind.mode !== 1) return null;
  return current.headEligibleFailTs.addn(full ? state.recoveryParams.graceFullS : state.recoveryParams.graceProportionalS);
}
/** Exact integer payout arithmetic. Ratio and fee must come from current authenticated chain evidence. */
export function batchPayout(shares: bigint, numerator: bigint, denominator: bigint, feeBps: number) {
  for (const n of [shares, numerator, denominator]) if (n < 0n) throw new Error('Negative payout input');
  if (!denominator || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) throw new Error('Invalid payout ratio or fee');
  const maxU128 = (1n << 128n) - 1n;
  if (numerator > maxU128 || denominator > maxU128 || shares * numerator > maxU128) throw new Error('Payout ratio exceeds u128');
  const gross = shares * numerator / denominator;
  if (gross > (1n << 64n) - 1n || shares > (1n << 64n) - 1n) throw new Error('Payout exceeds u64');
  const fee = gross * BigInt(feeBps) / 10000n;
  return { shares, gross, fee, net: gross - fee };
}
function uint(value: BN | bigint | number, bits: number): BN {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Expected a safe integer');
  const n = new BN(value.toString());
  if (n.isNeg() || n.bitLength() > bits) throw new Error(`Expected u${bits}`);
  return n;
}
function capacity(perps: number, orders: number, initial = false): void {
  uint(perps, 8); uint(orders, 8);
  if (perps < 1 || perps > 13 || orders < 1 || orders > 64) throw new Error('Unsupported market capacity');
  if (initial && 704 + 304 * perps + 96 * orders > 10240) throw new Error('Initial account exceeds 10240 bytes; create smaller and expand');
}

export class FlpV4Client {
  readonly coder = new BorshCoder(FLP_V4_IDL);
  readonly accountsCoder = this.coder.accounts;
  readonly instructionCoder = this.coder.instruction;
  readonly eventCoder = this.coder.events;
  /** Reuse queue discovery and ATA preparation only, never legacy instruction encoding. */
  private readonly shared: FlpClient;
  constructor(readonly connection: Connection, readonly programId: PublicKey) {
    this.shared = new FlpClient(connection, programId);
  }
  parseEvents(logs: string[]) { return [...new EventParser(this.programId, this.coder).parseLogs(logs)]; }
  instruction(name: string, accounts: V4Accounts, args: Record<string, unknown> = {}, remaining: AccountMeta[] = []): TransactionInstruction {
    const definition = FLP_V4_IDL.instructions.find(ix => ix.name === name);
    if (!definition) throw new Error(`Unknown FLP v4 instruction: ${name}`);
    const keys: AccountMeta[] = [];
    const visit = (items: typeof definition.accounts, prefix = '') => {
      for (const item of items) {
        const name = prefix + item.name;
        if ('accounts' in item) visit(item.accounts, name + '.');
        else {
          const pubkey = accounts[name];
          if (item.isOptional && (!pubkey || pubkey.equals(this.programId))) keys.push({ pubkey: this.programId, isWritable: false, isSigner: false });
          else if (!pubkey) throw new Error(`Missing FLP v4 account: ${name}`);
          else keys.push({ pubkey, isWritable: item.isMut, isSigner: item.isSigner });
        }
      }
    };
    visit(definition.accounts);
    return new TransactionInstruction({ programId: this.programId, keys: [...keys, ...remaining], data: this.coder.instruction.encode(name, args) });
  }
  async fetch<T>(name: 'Vault' | 'Depositor' | 'EpochRecord' | 'FundingWindow' | 'RecoveryTargets', address: PublicKey): Promise<T> {
    const info = await this.connection.getAccountInfo(address, 'confirmed');
    if (!info || !info.owner.equals(this.programId)) throw new Error(`Missing or wrong-owner ${name}`);
    const definition = FLP_V4_IDL.accounts!.find(a => a.name === name)!;
    if (info.data.length !== this.coder.accounts.size(definition)) throw new Error(`Unsupported ${name} layout`);
    return this.coder.accounts.decode<T>(name, info.data);
  }
  async fetchVault(vault: PublicKey): Promise<VaultAccount> {
    const state = decodeVaultExtension(await this.fetch<VaultAccount>('Vault', vault));
    if (state.version !== 4) throw new Error('Expected a fresh v4 vault');
    if (!state.fermiAccount.equals(PublicKey.default) && !state.expandedRecovery) throw new Error('Expected a v4 recovery sidecar');
    // The sidecar exists for every initialized core account, including inactive recovery.
    if (!state.fermiAccount.equals(PublicKey.default)) {
      const targets = await this.fetch<{ vault: PublicKey; mode: number; batchEpoch: BN; startedAt: BN; marketIndexes: number[]; targetBaseLots: BN[] }>('RecoveryTargets', deriveRecoveryTargets(this.programId, vault));
      if (!targets.vault.equals(vault)) throw new Error('Recovery target vault mismatch');
      if (state.unwind.mode !== 0) {
        if (targets.mode !== state.unwind.mode || !targets.batchEpoch.eq(state.unwind.batchEpoch) || !targets.startedAt.eq(state.unwind.startedAt)) throw new Error('Recovery changed; refresh vault state');
        state.unwind = { ...state.unwind, marketIndexes: targets.marketIndexes, targetBaseLots: targets.targetBaseLots };
      }
    }
    return state;
  }
  async fetchDepositor(vault: PublicKey, user: PublicKey) {
    const record = await this.fetch<DepositorAccount>('Depositor', deriveDepositor(this.programId, vault, user));
    if (!record.vault.equals(vault) || !record.user.equals(user)) throw new Error('Depositor identity mismatch');
    return record;
  }
  async fetchEpoch(vault: PublicKey, epoch: BN | bigint) {
    const generation = uint(epoch, 64);
    const record = await this.fetch<EpochAccount>('EpochRecord', deriveEpoch(this.programId, vault, generation));
    if (!record.vault.equals(vault) || !record.epoch.eq(generation)) throw new Error('Epoch identity mismatch');
    return record;
  }
  async fetchFundingWindow(vault: PublicKey, state: VaultAccount) {
    const window = await this.fetch<FundingWindowAccount>('FundingWindow', deriveFundingWindow(this.programId, vault));
    if (!fundingWindowIsCurrent(window, vault, state)) throw new Error('Funding window changed; refresh vault state');
    return window;
  }
  authority(vault: PublicKey) { return this.shared.authority(vault); }
  withEventQueues(health: AccountMeta[]) { return this.shared.withEventQueues(health); }
  recoveryMetas(vault: PublicKey, writable = false): AccountMeta[] {
    return [{ pubkey: deriveRecoveryTargets(this.programId, vault), isSigner: false, isWritable: writable }];
  }
  initializeVault(vaultId: number, group: PublicKey, admin: PublicKey, quoteBank: PublicKey, quoteMint: PublicKey,
    params: VaultParamsInput, guardian: PublicKey, feeRecipient: PublicKey) {
    uint(vaultId, 16);
    const addresses = deriveVaultAddresses(this.programId, group, vaultId);
    return this.instruction('initializeVaultV4', { ...addresses, group, admin, quoteBank, quoteMint,
      fundingWindow: deriveFundingWindow(this.programId, addresses.vault), tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: PublicKey.default, rent: SYSVAR_RENT_PUBKEY },
    { vaultId, params, guardian, feeRecipient });
  }
  seedVault(vault: PublicKey, state: VaultAccount, accounts: V4Accounts, amount: BN | bigint, health: AccountMeta[]) {
    this.requireV4(state);
    return this.instruction('seedVaultV4', { ...accounts, vault, authority: this.authority(vault), quoteMint: state.quoteMint,
      shareMint: state.shareMint, token2022Program: TOKEN_2022_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: PublicKey.default }, { amount: uint(amount, 64) }, health);
  }
  initFermiAccount(vault: PublicKey, state: VaultAccount, admin: PublicKey, coreProgram: PublicKey, perps: number, orders: number) {
    this.requireV4(state);
    capacity(perps, orders, true);
    if (!state.fermiAccount.equals(PublicKey.default)) throw new Error('The vault already has its FermiAccount');
    const authority = this.authority(vault);
    return this.instruction('initFermiAccountV4', { vault, authority, admin, 'fermi.group': state.group,
      'fermi.fermiAccount': deriveFermiAccount(coreProgram, state.group, authority, state.vaultId), 'fermi.fermiProgram': coreProgram,
      recoveryTargets: deriveRecoveryTargets(this.programId, vault), systemProgram: PublicKey.default }, { perpCount: perps, perpOoCount: orders, tokenCount: 1 });
  }
  expandMarketCapacity(vault: PublicKey, state: VaultAccount, admin: PublicKey, coreProgram: PublicKey, perps: number, orders: number) {
    this.requireV4(state);
    capacity(perps, orders);
    if (state.status & (STATUS.unwind | STATUS.closed)) throw new Error('Capacity cannot grow during recovery or after closure');
    return this.instruction('expandMarketCapacity', { vault, authority: this.authority(vault), admin,
      'fermi.group': state.group, 'fermi.fermiAccount': state.fermiAccount, 'fermi.fermiProgram': coreProgram,
      recoveryTargets: deriveRecoveryTargets(this.programId, vault), systemProgram: PublicKey.default }, { perpCount: perps, perpOoCount: orders });
  }
  initDepositor(vault: PublicKey, user: PublicKey, payer = user) {
    return this.instruction('initDepositor', { vault, user, payer, depositor: deriveDepositor(this.programId, vault, user), systemProgram: PublicKey.default });
  }
  private requireV4(state: VaultAccount): void {
    if (state.version !== 4) throw new Error('Expected a fresh v4 vault');
  }
  private userAccounts(vault: PublicKey, state: VaultAccount, user: PublicKey): V4Accounts {
    this.requireV4(state);
    return { vault, user, authority: this.authority(vault), depositor: deriveDepositor(this.programId, vault, user),
      userQuoteAccount: getAssociatedTokenAddressSync(state.quoteMint, user, true),
      userShareAccount: getAssociatedTokenAddressSync(state.shareMint, user, true, TOKEN_2022_PROGRAM_ID),
      shareMint: state.shareMint, depositEscrow: state.depositEscrow, redemptionEscrow: state.redemptionEscrow,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: PublicKey.default };
  }
  /** Always prepare in the same transaction. No account-existence read or extra user signature. */
  requestDepositInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey, amount: BN | bigint, payer = user) {
    return [this.initDepositor(vault, user, payer), this.instruction('requestDeposit', this.userAccounts(vault, state, user), { amount: uint(amount, 64) })];
  }
  preDepositInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey, amount: BN | bigint, payer = user) {
    return [this.initDepositor(vault, user, payer), this.instruction('preDepositV3', this.userAccounts(vault, state, user), { amount: uint(amount, 64) })];
  }
  preWithdrawInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey, amount: BN | bigint, payer = user) {
    return this.preparedUser('preWithdrawV3', vault, state, user, { amount: uint(amount, 64) }, {}, payer, false, true);
  }
  terminalRedeemInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey, shares: BN | bigint, payer = user) {
    return this.preparedUser('terminalRedeem', vault, state, user, { shares: uint(shares, 64) }, {}, payer, true, true);
  }
  setDepositPermissionInstructions(vault: PublicKey, admin: PublicKey, user: PublicKey, approved: boolean, payer = admin) {
    return [this.initDepositor(vault, user, payer), this.instruction('setDepositPermission', { vault, admin, user,
      depositor: deriveDepositor(this.programId, vault, user), systemProgram: PublicKey.default }, { approved })];
  }
  permissionedDepositInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey, amount: BN | bigint,
    minShares: BN | bigint, pricing: V4Accounts, healthAndQueues: AccountMeta[], payer = user) {
    return [this.initDepositor(vault, user, payer), this.shared.shareAtaInstructions(state, user, payer).instruction,
      this.instruction('permissionedDeposit', { ...pricing, ...this.userAccounts(vault, state, user) },
        { amount: uint(amount, 64), minShares: uint(minShares, 64) }, healthAndQueues)];
  }
  /** Every typed Depositor consumer prepares the PDA in the same transaction. */
  private preparedUser(name: string, vault: PublicKey, state: VaultAccount, user: PublicKey,
    args: Record<string, unknown> = {}, extra: V4Accounts = {}, payer = user, shareAta = false, quoteAta = false) {
    const preparation = [this.initDepositor(vault, user, payer)];
    if (shareAta) preparation.push(this.shared.shareAtaInstructions(state, user, payer).instruction);
    if (quoteAta) preparation.push(createAssociatedTokenAccountIdempotentInstruction(payer,
      getAssociatedTokenAddressSync(state.quoteMint, user, true), user, state.quoteMint));
    return [...preparation, this.instruction(name, { ...extra, ...this.userAccounts(vault, state, user) }, args)];
  }
  requestWithdrawInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey, shares: BN | bigint, payer = user) {
    return this.preparedUser('requestWithdraw', vault, state, user, { shares: uint(shares, 64) }, {}, payer);
  }
  cancelDepositInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey, payer = user) {
    return this.preparedUser('cancelDeposit', vault, state, user, {}, {}, payer, false, true);
  }
  cancelWithdrawInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey, payer = user) {
    return this.preparedUser('cancelWithdraw', vault, state, user, {}, {}, payer, true);
  }
  claimPreDepositInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey, payer = user) {
    return this.preparedUser('claimPreDeposit', vault, state, user, {}, {}, payer, true);
  }
  claimDepositInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey, epoch: BN | bigint, payer = user) {
    return this.preparedUser('claimDeposit', vault, state, user, {},
      { epochRecord: deriveEpoch(this.programId, vault, uint(epoch, 64)) }, payer, true);
  }
  refundPendingDepositInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey, epoch?: BN | bigint, payer = user) {
    return this.preparedUser('refundPendingDeposit', vault, state, user, {},
      { epochRecord: epoch === undefined ? this.programId : deriveEpoch(this.programId, vault, uint(epoch, 64)) }, payer, false, true);
  }
  settleDepositInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey, record: EpochAccount, payer = user) {
    if (!record.vault.equals(vault)) throw new Error('Epoch identity mismatch');
    return depositsHeld(record) ? this.refundPendingDepositInstructions(vault, state, user, record.epoch, payer)
      : this.claimDepositInstructions(vault, state, user, record.epoch, payer);
  }
  claimWithdrawalInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey, epoch: BN | bigint, payer = user) {
    return this.preparedUser('claimWithdrawal', vault, state, user, {},
      { epochRecord: deriveEpoch(this.programId, vault, uint(epoch, 64)) }, payer, false, true);
  }
  permissionedWithdrawInstructions(vault: PublicKey, state: VaultAccount, user: PublicKey, shares: BN | bigint,
    minQuote: BN | bigint, pricing: V4Accounts, healthAndQueues: AccountMeta[], payer = user) {
    const preparation = this.preparedUser('permissionedWithdraw', vault, state, user,
      { shares: uint(shares, 64), minQuote: uint(minQuote, 64) }, pricing, payer, false, true);
    const last = preparation.pop()!;
    last.keys.push(...healthAndQueues);
    return [...preparation, last];
  }
  graduate(vault: PublicKey, state: VaultAccount, admin: PublicKey, pricing: V4Accounts, healthAndQueues: AccountMeta[]) {
    this.requireV4(state);
    return this.instruction('graduate', { ...pricing, vault, admin, depositEscrow: state.depositEscrow }, {}, healthAndQueues);
  }
  setStatus(vault: PublicKey, signer: PublicKey, setFlags: number, clearFlags: number) {
    return this.instruction('setStatus', { vault, signer }, { setFlags: uint(setFlags, 8).toNumber(), clearFlags: uint(clearFlags, 8).toNumber() });
  }
  stageParams(vault: PublicKey, admin: PublicKey, params: VaultParamsInput) {
    return this.instruction('stageParamsV3', { vault, admin }, { params });
  }
  applyParams(vault: PublicKey, admin: PublicKey) { return this.instruction('applyParams', { vault, admin }); }
  stageRecoveryParams(vault: PublicKey, admin: PublicKey,
    params: { graceProportionalS: number; graceFullS: number; oracleBandBps: number; maxStepQuote: BN }) {
    return this.instruction('stageRecoveryParams', { vault, admin }, { params });
  }
  applyRecoveryParams(vault: PublicKey, admin: PublicKey) { return this.instruction('applyRecoveryParams', { vault, admin }); }
  setRoles(vault: PublicKey, admin: PublicKey, guardian: PublicKey, feeRecipient: PublicKey) {
    return this.instruction('setRoles', { vault, admin }, { guardian, feeRecipient });
  }
  proposeAdmin(vault: PublicKey, admin: PublicKey, newAdmin: PublicKey) { return this.instruction('proposeAdmin', { vault, admin }, { newAdmin }); }
  acceptAdmin(vault: PublicKey, newAdmin: PublicKey) { return this.instruction('acceptAdmin', { vault, newAdmin }); }
  proposeDelegate(vault: PublicKey, admin: PublicKey, delegate: PublicKey) { return this.instruction('proposeDelegate', { vault, admin }, { delegate }); }
  private coreAccounts(vault: PublicKey, state: VaultAccount, coreProgram: PublicKey): V4Accounts {
    this.requireV4(state);
    return { vault, authority: this.authority(vault), 'fermi.group': state.group,
      'fermi.fermiAccount': state.fermiAccount, 'fermi.fermiProgram': coreProgram };
  }
  activateDelegate(vault: PublicKey, state: VaultAccount, signer: PublicKey, coreProgram: PublicKey) {
    return this.instruction('activateDelegate', { ...this.coreAccounts(vault, state, coreProgram), signer });
  }
  removeDelegate(vault: PublicKey, state: VaultAccount, signer: PublicKey, coreProgram: PublicKey) {
    return this.instruction('removeDelegate', { ...this.coreAccounts(vault, state, coreProgram), signer });
  }
  cancelOrders(vault: PublicKey, state: VaultAccount, signer: PublicKey, coreProgram: PublicKey, markets: AccountMeta[]) {
    return this.instruction('cancelOrders', { ...this.coreAccounts(vault, state, coreProgram), signer }, {}, markets);
  }
  deactivatePerpPosition(vault: PublicKey, state: VaultAccount, coreProgram: PublicKey, perpMarket: PublicKey) {
    return this.instruction('deactivatePerpPosition', { ...this.coreAccounts(vault, state, coreProgram), perpMarket });
  }
  checkBreaker(vault: PublicKey, state: VaultAccount, accounts: V4Accounts, healthAndQueues: AccountMeta[]) {
    return this.instruction('checkBreaker', this.flowAccounts(vault, state, accounts), {}, healthAndQueues);
  }
  resetBreaker(vault: PublicKey, state: VaultAccount, admin: PublicKey, accounts: V4Accounts, healthAndQueues: AccountMeta[]) {
    return this.instruction('resetBreaker', { ...this.flowAccounts(vault, state, accounts), admin }, {}, healthAndQueues);
  }
  /** Require authenticated current-generation evidence and a caller-supplied chain timestamp before funding. */
  async fundHeadIfOpen(vault: PublicKey, state: VaultAccount, accounts: V4Accounts, health: AccountMeta[], chainTime: BN | bigint) {
    const window = await this.fetchFundingWindow(vault, state);
    if (!fundingWindowIsOpen(window, chainTime)) throw new Error('Funding window is not open');
    return this.fundHead(vault, state, accounts, health);
  }
  private flowAccounts(vault: PublicKey, state: VaultAccount, accounts: V4Accounts): V4Accounts {
    this.requireV4(state);
    return { ...accounts, vault, authority: this.authority(vault), fundingWindow: deriveFundingWindow(this.programId, vault),
      headRecord: state.deferredHead.eq(NONE_EPOCH) ? this.programId : deriveEpoch(this.programId, vault, state.deferredHead),
      shareMint: state.shareMint, depositEscrow: state.depositEscrow, redemptionEscrow: state.redemptionEscrow,
      token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: PublicKey.default };
  }
  async closeEpoch(vault: PublicKey, state: VaultAccount, accounts: V4Accounts, health: AccountMeta[], maxBatches = DEFAULT_EQUITY_BATCHES) {
    if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > MAX_EQUITY_BATCHES) throw new Error('Unsupported deferred batch count');
    const batches: AccountMeta[] = [], seen = new Set<string>();
    let next = state.deferredHead;
    while (!next.eq(NONE_EPOCH) && batches.length < maxBatches) {
      if (seen.has(next.toString())) throw new Error('Invalid deferred queue cycle');
      seen.add(next.toString());
      const record = await this.fetchEpoch(vault, next);
      if (!record.vault.equals(vault) || !record.epoch.eq(next) || record.wdStatus !== 2) throw new Error('Deferred queue changed; refresh vault state');
      batches.push({ pubkey: deriveEpoch(this.programId, vault, next), isWritable: true, isSigner: false });
      next = record.nextDeferred;
    }
    return this.instruction('closeEpochV4', { ...this.flowAccounts(vault, state, accounts), epochRecord: deriveEpoch(this.programId, vault, state.epoch),
      deferredTailRecord: state.deferredTail.eq(NONE_EPOCH) ? this.programId : deriveEpoch(this.programId, vault, state.deferredTail) },
    { deferredBatchCount: batches.length }, [...batches, ...await this.withEventQueues(health), ...(state.status & STATUS.unwind ? this.recoveryMetas(vault, true) : [])]);
  }
  async fundHead(vault: PublicKey, state: VaultAccount, accounts: V4Accounts, health: AccountMeta[]) {
    if (state.deferredHead.eq(NONE_EPOCH)) throw new Error('No deferred head');
    return this.instruction('fundHeadV2', this.flowAccounts(vault, state, accounts), {},
      [...await this.withEventQueues(health), ...(state.status & STATUS.unwind ? this.recoveryMetas(vault) : [])]);
  }
  async sweepIdle(vault: PublicKey, state: VaultAccount, accounts: V4Accounts, health: AccountMeta[], maxAmount: BN | bigint) {
    if (state.status & (STATUS.unwind | STATUS.closed)) throw new Error('Sweeps are unavailable during recovery or after closure');
    return this.instruction('sweepIdleV2', this.flowAccounts(vault, state, accounts), { maxAmount: uint(maxAmount, 64) }, await this.withEventQueues(health));
  }
  async cureDeferred(vault: PublicKey, state: VaultAccount, signer: PublicKey, accounts: V4Accounts, health: AccountMeta[]) {
    if (state.deferredHead.eq(NONE_EPOCH) || state.status & (STATUS.unwind | STATUS.closed)) throw new Error('No eligible deferred head');
    return this.instruction('cureDeferredV2', { ...this.flowAccounts(vault, state, accounts), signer }, {}, await this.withEventQueues(health));
  }
  triggerUnwind(vault: PublicKey, state: VaultAccount, signer: PublicKey, coreProgram: PublicKey, markets: RecoveryMarket[], full: boolean, head?: BN | bigint) {
    return this.instruction('triggerUnwind', { ...this.flowAccounts(vault, state, {}), signer,
      'fermi.group': state.group, 'fermi.fermiAccount': state.fermiAccount, 'fermi.fermiProgram': coreProgram,
      deferredRecord: head === undefined ? this.programId : deriveEpoch(this.programId, vault, head) }, { full },
    [...recoveryMarketMetas(markets), ...this.recoveryMetas(vault, true)]);
  }
  triggerPartialUnwind(vault: PublicKey, state: VaultAccount, signer: PublicKey, coreProgram: PublicKey, markets: RecoveryMarket[], fractionBps: number) {
    if (fractionBps < 1 || fractionBps > 10000) throw new Error('Invalid reduction');
    return this.instruction('triggerPartialUnwind', { ...this.flowAccounts(vault, state, {}), signer,
      'fermi.group': state.group, 'fermi.fermiAccount': state.fermiAccount, 'fermi.fermiProgram': coreProgram, deferredRecord: this.programId },
    { fractionBps: uint(fractionBps, 16).toNumber() }, [...recoveryMarketMetas(markets), ...this.recoveryMetas(vault, true)]);
  }
  unwindStep(vault: PublicKey, state: VaultAccount, accounts: V4Accounts, health: AccountMeta[], maxBaseLots: BN | bigint) {
    const size = uint(maxBaseLots, 63);
    if (size.isZero()) throw new Error('maxBaseLots must be positive');
    return this.instruction('unwindStepV2', this.flowAccounts(vault, state, accounts), { maxBaseLots: size }, [...health, ...this.recoveryMetas(vault)]);
  }
  finishUnwind(vault: PublicKey, state: VaultAccount, accounts: V4Accounts, health: AccountMeta[]) {
    return this.instruction('finishUnwind', this.flowAccounts(vault, state, accounts), {}, [...health, ...this.recoveryMetas(vault)]);
  }
  abortUnwind(vault: PublicKey, admin: PublicKey) {
    return this.instruction('abortUnwind', { vault, admin }, {}, this.recoveryMetas(vault, true));
  }
  async extendPartialUnwind(vault: PublicKey, state: VaultAccount, accounts: V4Accounts, health: AccountMeta[], reductionBps: number) {
    if (!Number.isInteger(reductionBps) || reductionBps < PARTIAL_EXTENSION_BPS.min || reductionBps > PARTIAL_EXTENSION_BPS.max)
      throw new Error(`Invalid reduction: extendPartialUnwindV2 takes ${PARTIAL_EXTENSION_BPS.min} to ${PARTIAL_EXTENSION_BPS.max} bps`);
    return this.instruction('extendPartialUnwindV2', this.flowAccounts(vault, state, accounts), { reductionBps: uint(reductionBps, 16).toNumber() },
      [...await this.withEventQueues(health), ...this.recoveryMetas(vault, true)]);
  }
  private requireForeignMint(state: VaultAccount, mint: PublicKey) {
    if (mint.equals(state.quoteMint) || mint.equals(state.shareMint)) throw new Error('Expected a foreign mint');
  }
  /** Transfer foreign tokens from the authority ATA to the admin ATA. No sale or quote payment. */
  rescueForeignTokenInstructions(vault: PublicKey, state: VaultAccount, admin: PublicKey, mint: PublicKey, amount: BN | bigint) {
    this.requireForeignMint(state, mint);
    const quantity = uint(amount, 64);
    if (quantity.isZero()) throw new Error('Rescue amount must be positive');
    const authority = this.authority(vault);
    const source = getAssociatedTokenAddressSync(mint, authority, true);
    const destination = getAssociatedTokenAddressSync(mint, admin, true);
    return [createAssociatedTokenAccountIdempotentInstruction(admin, destination, admin, mint),
      this.instruction('rescueForeignToken', { vault, authority, admin, mint, source, destination, tokenProgram: TOKEN_PROGRAM_ID }, { amount: quantity })];
  }
  /** Withdraw the full foreign core balance to its authority ATA. Core health accounts are mandatory inputs. */
  clearForeignCoreTokenInstructions(vault: PublicKey, state: VaultAccount, admin: PublicKey, coreProgram: PublicKey,
    mint: PublicKey, bank: PublicKey, bankVault: PublicKey, oracle: PublicKey, health: AccountMeta[]) {
    this.requireForeignMint(state, mint);
    const authority = this.authority(vault);
    const destination = getAssociatedTokenAddressSync(mint, authority, true);
    return [createAssociatedTokenAccountIdempotentInstruction(admin, destination, authority, mint),
      this.instruction('clearForeignCoreToken', { vault, authority, admin, mint, bank, bankVault, oracle, destination,
        'fermi.group': state.group, 'fermi.fermiAccount': state.fermiAccount, 'fermi.fermiProgram': coreProgram,
        tokenProgram: TOKEN_PROGRAM_ID }, {}, health)];
  }

}

export * from './math';
export type { VaultAccount, DepositorAccount, EpochAccount, VaultParamsInput, RecoveryMarket } from './index';
export { BN, STATUS, NONE_EPOCH, deriveVaultAddresses, deriveDepositor, deriveEpoch, deriveRecoveryTargets,
  deriveFermiAccount, recoveryMarketMetas, depositsHeld } from './index';
