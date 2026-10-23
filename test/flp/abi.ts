// Canonical Rust ABI regression suite, fermi-v1 7afba98770b6bae99d839c296f3c7fd4750ab18c.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountInfo, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import fixtures from '../fixtures/flp-rust.json';
import {
  BN, FlpClient, FLP_IDL, DepositorAccount, EpochAccount, NONE_EPOCH, STATUS, VaultAccount,
  LEGACY_PACKET_BYTES, MAX_EQUITY_WINDOW_S, MIN_EQUITY_WINDOW_S,
  MIN_DELEGATE_TIMELOCK_S, delegateDelaySeconds,
  deriveEpoch, deriveVaultAddresses, deriveFermiAccount, depositsHeld, vaultMode, scheduledEpochTiming,
  deriveRecoveryTargets, decodeVaultExtension, MAX_VAULT_PERPS,
  V1_TRANSACTION_BYTES, V1_MAX_ADDRESSES, PERP_MARKET_DISCRIMINATOR, PERP_MARKET_EVENT_QUEUE_OFFSET,
  FUNDING_FAILURE, uniqueAddressCount, legacyTransactionBytes, v1TransactionBytes, fitsLegacyPacket,
  operatorTransactionFormat, permissionlessTriggerAt, DEFAULT_EQUITY_BATCHES, MAX_EQUITY_BATCHES, LARGE_HEAP_BYTES,
  maxEquityWindowSeconds, recoveryMarketMetas, stagedParamsDelaySeconds, deriveDepositor, VaultParamsInput,
} from '../../src/flp';

/** A connection whose only method returns these accounts (or null) by key. */
function accountsConnection(accounts: Map<string, Buffer>): Connection {
  return {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(key => {
      const data = accounts.get(key.toBase58());
      return data ? { data, owner: programId, lamports: 1, executable: false } as AccountInfo<Buffer> : null;
    }),
  } as unknown as Connection;
}
function perpMarketData(queue: PublicKey): Buffer {
  const data = Buffer.alloc(PERP_MARKET_EVENT_QUEUE_OFFSET + 32);
  PERP_MARKET_DISCRIMINATOR.copy(data);
  queue.toBuffer().copy(data, PERP_MARKET_EVENT_QUEUE_OFFSET);
  return data;
}

const programId = new PublicKey(fixtures.programId);
const client = new FlpClient(new Connection('http://127.0.0.1:8899'), programId);
test('SDK instruction bytes and account privileges match canonical Rust', () => {
  const names = ['vault', 'depositor', 'user', 'userQuoteAccount', 'depositEscrow', 'tokenProgram', 'systemProgram'];
  const keys = Object.fromEntries(names.map((name, i) => [name, new PublicKey(fixtures.accounts[i].pubkey)]));
  const ix = client.instruction('requestDeposit', keys, { amount: new BN(fixtures.amount) });
  assert.deepEqual([...ix.data], fixtures.instruction);
  assert.deepEqual(ix.keys.map(k => ({ ...k, pubkey: k.pubkey.toBase58() })), fixtures.accounts);
  assert.throws(() => client.instruction('requestDeposit', {}), /Missing FLP account/);
});
test('account decoder preserves large unsigned and negative signed integers', () => {
  const account = client.accountsCoder.decode<DepositorAccount>('Depositor', Buffer.from(fixtures.depositor));
  assert.equal(account.dep.amount.toString(), fixtures.amount);
  assert.equal(account.dep.requestId.toString(), fixtures.amount);
  assert.equal(account.realizedPnl.toString(), '-123');
  assert.equal(account.wd.epoch.toString(), '18446744073709551615');
  assert.throws(() => client.accountsCoder.decode('Vault', Buffer.from(fixtures.depositor)), /Invalid account discriminator/);
});
test('vault and core PDA seeds match Rust and reject unsafe inputs', () => {
  const group = new PublicKey(fixtures.group);
  const addresses = deriveVaultAddresses(programId, group, fixtures.vaultId);
  assert.equal(addresses.vault.toBase58(), fixtures.vault);
  assert.equal(deriveFermiAccount(new PublicKey(fixtures.coreProgramId), group, addresses.authority, fixtures.vaultId).toBase58(), fixtures.fermiAccount);
  assert.throws(() => deriveVaultAddresses(programId, group, 65536), /does not fit/);
  assert.throws(() => deriveVaultAddresses(programId, group, -1), /does not fit/);
});
test('fresh v3 layout and lifecycle ABI match Rust', () => {
  const state = client.accountsCoder.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex'));
  assert.equal(client.accountsCoder.size(FLP_IDL.accounts!.find(a => a.name === 'Vault')!), 1189, 'PR23 account allocation is preserved');
  assert.equal(state.params.equityWindowS, undefined, 'policy extension is outside legacy params');
  assert.equal(state.version, 3);
  assert.equal(vaultMode(state.status), 'pre-deposit');
  assert.equal(state.preDepositTotal.toString(), fixtures.amount);
  assert.equal(state.unwind.targetBaseLots[1].toString(), '-50');
  assert.equal(state.terminalSupply.sub(new BN(fixtures.amount)).toNumber(), 123);
  assert.equal(new BN(fixtures.amount).sub(state.heldDeposits).toNumber(), 77);
  // Mirrors `launch_params()` in host-tests/examples/sdk-fixtures.rs.
  const launchParams = {
    epochDurationS: 259_200, requestCutoffS: 43_200, timelockS: 86_400, mgmtFeeBps: 100, perfFeeBps: 1_000,
    depositFeeBps: 10, withdrawFeeBps: 10, upnlHaircutBps: 500, minPostWithdrawInitRatioBps: 3_000,
    breakerDrawdownBps: 1_000, breakerMinInitRatioBps: 1_500, breakerWindowS: 86_400,
    tvlCap: new BN(0), minDeposit: new BN(1_000_000), minWithdrawShares: new BN(1_000_000), equityWindowS: 900,
  };
  for (const [name, data] of Object.entries(fixtures.lifecycleInstructions)) {
    const args = name === 'stageRecoveryParams' ? { params: {
      graceProportionalS: 43_200, graceFullS: 259_200, oracleBandBps: 75, maxStepQuote: new BN('50000000000'),
    }} : name === 'stageParamsV3' ? { params: launchParams }
      : { amount: new BN(fixtures.amount), shares: new BN(fixtures.amount), deferredBatchCount: 2, full: true, approved: true,
        minShares: new BN(1), maxQuote: new BN(fixtures.amount), perpCount: 4, perpOoCount: 16, tokenCount: 1,
        fractionBps: 2_500, minQuote: new BN(1) };
    assert.deepEqual([...client.instructionCoder.encode(name, args)], data, name);
  }
  assert.ok('stageParamsV3' in fixtures.lifecycleInstructions && 'initFermiAccountV3' in fixtures.lifecycleInstructions);
  for (const name of ['initFermiAccountV4', 'cureDeferred', 'triggerPartialUnwind', 'permissionedWithdraw', 'initDepositor', 'applyParams']) {
    assert.ok(name in fixtures.lifecycleInstructions, name);
  }
});
test('recovery events decode from canonical Rust and confirmed transaction logs', () => {
  const encoded = Buffer.from(fixtures.recoveryEventHex, 'hex').toString('base64');
  const event = client.eventCoder.decode(encoded)!;
  assert.equal(event.name, 'FlpRecoveryParamsChanged');
  assert.equal((event.data.params as VaultAccount['recoveryParams']).maxStepQuote.toString(), '50000000000');
  const parsed = client.parseEvents([`Program ${programId} invoke [1]`, `Program data: ${encoded}`, `Program ${programId} success`]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, event.name);
});
test('frontend builders select immediate, queued and terminal flows by vault mode', () => {
  const state = client.accountsCoder.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex'));
  const user = Keypair.generate().publicKey;
  const vault = new PublicKey(fixtures.vault);
  const deposit = client.depositInstructions(vault, state, user, 1n);
  assert.equal(deposit.length, 1, 'public principal needs no trading-share ATA');
  assert.deepEqual([...deposit[0].data], [...client.instructionCoder.encode('preDepositV3', { amount: new BN(1) })]);
  assert.deepEqual([...client.withdrawalInstruction(vault, state, user, 1n).data], [...client.instructionCoder.encode('preWithdrawV3', { amount: new BN(1) })]);
  state.status = 0;
  assert.equal(client.depositInstructions(vault, state, user, 1n).length, 1);
  state.status = 32;
  assert.throws(() => client.depositInstructions(vault, state, user, 1n), /unavailable/);
  assert.deepEqual([...client.withdrawalInstruction(vault, state, user, 1n).data], [...client.instructionCoder.encode('terminalRedeem', { shares: new BN(1) })]);
  // Multisig and PDA wallets own off-curve token accounts; the builders accept them.
  const multisig = PublicKey.findProgramAddressSync([Buffer.from('squads-vault')], programId)[0];
  assert.ok(!PublicKey.isOnCurve(multisig.toBytes()));
  assert.doesNotThrow(() => client.withdrawalInstruction(vault, state, multisig, 1n));
  assert.doesNotThrow(() => client.claimWithdrawal(vault, state, multisig, 1n));
});

test('v3 separates public refunds and trading withdrawals with compact account layouts', () => {
  const state = client.accountsCoder.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex'));
  state.version = 3;
  const user = new PublicKey('369nworWkzwRiBiLdGFCpwJ98eyBw1vehKd8HsEwmdX1');
  const vault = new PublicKey(fixtures.vault);
  const trading = client.tradingWithdrawalInstruction(vault, state, user, 1n);
  const publicRefund = client.publicRefundInstruction(vault, state, user, 1n);
  assert.deepEqual(trading.data, client.instructionCoder.encode('requestWithdraw', { shares: new BN(1) }));
  assert.deepEqual(publicRefund.data, client.instructionCoder.encode('preWithdrawV3', { amount: new BN(1) }));
  assert.equal(state.graduationRemainingQuote.toString(), '0');
  const userState = client.accountsCoder.decode<DepositorAccount>('Depositor', Buffer.from(fixtures.depositor));
  assert.equal(userState.preDepositAmount.toString(), '0');
  assert.equal(userState.depositApproved, false);
  assert.equal(client.accountsCoder.size(FLP_IDL.accounts!.find(a => a.name === 'Depositor')!), fixtures.depositor.length);
  state.status |= 32;
  assert.doesNotThrow(() => client.publicRefundInstruction(vault, state, user, 1n));
  assert.deepEqual(client.tradingWithdrawalInstruction(vault,state,user,1n).data, client.instructionCoder.encode('terminalRedeem',{shares:new BN(1)}));
  // Trading closed before graduation: the public path is still a refund of principal.
  assert.deepEqual(client.withdrawalInstruction(vault, state, user, 1n).data, client.instructionCoder.encode('preWithdrawV3', { amount: new BN(1) }));
  // Graduation waits for withdrawals to reopen.
  state.status = STATUS.preDeposit | STATUS.withdrawalsPaused;
  assert.throws(() => client.graduate(vault, state, user, {}, []), /paused/);
  assert.doesNotThrow(() => client.publicRefundInstruction(vault, state, user, 1n));
  assert.doesNotThrow(() => client.withdrawalInstruction(vault, state, user, 1n));
  assert.throws(() => client.tradingWithdrawalInstruction(vault, state, user, 1n), /paused/);
  state.status = STATUS.closed | STATUS.withdrawalsPaused;
  assert.doesNotThrow(() => client.tradingWithdrawalInstruction(vault, state, user, 1n));
  assert.doesNotThrow(() => client.withdrawalInstruction(vault, state, user, 1n));
  // Approved wallets keep the direct path after graduation: only the pricing accounts are missing here.
  state.status = 0;
  assert.throws(() => client.permissionedDepositInstructions(vault, state, user, 1n, 1n, {}, []), /Missing FLP account/);
});
test('deposit refunds encode optional epoch records and follow held epochs', () => {
  const names = ['vault', 'depositor', 'authority', 'userQuoteAccount', 'depositEscrow', 'tokenProgram'];
  const keys = Object.fromEntries(names.map((name, i) => [name, new PublicKey(fixtures.refundAccounts[i].pubkey)]));
  const metas = (ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) =>
    ix.keys.map(k => ({ ...k, pubkey: k.pubkey.toBase58() }));
  assert.deepEqual(metas(client.instruction('refundPendingDeposit', keys)), fixtures.refundAccounts);
  const epochRecord = new PublicKey(fixtures.heldRefundAccounts[6].pubkey);
  assert.deepEqual(metas(client.instruction('refundPendingDeposit', { ...keys, epochRecord })), fixtures.heldRefundAccounts);

  const state = client.accountsCoder.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex'));
  const user = Keypair.generate().publicKey;
  const vault = new PublicKey(fixtures.vault);
  const record: EpochAccount = {
    vault, epoch: new BN(5), depGross: new BN(10), depNum: new BN(0), depDen: new BN(0),
    wdStatus: 0, wdNum: new BN(0), wdDen: new BN(0), nextDeferred: NONE_EPOCH,
  };
  assert.ok(depositsHeld(record));
  const refund = client.settleDepositInstruction(vault, state, user, record);
  assert.deepEqual([...refund.data], [...client.instructionCoder.encode('refundPendingDeposit', {})]);
  assert.equal(refund.keys[6].pubkey.toBase58(), deriveEpoch(programId, vault, 5n).toBase58());
  assert.equal(client.refundPendingDeposit(vault, state, user).keys[6].pubkey.toBase58(), programId.toBase58());
  record.depNum = new BN(1);
  record.depDen = new BN(1);
  assert.ok(!depositsHeld(record));
  const claim = client.settleDepositInstruction(vault, state, user, record);
  assert.deepEqual([...claim.data], [...client.instructionCoder.encode('claimDeposit', {})]);
});

test('recovery blocks new trading exits but preserves public refunds and deferred timing', () => {
  const state = client.accountsCoder.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex'));
  const user = Keypair.generate().publicKey;
  const vault = new PublicKey(fixtures.vault);
  state.version = 3;
  state.status = STATUS.preDeposit | STATUS.unwind;
  assert.throws(() => client.tradingWithdrawalInstruction(vault, state, user, 1n), /recovery completes/);
  assert.throws(() => client.depositInstructions(vault, state, user, 1n), /unavailable/);
  assert.doesNotThrow(() => client.publicRefundInstruction(vault, state, user, 1n));
  assert.equal(scheduledEpochTiming(state), null);
  state.scheduledTiming = { enabled: true, epochDurationS: 7200, requestCutoffS: 900 };
  assert.deepEqual(scheduledEpochTiming(state), { epochDurationS: 7200, requestCutoffS: 900 });
});

test('legacy entrypoints and reserved account extension remain available', () => {
  for (const name of ['enableEquitySettlement', 'enablePermissionedMode', 'switchToLive', 'settleDeferred', 'closeEpochEquity']) {
    assert.ok(FLP_IDL.instructions.some(ix => ix.name === name), name);
  }
  const state = client.accountsCoder.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex'));
  assert.equal((state.reserved as number[]).length, 67);
});

test('equity close builder supplies the complete FIFO prefix before health accounts', async () => {
  const c = new FlpClient(new Connection('http://127.0.0.1:8899'), programId);
  const state = c.accountsCoder.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex'));
  const vault = new PublicKey(fixtures.vault);
  state.deferredHead = new BN(2);
  state.deferredTail = new BN(4);
  state.epoch = new BN(5);
  c.fetchEpoch = async (_vault, epoch) => ({
    vault, epoch: new BN(epoch.toString()), depGross: new BN(0), depNum: new BN(0), depDen: new BN(1),
    wdStatus: 2, wdNum: new BN(0), wdDen: new BN(1), nextDeferred: new BN(epoch.toString()).eqn(2) ? new BN(4) : NONE_EPOCH,
  });
  const key = Keypair.generate().publicKey;
  const accounts = Object.fromEntries(['authority', 'payer', 'fermi.group', 'fermi.fermiAccount', 'fermi.quoteBank',
    'fermi.quoteBankVault', 'fermi.quoteOracle', 'fermi.fermiProgram', 'fermi.tokenProgram',
    'feeShareAccount', 'idleAccount', 'token2022Program', 'systemProgram'].map(n => [n, key]));
  const health = [{ pubkey: Keypair.generate().publicKey, isWritable: false, isSigner: false }];
  (c as { connection: Connection }).connection = accountsConnection(new Map());
  const ix = await c.closeEpoch(vault, state, accounts, health);
  assert.deepEqual(ix.data, c.instructionCoder.encode('closeEpochV3', { deferredBatchCount: 2 }));
  assert.deepEqual(ix.keys.slice(-3).map(k => k.pubkey.toBase58()),
    [deriveEpoch(programId, vault, 2n), deriveEpoch(programId, vault, 4n), health[0].pubkey].map(k => k.toBase58()));
  assert.ok(ix.keys.slice(-3, -1).every(k => k.isWritable));
  c.fetchEpoch = async () => ({ vault, epoch: new BN(2), wdStatus: 1 } as EpochAccount);
  await assert.rejects(c.closeEpoch(vault, state, accounts, health), /queue changed/);
  state.deferredHead = NONE_EPOCH;
  state.deferredTail = NONE_EPOCH;
  const empty = await c.closeEpoch(vault, state, accounts, health);
  assert.equal(empty.keys[2].pubkey.toBase58(), programId.toBase58());
  assert.equal(empty.keys[2].isWritable, false, 'absent tail uses the readonly Anchor sentinel');
  assert.deepEqual(empty.data, c.instructionCoder.encode('closeEpochV3', { deferredBatchCount: 0 }));
});

test('flat perp slots are released permissionlessly and the window bounds are exported', () => {
  const c = new FlpClient(new Connection('http://127.0.0.1:8899'), programId);
  const state = c.accountsCoder.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex'));
  const vault = new PublicKey(fixtures.vault);
  const market = Keypair.generate().publicKey;
  const ix = c.deactivatePerpPosition(vault, state, market, new PublicKey(fixtures.coreProgramId));
  assert.deepEqual([...ix.data], fixtures.lifecycleInstructions.deactivatePerpPosition);
  assert.equal(ix.keys.length, 6);
  assert.ok(ix.keys.every(k => !k.isSigner), 'anyone may call it; only the payer signs');
  assert.equal(ix.keys[0].pubkey.toBase58(), vault.toBase58());
  assert.equal(ix.keys[3].pubkey.toBase58(), state.fermiAccount.toBase58());
  assert.equal(ix.keys[5].pubkey.toBase58(), market.toBase58());
  assert.equal(ix.keys[5].isWritable, false, 'the core reads the market; nothing moves');
  assert.deepEqual([MIN_EQUITY_WINDOW_S, MAX_EQUITY_WINDOW_S, LEGACY_PACKET_BYTES], [300, 7200, 1232]);
});

test('fetch rejects old allocations and unsupported vault versions', async () => {
  const connection = new Connection('http://127.0.0.1:8899');
  let data = Buffer.from(fixtures.vaultAccountHex, 'hex');
  connection.getAccountInfo = async () => ({ data, owner: programId, lamports: 1, executable: false });
  const c = new FlpClient(connection, programId);
  const address = new PublicKey(fixtures.vault);
  assert.equal((await c.fetchVault(address)).version, 3);
  data = Buffer.concat([data, Buffer.alloc(138)]);
  await assert.rejects(c.fetchVault(address), /Unsupported Vault layout/);
  data = Buffer.from(fixtures.vaultAccountHex, 'hex');
  data[8] = 2;
  await assert.rejects(c.fetchVault(address), /Unsupported vault version/);
});

test('delegate activation uses the configured delay including zero', () => {
  assert.equal(MIN_DELEGATE_TIMELOCK_S, 0);
  for (const seconds of [0, 3, 100, 86_399, 86_400]) assert.equal(delegateDelaySeconds(seconds), seconds);
  assert.equal(delegateDelaySeconds(172_800), 172_800);
  assert.throws(() => delegateDelaySeconds(-1));
  assert.throws(() => delegateDelaySeconds(0x100000000));
});


test('admin capacity builder preserves shared margin identity and rejects unsafe bounds/modes', () => {
  const v = decodeVaultExtension(client.accountsCoder.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex')));
  // Growth adds empty slots: it needs no pause and no delegate removal.
  v.status = 0;
  v.pendingDelegate = Keypair.generate().publicKey;
  assert.ok(!v.delegate.equals(PublicKey.default));
  const vault = new PublicKey(fixtures.vault), core = new PublicKey(fixtures.coreProgramId);
  const ix = client.expandMarketCapacity(vault, v, v.admin, core, 10, 32);
  assert.equal(MAX_VAULT_PERPS, 13);
  assert.deepEqual(ix.data, client.instructionCoder.encode('expandMarketCapacity', { perpCount: 10, perpOoCount: 32 }));
  assert(ix.keys.some(k => k.pubkey.equals(v.fermiAccount) && k.isWritable));
  assert(ix.keys.some(k => k.pubkey.equals(deriveRecoveryTargets(programId, vault)) && k.isWritable));
  for (const [perps, slots] of [[14, 32], [10, 65], [0, 32], [10, 0]])
    assert.throws(() => client.expandMarketCapacity(vault, v, v.admin, core, perps, slots));
  for (const status of [STATUS.unwind, STATUS.closed]) {
    v.status = status;
    assert.throws(() => client.expandMarketCapacity(vault, v, v.admin, core, 10, 32), /recovery or after closure/);
  }
});

test('expanded recovery reads all thirteen targets and rejects missing/wrong/stale sidecars', async () => {
  const vault = new PublicKey(fixtures.vault), sidecar = deriveRecoveryTargets(programId, vault);
  const v = client.accountsCoder.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex'));
  (v.reserved as number[])[18] = 1;
  v.unwind.mode = 1;
  const targets = { vault, mode: 1, batchEpoch: v.unwind.batchEpoch, startedAt: v.unwind.startedAt,
    marketIndexes: Array.from({ length: 13 }, (_, i) => i), targetBaseLots: Array.from({ length: 13 }, (_, i) => new BN(-i)) };
  const wire = Buffer.from(fixtures.vaultAccountHex, 'hex');
  (client.accountsCoder as any).accountLayouts.get('Vault').encode(v, wire.subarray(8));
  let targetWire = await client.accountsCoder.encode('RecoveryTargets', targets);
  let present = true;
  const c = new FlpClient({ getAccountInfo: async (key: PublicKey) => key.equals(vault) ? { data: wire, owner: programId } :
    key.equals(sidecar) && present ? { data: targetWire, owner: programId } : null } as unknown as Connection, programId);
  const state = await c.fetchVault(vault);
  assert.equal(state.unwind.targetBaseLots[9].toString(), '-9');
  assert.equal(state.unwind.targetBaseLots.length, 13);
  assert.equal(targetWire.length, 187);
  assert.deepEqual(c.recoveryMetas(vault, state, true), [{ pubkey: sidecar, isSigner: false, isWritable: true }]);
  present = false;
  await assert.rejects(c.fetchVault(vault), /recovery targets/);
  present = true;
  targetWire = await client.accountsCoder.encode('RecoveryTargets', { ...targets, vault: Keypair.generate().publicKey });
  await assert.rejects(c.fetchVault(vault), /Recovery changed/);
  targetWire = await client.accountsCoder.encode('RecoveryTargets', { ...targets, startedAt: targets.startedAt.addn(1) });
  await assert.rejects(c.fetchVault(vault), /Recovery changed/);
});

test('pricing builders append one event queue per active perp after health and before the sidecar', async () => {
  assert.deepEqual([...PERP_MARKET_DISCRIMINATOR], fixtures.perpMarket.discriminator);
  assert.equal(PERP_MARKET_EVENT_QUEUE_OFFSET, fixtures.perpMarket.eventQueueOffset);
  const vault = new PublicKey(fixtures.vault);
  const [bank, oracle, m0, m1, o0, o1, q0, q1] = Array.from({ length: 8 }, () => Keypair.generate().publicKey);
  const markets = new Map([[m0.toBase58(), perpMarketData(q0)], [m1.toBase58(), perpMarketData(q1)],
    [bank.toBase58(), Buffer.alloc(200)], [oracle.toBase58(), Buffer.alloc(200)]]);
  const c = new FlpClient(accountsConnection(markets), programId);
  let reads = 0;
  const get = c.connection.getMultipleAccountsInfo;
  (c.connection as { getMultipleAccountsInfo: typeof get }).getMultipleAccountsInfo = async (...args) => { reads++; return get(...args); };
  const meta = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const health = [bank, oracle, m0, m1, o0, o1].map(meta);
  assert.deepEqual(await c.eventQueueMetas(health), [q0, q1].map(meta));
  assert.deepEqual(await c.withEventQueues(health), [...health, ...[q0, q1].map(meta)]);
  assert.equal(reads, 1, 'market queues are cached');
  const state = decodeVaultExtension(c.accountsCoder.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex')));
  state.expandedRecovery = true;
  state.deferredHead = new BN(2);
  state.deferredTail = new BN(4);
  c.fetchEpoch = async (_vault, epoch) => ({
    vault, epoch: new BN(epoch.toString()), depGross: new BN(0), depNum: new BN(0), depDen: new BN(1),
    wdStatus: 2, wdNum: new BN(0), wdDen: new BN(1), nextDeferred: new BN(epoch.toString()).eqn(2) ? new BN(4) : NONE_EPOCH,
  });
  const key = Keypair.generate().publicKey;
  const accounts = Object.fromEntries(['authority', 'payer', 'fermi.group', 'fermi.fermiAccount', 'fermi.quoteBank',
    'fermi.quoteBankVault', 'fermi.quoteOracle', 'fermi.fermiProgram', 'fermi.tokenProgram',
    'feeShareAccount', 'idleAccount', 'token2022Program', 'systemProgram'].map(n => [n, key]));
  const close = await c.closeEpoch(vault, state, accounts, health);
  const tail = close.keys.slice(-11).map(k => k.pubkey.toBase58());
  assert.deepEqual(tail, [deriveEpoch(programId, vault, 2n), deriveEpoch(programId, vault, 4n), ...health.map(h => h.pubkey),
    q0, q1, deriveRecoveryTargets(programId, vault)].map(k => k.toBase58()));
  const headOnly = await c.closeEpoch(vault, state, accounts, health, { maxBatches: 1 });
  assert.deepEqual(headOnly.data, c.instructionCoder.encode('closeEpochV3', { deferredBatchCount: 1 }));
  assert.equal(headOnly.keys.length, close.keys.length - 1);
  // Up to eight with a larger heap request; the queue here holds two.
  assert.deepEqual([DEFAULT_EQUITY_BATCHES, MAX_EQUITY_BATCHES, LARGE_HEAP_BYTES], [2, 8, 262_144]);
  const backlog = await c.closeEpoch(vault, state, accounts, health, { maxBatches: MAX_EQUITY_BATCHES });
  assert.deepEqual(backlog.data, c.instructionCoder.encode('closeEpochV3', { deferredBatchCount: 2 }));
  for (const maxBatches of [0, 9, 1.5]) {
    await assert.rejects(c.closeEpoch(vault, state, accounts, health, { maxBatches }), /maxBatches must be 1 to 8/);
  }
  const breaker = await c.checkBreaker(vault, state, { authority: key, idleAccount: key, 'fermi.group': key, 'fermi.fermiAccount': key,
    'fermi.quoteBank': key, 'fermi.quoteBankVault': key, 'fermi.quoteOracle': key, 'fermi.fermiProgram': key, 'fermi.tokenProgram': key }, health);
  assert.deepEqual([...breaker.data], fixtures.lifecycleInstructions.checkBreaker);
  assert.deepEqual(breaker.keys.slice(-2).map(k => k.pubkey.toBase58()), [q0, q1].map(k => k.toBase58()));
});

test('abort_unwind is an admin builder that passes the sidecar on expanded vaults', () => {
  const vault = new PublicKey(fixtures.vault);
  const state = decodeVaultExtension(client.accountsCoder.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex')));
  const admin = Keypair.generate().publicKey;
  assert.throws(() => client.abortUnwind(vault, state, admin), /not in recovery/);
  state.status = STATUS.unwind | STATUS.depositsPaused;
  const ix = client.abortUnwind(vault, state, admin);
  assert.deepEqual([...ix.data], fixtures.lifecycleInstructions.abortUnwind);
  assert.deepEqual(ix.keys.map(k => [k.pubkey.toBase58(), k.isWritable, k.isSigner]),
    [[vault.toBase58(), true, false], [admin.toBase58(), false, true]]);
  state.expandedRecovery = true;
  assert.deepEqual(client.abortUnwind(vault, state, admin).keys[2],
    { pubkey: deriveRecoveryTargets(programId, vault), isSigner: false, isWritable: true });
  state.status |= STATUS.closed;
  assert.throws(() => client.abortUnwind(vault, state, admin), /not in recovery/);
});

test('head funding failures decode from Rust and gate permissionless recovery like the program', async () => {
  const connection = new Connection('http://127.0.0.1:8899');
  connection.getAccountInfo = async () => ({ data: Buffer.from(fixtures.headSkipVaultHex, 'hex'), owner: programId, lamports: 1, executable: false });
  const state = await new FlpClient(connection, programId).fetchVault(new PublicKey(fixtures.vault));
  assert.equal(state.headSkipReason, FUNDING_FAILURE.spotQuoteShort, 'latest reason');
  assert.equal(state.headEligibleFailTs!.toString(), '1700000000', 'first failure time');
  const { graceProportionalS, graceFullS } = state.recoveryParams;
  assert.equal(permissionlessTriggerAt(state, false)!.toString(), String(1_700_000_000 + graceProportionalS));
  // Full recovery is permanent: strangers need an active proportional recovery first.
  assert.equal(permissionlessTriggerAt(state, true), null);
  state.unwind.mode = 1;
  assert.equal(permissionlessTriggerAt(state, true)!.toString(), String(1_700_000_000 + graceFullS));
  // The deprecated form ignores the head's close time.
  assert.equal(permissionlessTriggerAt(state, 5, true)!.toString(), String(1_700_000_000 + graceFullS));
  assert.equal(permissionlessTriggerAt(state, 5, false)!.toString(), String(1_700_000_000 + graceProportionalS));
  state.headSkipReason = FUNDING_FAILURE.bankLiquidity;
  assert.equal(permissionlessTriggerAt(state, false), null);
  assert.equal(permissionlessTriggerAt(state, true), null);
  state.headSkipReason = FUNDING_FAILURE.healthFloor;
  state.headEligibleFailTs = new BN(0);
  assert.equal(permissionlessTriggerAt(state, false), null, 'a missed window opens nothing');
  assert.equal(permissionlessTriggerAt(state, true), null, 'and no keeper-abandonment escape: anyone may close');
  const event = client.eventCoder.decode(Buffer.from(fixtures.residualEventHex, 'hex').toString('base64'))!;
  assert.equal(event.name, 'FlpTerminalResidual');
  assert.equal((event.data.reservedQuote as BN).toString(), fixtures.amount);
});

test('transport sizing: legacy when it fits, otherwise v1 within its address and byte budget', () => {
  const payer = Keypair.generate().publicKey;
  const ixWith = (n: number, data = 9) => new TransactionInstruction({
    programId, data: Buffer.alloc(data),
    keys: Array.from({ length: n }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true })),
  });
  const small = ixWith(2);
  assert.equal(uniqueAddressCount([small], payer), 4);
  assert.equal(v1TransactionBytes([small], payer), 42 + 4 * 32 + 20 + (4 + 2 + 9) + 64);
  const tx = new Transaction({ feePayer: payer, recentBlockhash: PublicKey.default.toBase58() }).add(small);
  assert.equal(legacyTransactionBytes([small], payer), tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length);
  assert.ok(fitsLegacyPacket([small], payer).fits);
  assert.equal(operatorTransactionFormat([small], payer), 'legacy');
  const wide = ixWith(40);
  const fit = fitsLegacyPacket([wide], payer);
  assert.ok(!fit.fits && fit.bytes > LEGACY_PACKET_BYTES);
  assert.equal(fit.addresses, 43, "payer, program, compute budget program and 40 accounts");
  assert.equal(operatorTransactionFormat([wide], payer), 'v1');
  assert.throws(() => operatorTransactionFormat([ixWith(V1_MAX_ADDRESSES - 1)], payer), /v1 allows 64/);
  assert.throws(() => operatorTransactionFormat([ixWith(10, V1_TRANSACTION_BYTES)], payer), /v1 allows/);
});

test('gate relaxations: public-only pause, restore state, window bound and parameter delays', () => {
  assert.equal(STATUS.publicDepositsPaused, 64);
  const vault = new PublicKey(fixtures.vault);
  const user = Keypair.generate().publicKey;
  const state = decodeVaultExtension(client.accountsCoder.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex')));
  assert.equal(state.restoreDepositsOpen, false);
  assert.ok(state.delegateRestore!.equals(PublicKey.default));
  for (const status of [STATUS.preDeposit | STATUS.publicDepositsPaused, STATUS.publicDepositsPaused]) {
    state.status = status;
    assert.throws(() => client.depositInstructions(vault, state, user, 1n), /unavailable/);
    // Approved wallets keep the direct path: only the pricing accounts are missing here.
    assert.throws(() => client.permissionedDepositInstructions(vault, state, user, 1n, 1n, {}, []), /Missing FLP account/);
  }
  const restoring = decodeVaultExtension(client.accountsCoder.decode<VaultAccount>('Vault', Buffer.from(fixtures.restoreVaultHex, 'hex')));
  assert.ok(restoring.delegateRestore!.equals(new PublicKey(new Uint8Array(32).fill(13))));
  assert.equal(restoring.restoreDepositsOpen, true);
  assert.equal(restoring.headSkipReason, FUNDING_FAILURE.spotQuoteShort, 'neighbouring extension fields are intact');
  assert.deepEqual([3_600, 28_800, 86_400, 259_200].map(maxEquityWindowSeconds), [7_200, 7_200, 21_600, 64_800]);
  assert.throws(() => maxEquityWindowSeconds(-1));
  // Mirrors launch_params() in host-tests/examples/sdk-fixtures.rs.
  const current: VaultParamsInput = {
    epochDurationS: 259_200, requestCutoffS: 43_200, timelockS: 86_400, mgmtFeeBps: 100, perfFeeBps: 1_000,
    depositFeeBps: 10, withdrawFeeBps: 10, upnlHaircutBps: 500, minPostWithdrawInitRatioBps: 3_000,
    breakerDrawdownBps: 1_000, breakerMinInitRatioBps: 1_500, breakerWindowS: 86_400,
    tvlCap: new BN(0), minDeposit: new BN(1_000_000), minWithdrawShares: new BN(1_000_000), equityWindowS: 900,
  };
  const delay = (next: Partial<VaultParamsInput>) => stagedParamsDelaySeconds(state, { ...current, ...next });
  assert.equal(delay({ mgmtFeeBps: 50, withdrawFeeBps: 5, tvlCap: new BN(5_000_000), minDeposit: new BN(1) }), 86_400);
  for (const harmful of [{ depositFeeBps: 11 }, { equityWindowS: 1_800 }, { upnlHaircutBps: 0 }, { mgmtFeeBps: 50, timelockS: 0 }]) {
    assert.equal(delay(harmful), 259_200 + 43_200, JSON.stringify(harmful));
  }
});

test('gate instructions: account privileges match Rust and the builders check modes', async () => {
  const flatten = (name: string) => {
    const definition = FLP_IDL.instructions.find(ix => ix.name === name)!;
    const paths: string[] = [];
    const visit = (items: typeof definition.accounts, prefix = '') => {
      for (const item of items) 'accounts' in item ? visit(item.accounts, prefix + item.name + '.') : paths.push(prefix + item.name);
    };
    visit(definition.accounts);
    return paths;
  };
  const metas = (keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) =>
    keys.map(k => ({ ...k, pubkey: k.pubkey.toBase58() }));
  for (const [name, expected] of Object.entries(fixtures.gateAccounts)) {
    const paths = flatten(name);
    assert.equal(paths.length, expected.length, name);
    const keys = Object.fromEntries(paths.map((path, i) => [path, new PublicKey(expected[i].pubkey)]));
    assert.deepEqual(metas(client.instruction(name, keys).keys), expected, name);
  }
  const [withdrawn, cured] = fixtures.gateEventsHex.map(hex => client.eventCoder.decode(Buffer.from(hex, 'hex').toString('base64'))!);
  assert.equal(withdrawn.name, 'FlpPermissionedWithdrawal');
  assert.equal((withdrawn.data.shares as BN).toString(), fixtures.amount);
  assert.equal(cured.name, 'FlpDeferredCured');
  assert.equal((cured.data.wdDen as BN).toNumber(), 456);

  const vault = new PublicKey(fixtures.vault), core = new PublicKey(fixtures.coreProgramId);
  const state = decodeVaultExtension(client.accountsCoder.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex')));
  const admin = Keypair.generate().publicKey;
  assert.throws(() => client.initFermiAccountV4(vault, state, admin, core, 13, 58), /already has/);
  const fresh = { ...state, fermiAccount: PublicKey.default };
  const init = client.initFermiAccountV4(vault, fresh, admin, core, 4, 16);
  assert.deepEqual([...init.data], fixtures.lifecycleInstructions.initFermiAccountV4);
  assert.ok(init.keys[3].pubkey.equals(deriveFermiAccount(core, state.group, client.authority(vault), state.vaultId)));
  assert.deepEqual(init.keys[5], { pubkey: deriveRecoveryTargets(programId, vault), isSigner: false, isWritable: true });
  for (const [perps, slots] of [[14, 8], [13, 65], [0, 8], [13, 0]]) assert.throws(() => client.initFermiAccountV4(vault, fresh, admin, core, perps, slots));

  const markets = Array.from({ length: 2 }, () => ({ market: Keypair.generate().publicKey, bids: Keypair.generate().publicKey, asks: Keypair.generate().publicKey }));
  assert.equal(recoveryMarketMetas(markets).length, 6);
  assert.ok(recoveryMarketMetas(markets).every(m => m.isWritable && !m.isSigner));
  state.status = 0;
  const partial = client.triggerPartialUnwind(vault, state, admin, core, markets, 2_500);
  assert.deepEqual([...partial.data], fixtures.lifecycleInstructions.triggerPartialUnwind);
  assert.deepEqual(partial.keys.slice(-6), recoveryMarketMetas(markets), 'three accounts per market, no event queues');
  assert.ok(partial.keys[6].pubkey.equals(programId), 'no deferred batch');
  for (const bps of [0, 10_001]) assert.throws(() => client.triggerPartialUnwind(vault, state, admin, core, markets, bps), /fractionBps/);
  const proportional = client.triggerUnwind(vault, { ...state, expandedRecovery: true }, user(), core, markets, false, 7n);
  assert.ok(proportional.keys[6].pubkey.equals(deriveEpoch(programId, vault, 7n)));
  assert.deepEqual(proportional.keys.at(-1), { pubkey: deriveRecoveryTargets(programId, vault), isSigner: false, isWritable: true });
  state.status = STATUS.unwind;
  assert.throws(() => client.triggerPartialUnwind(vault, state, admin, core, markets, 2_500), /already running/);

  const key = Keypair.generate().publicKey;
  const fermi = Object.fromEntries(['group', 'fermiAccount', 'quoteBank', 'quoteBankVault', 'quoteOracle', 'fermiProgram', 'tokenProgram']
    .map(n => ['fermi.' + n, key]));
  const health = [{ pubkey: key, isSigner: false, isWritable: false }];
  const c = new FlpClient(accountsConnection(new Map()), programId);
  state.status = 0;
  state.deferredHead = NONE_EPOCH;
  await assert.rejects(c.cureDeferred(vault, state, admin, { authority: key, idleAccount: key, ...fermi }, health), /No deferred batch/);
  state.deferredHead = new BN(4);
  const cure = await c.cureDeferred(vault, state, admin, { authority: key, idleAccount: key, ...fermi }, health);
  assert.deepEqual([...cure.data], fixtures.lifecycleInstructions.cureDeferred);
  assert.deepEqual(cure.keys[1], { pubkey: deriveEpoch(programId, vault, 4n), isSigner: false, isWritable: true });
  assert.ok(cure.keys[3].pubkey.equals(admin) && cure.keys[3].isSigner);
  state.status = STATUS.unwind;
  await assert.rejects(c.cureDeferred(vault, state, admin, { authority: key, idleAccount: key, ...fermi }, health), /recovery/);

  const pricing = Object.fromEntries(['authority', 'shareMint', 'feeShareAccount', 'idleAccount', ...Object.keys(fermi), 'token2022Program']
    .map((n, i) => ['pricing.' + n, new PublicKey(new Uint8Array(32).fill(40 + i))]));
  const apply = client.applyParams(vault, admin, { accounts: pricing, health });
  assert.deepEqual([...apply.data], fixtures.lifecycleInstructions.applyParams);
  assert.deepEqual(apply.keys.slice(2).map(k => k.pubkey.toBase58()), [...Object.values(pricing), key].map(k => k.toBase58()));
  assert.equal(client.applyParams(vault, admin).keys.length, 2);
  state.status = STATUS.preDeposit;
  assert.throws(() => client.permissionedWithdraw(vault, state, user(), 5n, 1n, pricing, health), /deferred/);
  state.deferredHead = NONE_EPOCH;
  const exit = client.permissionedWithdraw(vault, state, user(), 5n, 1n, pricing, health);
  assert.equal(exit.data.length, 24);
  for (const status of [0, STATUS.preDeposit | STATUS.unwind, STATUS.preDeposit | STATUS.withdrawalsPaused]) {
    state.status = status;
    assert.throws(() => client.permissionedWithdraw(vault, state, user(), 5n, 1n, pricing, health));
  }
  const payer = user(), owner = user();
  const record = client.initDepositor(vault, owner, payer);
  assert.deepEqual(metas(record.keys).map(k => [k.pubkey, k.isSigner, k.isWritable]), [
    [vault.toBase58(), false, false], [owner.toBase58(), false, false],
    [deriveDepositor(programId, vault, owner).toBase58(), false, true], [payer.toBase58(), true, true],
    [PublicKey.default.toBase58(), false, false]]);
  function user() { return Keypair.generate().publicKey; }
});

import './compatibility';
