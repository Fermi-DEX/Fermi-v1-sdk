/** Opt-in mainnet smoke support. No network access or signing occurs on import. */
import { createHash } from 'crypto';
import { BN, AnchorProvider } from '@coral-xyz/anchor';
import { AccountInfo, Connection, PublicKey, SYSVAR_CLOCK_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { getMint, getAssociatedTokenAddressSync, unpackAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { FermiV1AccountClient } from '../accountClient';
import { FERMI_R9_MAINNET } from '../deployments';
import { buildFlpPricingContext } from '../flpContext';
import { FlpV4Client, FLP_V4_RELEASE, deriveVaultAddresses, deriveFermiAccount, deriveDepositor,
  VaultAccount, STATUS, NONE_EPOCH, pricingSupply, claimPayout } from './v4';

export const MAINNET_SMOKE = Object.freeze({
  genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  vault: '8aHdjxJzec6CfBngSFZYQvqZsBtXWXG6j1C3rW799pbP', vaultId: 1,
  vaultProgram: FLP_V4_RELEASE.vaultProgram, coreProgram: FLP_V4_RELEASE.coreProgram,
  group: FERMI_R9_MAINNET.group, quoteMint: FERMI_R9_MAINNET.usdcMint,
  quoteBank: FERMI_R9_MAINNET.usdcBank, quoteBankVault: FERMI_R9_MAINNET.usdcVault,
  vaultProgramData: 'Fekec2bVaipgZ6XsKEpSqFobSnjNEUgwfi4qxGNsq4Px',
  coreProgramData: 'EMGzJcQNA8Ua7wMtkMmBoi1WBMgvUjQREkGdHxjeP2S7',
  coreElfBytes: 3777264,
  coreElfSha256: '29c6167e1e0eb4577215cf5a85a9646ed36b97c479ace0a71631b7fe71358aa9',
});
export class SmokeError extends Error {}
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export type SmokeAction = 'preflight' | 'status' | 'deposit' | 'request-withdraw' | 'claim';
export interface SmokeOptions {
  action: SmokeAction; transact: boolean; owner: string; amount?: string; cap?: string;
  minShares?: string; maxFeeLamports?: string; acknowledgeRisk: boolean;
}
export interface SmokeRecord {
  action: SmokeAction; amount?: string; cap?: string; minShares?: string; maxFeeLamports?: string;
  maxSolLamports?: string; estimatedSolDebitLamports?: string;
  status: 'prepared' | 'signed' | 'unknown' | 'confirmed' | 'finalized' | 'failed';
  signature?: string; solscan?: string; blockhash?: string; lastValidBlockHeight?: number;
  slot?: number; events?: { name: string; data: Record<string, any> }[];
  before: Record<string, any>; after?: Record<string, any>;
  transactionBalances?: { pre: unknown[]; post: unknown[] };
}
export interface SmokeReceipt {
  schemaVersion: 1; sourceCommit: string; owner: string; deployment: typeof MAINNET_SMOKE;
  flow: 'approved'; records: SmokeRecord[]; lastPreflight?: Record<string, any>; summary?: Record<string, any>;
}
export function publicJson(value: any): any {
  if (value instanceof PublicKey) return value.toBase58();
  if (BN.isBN(value) || typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(publicJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, publicJson(v)]));
  return value;
}
export function nativeAmount(value: string | undefined, name: string): bigint {
  if (!value || !/^[1-9][0-9]*$/.test(value)) throw new SmokeError(`${name} must be a positive native integer`);
  const n = BigInt(value);
  if (n >= 1n << 64n) throw new SmokeError(`${name} exceeds u64`);
  return n;
}
export function validateSmokeOptions(options: SmokeOptions): void {
  if (!['preflight', 'status', 'deposit', 'request-withdraw', 'claim'].includes(options.action)) throw new SmokeError('Unsupported smoke action');
  new PublicKey(options.owner);
  if (['deposit', 'request-withdraw'].includes(options.action)) {
    if (nativeAmount(options.amount, 'amount') > nativeAmount(options.cap, 'cap')) throw new SmokeError('Amount exceeds explicit cap');
  }
  if (options.action === 'deposit') nativeAmount(options.minShares, 'min-shares');
  if (options.transact) {
    if (['preflight', 'status'].includes(options.action)) throw new SmokeError('Read-only actions cannot transact');
    if (!options.acknowledgeRisk) throw new SmokeError('Explicit risk acknowledgement required');
    nativeAmount(options.maxFeeLamports, 'max-fee-lamports');
  }
}
export function newReceipt(owner: string): SmokeReceipt {
  return { schemaVersion: 1, sourceCommit: FLP_V4_RELEASE.sourceCommit, owner, deployment: MAINNET_SMOKE, flow: 'approved', records: [] };
}
export function validateReceipt(receipt: SmokeReceipt, owner: string): void {
  if (receipt.schemaVersion !== 1 || receipt.flow !== 'approved' || receipt.owner !== owner ||
    receipt.sourceCommit !== FLP_V4_RELEASE.sourceCommit || JSON.stringify(receipt.deployment) !== JSON.stringify(MAINNET_SMOKE) || !Array.isArray(receipt.records))
    throw new SmokeError('Receipt identity or deployment mismatch');
}
export function assertNoReplay(receipt: SmokeReceipt, action: SmokeAction): void {
  if (receipt.records.some(r => r.action === action)) throw new SmokeError('Action already recorded; use status with the original receipt. No automatic replacement.');
  if (receipt.records.some(r => !['confirmed', 'finalized'].includes(r.status))) throw new SmokeError('Earlier transaction unresolved or failed; reconcile original signature before any further action');
}
export function verifyProgramBytes(program: AccountInfo<Buffer> | null, data: AccountInfo<Buffer> | null,
  dataAddress: string, elfBytes: number, hash: string): void {
  if (!program || !data || !program.owner.equals(loader) || !program.executable || program.data.length !== 36 ||
    program.data.readUInt32LE(0) !== 2 || !new PublicKey(program.data.subarray(4)).equals(new PublicKey(dataAddress)))
    throw new SmokeError('Program executable/loader/ProgramData mismatch');
  if (!data.owner.equals(loader) || data.executable || data.data.length < 45 + elfBytes || data.data.readUInt32LE(0) !== 3)
    throw new SmokeError('Invalid ProgramData layout');
  if (createHash('sha256').update(data.data.subarray(45, 45 + elfBytes)).digest('hex') !== hash ||
    data.data.subarray(45 + elfBytes).some(byte => byte !== 0)) throw new SmokeError('Deployed ELF differs from pinned release; stop and review upgrade');
}
export function verifyVaultIdentity(state: VaultAccount, program: PublicKey, vault: PublicKey): void {
  const derived = deriveVaultAddresses(program, new PublicKey(MAINNET_SMOKE.group), MAINNET_SMOKE.vaultId);
  if (!vault.equals(derived.vault) || !vault.equals(new PublicKey(MAINNET_SMOKE.vault)) || state.version !== 4 || state.vaultId !== MAINNET_SMOKE.vaultId)
    throw new SmokeError('Wrong vault identity/version');
  for (const [key, expected] of Object.entries({ group: MAINNET_SMOKE.group, quoteMint: MAINNET_SMOKE.quoteMint, quoteBank: MAINNET_SMOKE.quoteBank,
    shareMint: derived.shareMint.toBase58(), depositEscrow: derived.depositEscrow.toBase58(), redemptionEscrow: derived.redemptionEscrow.toBase58(),
    fermiAccount: deriveFermiAccount(new PublicKey(MAINNET_SMOKE.coreProgram), new PublicKey(MAINNET_SMOKE.group), derived.authority, MAINNET_SMOKE.vaultId).toBase58() })) {
    if (!(state[key] instanceof PublicKey) || !(state[key] as PublicKey).equals(new PublicKey(expected))) throw new SmokeError(`Wrong vault ${key}`);
  }
}

export async function smokePreflight(connection: Connection, owner: PublicKey) {
  if (await connection.getGenesisHash() !== MAINNET_SMOKE.genesis) throw new SmokeError('RPC is not Solana mainnet-beta');
  const program = new PublicKey(MAINNET_SMOKE.vaultProgram), vault = new PublicKey(MAINNET_SMOKE.vault);
  for (const [programId, dataId, size, hash] of [
    [MAINNET_SMOKE.vaultProgram, MAINNET_SMOKE.vaultProgramData, FLP_V4_RELEASE.vaultElfBytes, FLP_V4_RELEASE.vaultElfSha256],
    [MAINNET_SMOKE.coreProgram, MAINNET_SMOKE.coreProgramData, MAINNET_SMOKE.coreElfBytes, MAINNET_SMOKE.coreElfSha256],
  ] as const) {
    const [programInfo, dataInfo] = await connection.getMultipleAccountsInfo([new PublicKey(programId), new PublicKey(dataId)], 'confirmed');
    verifyProgramBytes(programInfo, dataInfo, dataId, size, hash);
  }
  const client = new FlpV4Client(connection, program), state = await client.fetchVault(vault);
  verifyVaultIdentity(state, program, vault);
  // A read-only provider: any accidental signing path fails before touching a wallet.
  const wallet = { publicKey: owner, signTransaction: async () => { throw new SmokeError('Read-only provider'); },
    signAllTransactions: async () => { throw new SmokeError('Read-only provider'); } };
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const core = await FermiV1AccountClient.connect(provider, 'mainnet-beta', new PublicKey(MAINNET_SMOKE.coreProgram), { idsSource: 'get-program-accounts' });
  const pricing = await buildFlpPricingContext(core, client, vault, state);
  if (!pricing.accounts['fermi.quoteBankVault'].equals(new PublicKey(MAINNET_SMOKE.quoteBankVault))) throw new SmokeError('Wrong USDC bank vault');
  const quoteMint = await getMint(connection, state.quoteMint, 'confirmed', TOKEN_PROGRAM_ID);
  const shareMint = await getMint(connection, state.shareMint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  if (quoteMint.decimals !== 6 || shareMint.decimals !== 6 || !shareMint.mintAuthority?.equals(client.authority(vault))) throw new SmokeError('Unexpected mint interface');
  const address = deriveDepositor(program, vault, owner);
  const info = await connection.getAccountInfo(address, 'confirmed');
  const depositor = info ? await client.fetchDepositor(vault, owner) : null;
  const tokenBalance = async (mint: PublicKey, tokenProgram: PublicKey) => {
    const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
    const account = await connection.getAccountInfo(ata, 'confirmed');
    if (!account) return 0n;
    const decoded = unpackAccount(ata, account, tokenProgram);
    if (!decoded.owner.equals(owner) || !decoded.mint.equals(mint)) throw new SmokeError('Wrong owner token account');
    return decoded.amount;
  };
  const [quoteBalance, shareBalance, clock] = await Promise.all([
    tokenBalance(state.quoteMint, TOKEN_PROGRAM_ID), tokenBalance(state.shareMint, TOKEN_2022_PROGRAM_ID),
    connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed'),
  ]);
  if (!clock || clock.data.length !== 40) throw new SmokeError('Clock sysvar unavailable');
  const chainTime = clock.data.readBigInt64LE(32), end = BigInt(state.epochStartedAt.toString()) + BigInt(state.params.epochDurationS);
  const cutoff = end - BigInt(state.params.requestCutoffS);
  let epochRecord: any = null;
  if (depositor && !depositor.wd.epoch.eq(NONE_EPOCH) && depositor.wd.epoch.lt(state.epoch)) epochRecord = await client.fetchEpoch(vault, depositor.wd.epoch);
  const snapshot = publicJson({ observedSlot: clock.data.readBigUInt64LE(0), chainTime, epoch: state.epoch, epochStartedAt: state.epochStartedAt, epochEnd: end,
    requestCutoff: cutoff, epochDurationSeconds: state.params.epochDurationS, requestCutoffSeconds: state.params.requestCutoffS,
    requestTargetEpoch: chainTime < cutoff ? state.epoch : state.epoch.addn(1), scheduledTiming: state.scheduledTiming,
    status: state.status, depositApproved: depositor?.depositApproved ?? false, quoteBalance, shareBalance,
    lastNav: state.lastNav, lastFeeAccrualTs: state.lastFeeAccrualTs, mintSupply: shareMint.supply,
    pricingSupply: pricingSupply(shareMint.supply, BigInt(state.owedUnmintedShares.toString()), BigInt(state.lockedShares.toString())),
    depositor, epochRecord, minDeposit: state.params.minDeposit, minWithdrawShares: state.params.minWithdrawShares,
    withdrawFeeBps: state.params.withdrawFeeBps, depositFeeBps: state.params.depositFeeBps,
    programHashesChecked: true, sourceCommit: FLP_V4_RELEASE.sourceCommit });
  return { client, vault, state, depositor, pricing, snapshot, quoteBalance, shareBalance, epochRecord };
}
export type SmokePreflight = Awaited<ReturnType<typeof smokePreflight>>;

export function confirmedEvent(receipt: SmokeReceipt, action: SmokeAction, name: string): Record<string, any> {
  const record = receipt.records.find(r => r.action === action && ['confirmed', 'finalized'].includes(r.status));
  const events = record?.events?.filter(e => e.name === name && e.data.vault === MAINNET_SMOKE.vault && e.data.user === receipt.owner);
  if (!events || events.length !== 1) throw new SmokeError(`Need confirmed ${name} evidence from the original transaction; run status`);
  return events[0].data;
}
export function buildSmokeAction(options: SmokeOptions, receipt: SmokeReceipt, current: SmokePreflight): TransactionInstruction[] {
  validateSmokeOptions(options); validateReceipt(receipt, options.owner); assertNoReplay(receipt, options.action);
  const { client, vault, state, depositor, pricing, quoteBalance, shareBalance, epochRecord } = current;
  const owner = new PublicKey(options.owner);
  if (options.action === 'deposit') {
    if (!depositor?.depositApproved) throw new SmokeError('Wallet is not approved for permissioned deposits');
    if (state.status & (STATUS.depositsPaused | STATUS.breaker | STATUS.unwind | STATUS.closed)) throw new SmokeError('Approved deposits currently unavailable');
    if (!depositor.wd.amount.isZero() || !depositor.dep.amount.isZero()) throw new SmokeError('Use a wallet without pending tickets for this smoke run');
    const amount = nativeAmount(options.amount, 'amount');
    if (amount > quoteBalance || amount < BigInt(state.params.minDeposit.toString())) throw new SmokeError('Amount outside balance or vault minimum');
    const minimum = nativeAmount(options.minShares, 'min-shares');
    if (shareBalance > 0n && minimum < BigInt(state.params.minWithdrawShares.toString()))
      throw new SmokeError('With existing shares, min-shares must cover the withdrawal minimum for an isolated smoke exit');
    return client.permissionedDepositInstructions(vault, state, owner, amount, minimum, pricing.pricingAccounts, pricing.pricingHealth);
  }
  if (options.action === 'request-withdraw') {
    const deposit = confirmedEvent(receipt, 'deposit', 'FlpPermissionedDeposit');
    const shares = nativeAmount(options.amount, 'shares');
    if (shares > BigInt(deposit.shares) || shares > shareBalance) throw new SmokeError('Withdrawal exceeds smoke minted shares or current balance');
    if (!depositor || !depositor.wd.amount.isZero()) throw new SmokeError('An existing withdrawal ticket must not be merged');
    if (state.status & (STATUS.withdrawalsPaused | STATUS.unwind | STATUS.closed)) throw new SmokeError('Withdrawal queue currently unavailable');
    if (shares < BigInt(state.params.minWithdrawShares.toString()) && shares !== shareBalance) throw new SmokeError('Below withdrawal minimum');
    return client.requestWithdrawInstructions(vault, state, owner, shares);
  }
  if (options.action === 'claim') {
    const request = confirmedEvent(receipt, 'request-withdraw', 'FlpWithdrawRequested');
    if (!depositor || depositor.wd.epoch.toString() !== request.epoch || depositor.wd.requestId.toString() !== request.requestId || depositor.wd.amount.toString() !== request.shares)
      throw new SmokeError('Current withdrawal ticket does not match the recorded request');
    if (!epochRecord || epochRecord.wdStatus !== 1) throw new SmokeError('Withdrawal has not actually settled; wait for an independent keeper close/funding');
    return client.claimWithdrawalInstructions(vault, state, owner, depositor.wd.epoch);
  }
  return [];
}

/** Read-only reconciliation. A null/missing response remains unknown, never a retry instruction. */
export async function reconcileReceipt(connection: Connection, client: FlpV4Client, receipt: SmokeReceipt): Promise<void> {
  for (const record of receipt.records) {
    if (!record.signature) continue;
    const status = (await connection.getSignatureStatuses([record.signature], { searchTransactionHistory: true })).value[0];
    if (!status) { record.status = 'unknown'; continue; }
    record.slot = status.slot;
    if (status.err) { record.status = 'failed'; continue; }
    if (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized') { record.status = 'unknown'; continue; }
    const tx = await connection.getTransaction(record.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx || !tx.meta || tx.meta.err || !tx.meta.logMessages) { record.status = 'unknown'; continue; }
    record.status = status.confirmationStatus;
    record.events = client.parseEvents(tx.meta.logMessages).map(event => ({ name: event.name, data: publicJson(event.data) }));
    const select = (balances: typeof tx.meta.preTokenBalances) => (balances ?? [])
      .filter(b => b.owner === receipt.owner)
      .map(b => ({ accountIndex: b.accountIndex, mint: b.mint, amount: b.uiTokenAmount.amount, decimals: b.uiTokenAmount.decimals }));
    record.transactionBalances = { pre: select(tx.meta.preTokenBalances), post: select(tx.meta.postTokenBalances) };
  }
}
export function withdrawalEstimate(current: SmokePreflight) {
  const record = current.epochRecord, ticket = current.depositor?.wd;
  if (!record || record.wdStatus !== 1 || !ticket) return null;
  return publicJson(claimPayout(BigInt(ticket.amount.toString()), {
    numerator: BigInt(record.wdNum.toString()), denominator: BigInt(record.wdDen.toString()),
  }, Number(record.wdFeeBps)));
}

/** Durable journal seam: a signature must be saved before the first network submission. */
export async function submitSmokeOnce(receipt: SmokeReceipt, record: SmokeRecord, operations: {
  persist: () => void;
  sign: () => { signature: string; bytes: Uint8Array; blockhash: string; lastValidBlockHeight: number };
  send: (bytes: Uint8Array) => Promise<string>;
}): Promise<void> {
  assertNoReplay(receipt, record.action);
  receipt.records.push(record);
  operations.persist();
  const signed = operations.sign();
  record.signature = signed.signature;
  record.solscan = 'https://solscan.io/tx/' + signed.signature;
  record.blockhash = signed.blockhash;
  record.lastValidBlockHeight = signed.lastValidBlockHeight;
  record.status = 'signed';
  operations.persist();
  try {
    const returned = await operations.send(signed.bytes);
    if (returned !== signed.signature) throw new SmokeError('RPC signature mismatch');
  } catch {
    record.status = 'unknown'; operations.persist();
    throw new SmokeError('Submission outcome is uncertain. Run status with this receipt; do not replace the transaction.');
  }
  record.status = 'unknown';
  operations.persist();
}

/** Completion requires original on-chain events, not merely successful submission. */
export function smokeSummary(receipt: SmokeReceipt): Record<string, any> {
  const find = (action: SmokeAction, name: string) => {
    try { return confirmedEvent(receipt, action, name); } catch { return null; }
  };
  const deposit = find('deposit', 'FlpPermissionedDeposit');
  const request = find('request-withdraw', 'FlpWithdrawRequested');
  const claim = find('claim', 'FlpClaimed');
  const matchedClaim = !!claim && claim.kind === 1 && !!request && claim.requestId === request.requestId &&
    claim.epoch === request.epoch && claim.amountIn === request.shares;
  return {
    depositedQuoteNative: deposit?.amount ?? null,
    observedMintedShares: deposit?.shares ?? null,
    requestedShares: request?.shares ?? null,
    withdrawalEpoch: request?.epoch ?? null,
    claimedQuoteNative: matchedClaim ? claim.amountOut : null,
    fullLifecycleComplete: !!deposit && matchedClaim && request!.shares === deposit.shares,
    partialClaimComplete: matchedClaim,
    unwithdrawnSmokeShares: deposit ? (BigInt(deposit.shares) - BigInt(request?.shares ?? '0')).toString() : null,
    latestObservedNav: receipt.lastPreflight?.lastNav ?? null,
    navObservationSlot: receipt.lastPreflight?.lastNav?.slot ?? null,
    accountReadSlot: receipt.lastPreflight?.observedSlot ?? null,
    note: 'NAV is a labeled account observation; transaction events and token balances provide action-specific evidence.',
  };
}
