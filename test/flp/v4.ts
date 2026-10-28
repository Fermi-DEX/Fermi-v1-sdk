import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { AccountMeta, Connection, Keypair, PublicKey } from '@solana/web3.js';
import { BN, FLP_IDL, NONE_EPOCH, STATUS, VaultAccount, deriveDepositor, deriveEpoch, deriveRecoveryTargets } from '../../src/flp';
import fixtures from '../fixtures/flp-rust.json';
import { FlpV4Client, FLP_V4_IDL, deriveFundingWindow, fundingWindowIsCurrent, fundingWindowIsOpen, permissionlessTriggerAt, batchPayout, FLP_V4_RELEASE, PARTIAL_EXTENSION_BPS } from '../../src/flp/v4';

const key = () => Keypair.generate().publicKey;
const program = key(), vault = key(), user = key(), admin = key(), core = key();
const state = { version: 4, status: 0, vaultId: 8, group: key(), fermiAccount: key(), quoteMint: key(),
  shareMint: key(), depositEscrow: key(), redemptionEscrow: key(), deferredHead: NONE_EPOCH, deferredTail: NONE_EPOCH,
  epoch: new BN(5), unwind: { mode: 0 } } as VaultAccount;
const offline = { getAccountInfo: () => { throw new Error('Unexpected account existence read'); },
  getMultipleAccountsInfo: async () => [] } as unknown as Connection;
const client = new FlpV4Client(offline, program);
const discriminator = (name: string) => createHash('sha256').update('global:' + name).digest().subarray(0, 8);
function accounts(name: string) {
  const out: Record<string, PublicKey> = {};
  const definition = FLP_V4_IDL.instructions.find(ix => ix.name === name)!;
  const visit = (items: typeof definition.accounts, prefix = '') => {
    for (const item of items) {
      if ('accounts' in item) visit(item.accounts, prefix + item.name + '.');
      else out[prefix + item.name] = key();
    }
  };
  visit(definition.accounts);
  return out;
}
test('separate v4 IDL leaves legacy ABI intact', () => {
  assert(FLP_IDL.instructions.some(ix => ix.name === 'closeEpochV3'));
  assert(!FLP_IDL.instructions.some(ix => ix.name === 'closeEpochV4'));
  assert(FLP_V4_IDL.instructions.some(ix => ix.name === 'closeEpochV4'));
});
test('initial capacity binds tokenCount=1, recovery PDA and creation byte limit', () => {
  const fresh = { ...state, fermiAccount: PublicKey.default };
  const ix = client.initFermiAccount(vault, fresh, admin, core, 13, 58);
  assert.deepEqual(ix.data, Buffer.concat([discriminator('init_fermi_account_v4'), Buffer.from([13, 58, 1])]));
  assert.equal(ix.keys[5].pubkey.toBase58(), deriveRecoveryTargets(program, vault).toBase58());
  assert(ix.keys[5].isWritable);
  for (const [perps, slots] of [[13, 59], [13, 64], [14, 1], [1, 65], [0, 1], [1, 0]])
    assert.throws(() => client.initFermiAccount(vault, fresh, admin, core, perps, slots));
  assert.throws(() => client.initFermiAccount(vault, state, admin, core, 3, 32), /already has/);
  const growth = client.expandMarketCapacity(vault, state, admin, core, 13, 64);
  assert.deepEqual(growth.data.subarray(8), Buffer.from([13, 64]));
});
test('paired consumers always prepend initializer without a record read or reset arguments', () => {
  const pairs = [
    client.requestDepositInstructions(vault, state, user, 1n),
    client.preDepositInstructions(vault, state, user, 1n),
    client.preWithdrawInstructions(vault, state, user, 1n),
    client.terminalRedeemInstructions(vault, state, user, 1n),
    client.setDepositPermissionInstructions(vault, admin, user, true),
  ];
  const expected = deriveDepositor(program, vault, user);
  for (const pair of pairs) {
    assert(pair.length >= 2);
    assert.deepEqual(pair[0].data, discriminator('init_depositor'));
    assert(pair[0].keys.some(meta => meta.pubkey.equals(expected)));
    assert(pair[pair.length - 1].keys.some(meta => meta.pubkey.equals(expected)));
  }
  const first = client.initDepositor(vault, user, admin);
  const raced = client.initDepositor(vault, user, admin);
  assert.deepEqual(first.data, raced.data);
  assert.deepEqual(first.keys, raced.keys);
  assert(!first.keys.find(meta => meta.pubkey.equals(user))!.isSigner);
  // This verifies preparation construction. On-chain regressions prove existing balances/tickets do not reset.
});
test('funding-window timing uses exact inclusive boundaries and epoch binding', () => {
  const window = { vault, version: 1, closedEpoch: new BN(4), scheduledStart: new BN(100), deadline: new BN(200), eligible: true };
  assert(fundingWindowIsCurrent(window, vault, state));
  assert(!fundingWindowIsCurrent({ ...window, closedEpoch: new BN(3) }, vault, state));
  assert(!fundingWindowIsCurrent(window, key(), state));
  assert(!fundingWindowIsOpen(window, 99n));
  assert(fundingWindowIsOpen(window, 100n));
  assert(fundingWindowIsOpen(window, 200n));
  assert(!fundingWindowIsOpen(window, 201n));
  assert(!fundingWindowIsOpen({ ...window, eligible: false }, 150n));
});
test('close/fund account order includes correct funding-window privileges and final recovery sidecar', async () => {
  const recovery = { ...state, status: STATUS.unwind, unwind: { ...state.unwind, mode: 2 } };
  const close = await client.closeEpoch(vault, recovery, accounts('closeEpochV4'), []);
  assert.deepEqual(close.data, Buffer.concat([discriminator('close_epoch_v4'), Buffer.from([0])]));
  assert(close.keys[0].pubkey.equals(deriveFundingWindow(program, vault)));
  assert(close.keys[0].isWritable);
  assert(close.keys[1].pubkey.equals(vault));
  assert(close.keys[close.keys.length - 1].pubkey.equals(deriveRecoveryTargets(program, vault)));
  assert(close.keys[close.keys.length - 1].isWritable);
  const head = new BN(2), queued = { ...recovery, deferredHead: head, deferredTail: head };
  const fund = await client.fundHead(vault, queued, accounts('fundHeadV2'), []);
  assert(fund.keys[1].pubkey.equals(deriveFundingWindow(program, vault)));
  assert(!fund.keys[1].isWritable);
  assert(fund.keys[2].pubkey.equals(deriveEpoch(program, vault, head)));
  assert(!fund.keys[fund.keys.length - 1].isWritable);
  await assert.rejects(() => client.sweepIdle(vault, recovery, {}, [], 1n), /Sweeps/);
});
test('close FIFO prefix preserves tail alias and rejects cycles', async () => {
  const head = new BN(2), queued = { ...state, deferredHead: head, deferredTail: head };
  client.fetchEpoch = async () => ({ vault, epoch: head, wdStatus: 2, nextDeferred: NONE_EPOCH } as never);
  const close = await client.closeEpoch(vault, queued, accounts('closeEpochV4'), []);
  const expected = deriveEpoch(program, vault, head);
  assert.equal(close.keys.filter(meta => meta.pubkey.equals(expected)).length, 2);
  assert.deepEqual(close.data.subarray(8), Buffer.from([1]));
  client.fetchEpoch = async () => ({ vault, epoch: head, wdStatus: 2, nextDeferred: head } as never);
  await assert.rejects(() => client.closeEpoch(vault, queued, accounts('closeEpochV4'), []), /cycle/);
});
test('sweep/cure/unwind encode new bounded arguments and recovery sidecar', async () => {
  const sweep = await client.sweepIdle(vault, state, accounts('sweepIdleV2'), [], 500n);
  assert.deepEqual(sweep.data.subarray(0, 8), discriminator('sweep_idle_v2'));
  assert.equal(sweep.data.readBigUInt64LE(8), 500n);
  assert(sweep.keys[0].pubkey.equals(program));
  const queued = { ...state, deferredHead: new BN(1) };
  const cure = await client.cureDeferred(vault, queued, user, accounts('cureDeferredV2'), []);
  assert.deepEqual(cure.data, discriminator('cure_deferred_v2'));
  const health: AccountMeta[] = [{ pubkey: key(), isSigner: false, isWritable: false }];
  const unwind = client.unwindStep(vault, state, accounts('unwindStepV2'), health, 77n);
  assert.equal(unwind.data.readBigInt64LE(8), 77n);
  assert(unwind.keys[unwind.keys.length - 1].pubkey.equals(deriveRecoveryTargets(program, vault)));
  assert.throws(() => client.unwindStep(vault, state, {}, [], 1n << 63n));
  const partial = client.triggerPartialUnwind(vault, state, user, core, [], 1000);
  assert.equal(partial.data.readUInt16LE(8), 1000);
  assert(partial.keys[partial.keys.length - 1].isWritable);
});

test('v4 reader requires sidecar owner, layout, vault and active generation', async () => {
  const wire = Buffer.from(fixtures.vaultAccountHex, 'hex');
  wire[8] = 4;
  wire[wire.length - 67 + 18] = 1;
  const decoded = client.coder.accounts.decode<VaultAccount>('Vault', wire);
  // The fixture has a core account. Force active recovery to exercise generation checks.
  decoded.unwind.mode = 2;
  (client.coder.accounts as any).accountLayouts.get('Vault').encode(decoded, wire.subarray(8));
  const targets = { vault, mode: decoded.unwind.mode, batchEpoch: decoded.unwind.batchEpoch,
    startedAt: decoded.unwind.startedAt, marketIndexes: Array(13).fill(65535), targetBaseLots: Array.from({ length: 13 }, () => new BN(0)) };
  let targetWire = await client.coder.accounts.encode('RecoveryTargets', targets);
  let owner = program, missing = false;
  const connection = { getAccountInfo: async (address: PublicKey) => address.equals(vault)
    ? { data: wire, owner: program } : missing ? null : { data: targetWire, owner } } as unknown as Connection;
  const reader = new FlpV4Client(connection, program);
  assert.equal((await reader.fetchVault(vault)).unwind.targetBaseLots.length, 13);
  missing = true;
  await assert.rejects(() => reader.fetchVault(vault), /wrong-owner/);
  missing = false; owner = key();
  await assert.rejects(() => reader.fetchVault(vault), /wrong-owner/);
  owner = program; targetWire = Buffer.concat([targetWire, Buffer.alloc(1)]);
  await assert.rejects(() => reader.fetchVault(vault), /layout/);
  targetWire = await client.coder.accounts.encode('RecoveryTargets', { ...targets, vault: key() });
  await assert.rejects(() => reader.fetchVault(vault), /vault mismatch/);
  targetWire = await client.coder.accounts.encode('RecoveryTargets', { ...targets, startedAt: targets.startedAt.addn(1) });
  await assert.rejects(() => reader.fetchVault(vault), /Recovery changed/);
  wire[8] = 3;
  await assert.rejects(() => reader.fetchVault(vault), /fresh v4/);
});

test('foreign cleanup derives foreign ATAs, binds admin and preserves full-balance no-argument ABI', () => {
  const mint = key(), authority = client.authority(vault);
  const rescue = client.rescueForeignTokenInstructions(vault, state, admin, mint, 7n);
  assert.equal(rescue.length, 2);
  const ix = rescue[1];
  assert.deepEqual(ix.data.subarray(0, 8), discriminator('rescue_foreign_token'));
  assert.equal(ix.data.readBigUInt64LE(8), 7n);
  assert(ix.keys[2].pubkey.equals(admin) && ix.keys[2].isSigner);
  assert(ix.keys[4].pubkey.equals(getAssociatedTokenAddressSync(mint, authority, true)));
  assert(ix.keys[5].pubkey.equals(getAssociatedTokenAddressSync(mint, admin, true)));
  assert(ix.keys[6].pubkey.equals(TOKEN_PROGRAM_ID));
  const health = [{ pubkey: key(), isWritable: false, isSigner: false }];
  const cleared = client.clearForeignCoreTokenInstructions(vault, state, admin, core, mint, key(), key(), key(), health);
  assert.equal(cleared.length, 2);
  assert.deepEqual(cleared[1].data, discriminator('clear_foreign_core_token'));
  assert(cleared[1].keys[10].pubkey.equals(getAssociatedTokenAddressSync(mint, authority, true)));
  assert.deepEqual(cleared[1].keys.slice(-health.length), health);
  for (const forbidden of [state.quoteMint, state.shareMint]) {
    assert.throws(() => client.rescueForeignTokenInstructions(vault, state, admin, forbidden, 1n), /foreign mint/);
    assert.throws(() => client.clearForeignCoreTokenInstructions(vault, state, admin, core, forbidden, key(), key(), key(), []), /foreign mint/);
  }
  assert.throws(() => client.rescueForeignTokenInstructions(vault, state, admin, mint, 0n), /positive/);
});

test('v4 initialization and seeding bind funding PDA and use distinct discriminators', () => {
  const decoded = client.coder.accounts.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex'));
  const init = client.initializeVault(8, state.group, admin, key(), state.quoteMint, decoded.params as never, key(), key());
  assert.deepEqual(init.data.subarray(0, 8), discriminator('initialize_vault_v4'));
  assert(init.keys[0].pubkey.equals(deriveFundingWindow(program, init.keys[1].pubkey)));
  assert(init.keys[0].isWritable);
  const seed = client.seedVault(vault, state, accounts('seedVaultV4'), 1_000_000n, []);
  assert.deepEqual(seed.data.subarray(0, 8), discriminator('seed_vault_v4'));
  assert.equal(seed.data.readBigUInt64LE(8), 1_000_000n);
  assert(seed.keys[2].pubkey.equals(vault));
});

test('partial recovery extension uses health and event queues before its writable sidecar', async () => {
  const market = key(), queue = key(), oracle = key();
  const data = Buffer.alloc(160);
  createHash('sha256').update('account:PerpMarket').digest().subarray(0, 8).copy(data);
  queue.toBuffer().copy(data, 128);
  const connection = { getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(address =>
    address.equals(market) ? { data, owner: core } : null) } as unknown as Connection;
  const extensionClient = new FlpV4Client(connection, program);
  const health = [market, oracle].map(pubkey => ({ pubkey, isSigner: false, isWritable: false }));
  const queued = { ...state, deferredHead: new BN(2) };
  const ix = await extensionClient.extendPartialUnwind(vault, queued, accounts('extendPartialUnwindV2'), health, 7500);
  assert.deepEqual(ix.data.subarray(0, 8), discriminator('extend_partial_unwind_v2'));
  assert.equal(ix.data.readUInt16LE(8), 7500);
  assert.deepEqual(ix.keys.slice(-4), [...health, { pubkey: queue, isSigner: false, isWritable: false },
    { pubkey: deriveRecoveryTargets(program, vault), isSigner: false, isWritable: true }]);
});

test('partial recovery extension takes 5,000 to 10,000 bps like the program; the trigger keeps 1 to 10,000', async () => {
  assert.deepEqual(PARTIAL_EXTENSION_BPS, { min: 5000, max: 10000 });
  const queued = { ...state, deferredHead: new BN(2) };
  for (const bps of [5000, 10000]) {
    const ix = await client.extendPartialUnwind(vault, queued, accounts('extendPartialUnwindV2'), [], bps);
    assert.equal(ix.data.readUInt16LE(8), bps);
  }
  for (const bps of [0, 1, 1250, 4999, 10001, 65535, 7500.5, NaN])
    await assert.rejects(client.extendPartialUnwind(vault, queued, accounts('extendPartialUnwindV2'), [], bps), /5000 to 10000 bps/, String(bps));
  // The initial partial trigger is a different instruction with the wider program range.
  const markets = [{ market: key(), bids: key(), asks: key() }];
  for (const bps of [1, 4999, 10000])
    assert.equal(client.triggerPartialUnwind(vault, state, admin, core, markets, bps).data.readUInt16LE(8), bps);
  for (const bps of [0, 10001]) assert.throws(() => client.triggerPartialUnwind(vault, state, admin, core, markets, bps), /Invalid reduction/);
});

test('event queues follow the slot-ordered health markets, not the market index (slot 0 = market 2)', async () => {
  // Market index 2 opened first (slot 0), index 0 next (slot 1).
  const [m2, m0, o2, o0, q2, q0, bank, bankOracle] = Array.from({ length: 8 }, key);
  const header = (queue: PublicKey) => {
    const data = Buffer.alloc(160);
    createHash('sha256').update('account:PerpMarket').digest().subarray(0, 8).copy(data);
    queue.toBuffer().copy(data, 128);
    return data;
  };
  const headers = new Map([[m2.toBase58(), header(q2)], [m0.toBase58(), header(q0)]]);
  const connection = { getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(address =>
    headers.has(address.toBase58()) ? { data: headers.get(address.toBase58()), owner: core } : null) } as unknown as Connection;
  const slotClient = new FlpV4Client(connection, program);
  const meta = (pubkey: PublicKey, isWritable = false) => ({ pubkey, isSigner: false, isWritable });
  const health = [meta(bank, true), meta(bankOracle), meta(m2), meta(m0), meta(o2), meta(o0)];
  const ix = await slotClient.fundHead(vault, { ...state, deferredHead: new BN(4) }, accounts('fundHeadV2'), health);
  const keys = ix.keys.map(k => k.pubkey.toBase58());
  assert.deepEqual(keys.slice(-8), [bank, bankOracle, m2, m0, o2, o0, q2, q0].map(k => k.toBase58()));
});

test('all v4 ABI instructions round trip with canonical order, signer bits and optional placeholders', () => {
  function value(type: any): any {
    if (type === 'publicKey') return key();
    if (type === 'bool') return true;
    if (['u8', 'u16', 'u32', 'i8', 'i16', 'i32'].includes(type)) return 7;
    if (typeof type === 'string') return new BN('9007199254740993');
    if (type.defined) return Object.fromEntries((FLP_V4_IDL.types!.find(t => t.name === type.defined)!.type as any).fields.map((f: any) => [f.name, value(f.type)]));
    throw new Error('Unsupported fixture type: ' + JSON.stringify(type));
  }
  for (const definition of FLP_V4_IDL.instructions) {
    const supplied = accounts(definition.name);
    const args = Object.fromEntries(definition.args.map(arg => [arg.name, value(arg.type)]));
    const ix = client.instruction(definition.name, supplied, args);
    const snake = definition.name.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
    assert.deepEqual(ix.data.subarray(0, 8), discriminator(snake), definition.name);
    const decoded = client.coder.instruction.decode(ix.data)!;
    assert.equal(decoded.name, definition.name);
    assert.deepEqual(client.coder.instruction.encode(decoded.name, decoded.data), ix.data);
    const leaves: any[] = [];
    const visit = (items: any[], prefix = '') => items.forEach(item => item.accounts
      ? visit(item.accounts, prefix + item.name + '.') : leaves.push({ ...item, path: prefix + item.name }));
    visit(definition.accounts);
    assert.equal(ix.keys.length, leaves.length);
    leaves.forEach((leaf, index) => assert.deepEqual(ix.keys[index], {
      pubkey: supplied[leaf.path], isWritable: leaf.isMut, isSigner: leaf.isSigner,
    }, definition.name + ':' + leaf.path));
    for (const leaf of leaves.filter(leaf => leaf.isOptional)) {
      const omitted = { ...supplied }; delete omitted[leaf.path];
      const placeholder = client.instruction(definition.name, omitted, args).keys[leaves.indexOf(leaf)];
      assert.deepEqual(placeholder, { pubkey: program, isWritable: false, isSigner: false });
    }
  }
});

test('public user lifecycle prepares every consumer and binds explicit claim epoch', () => {
  const epoch = 3n, record = deriveEpoch(program, vault, epoch);
  const cases: [string, ReturnType<typeof client.requestWithdrawInstructions>][] = [
    ['requestWithdraw', client.requestWithdrawInstructions(vault, state, user, 25n)],
    ['cancelDeposit', client.cancelDepositInstructions(vault, state, user)],
    ['cancelWithdraw', client.cancelWithdrawInstructions(vault, state, user)],
    ['claimPreDeposit', client.claimPreDepositInstructions(vault, state, user)],
    ['claimDeposit', client.claimDepositInstructions(vault, state, user, epoch)],
    ['refundPendingDeposit', client.refundPendingDepositInstructions(vault, state, user, epoch)],
    ['claimWithdrawal', client.claimWithdrawalInstructions(vault, state, user, epoch)],
    ['permissionedWithdraw', client.permissionedWithdrawInstructions(vault, state, user, 25n, 10n, accounts('permissionedWithdraw'), [])],
  ];
  for (const [name, instructions] of cases) {
    assert.deepEqual(instructions[0].data, discriminator('init_depositor'));
    const consumer = instructions[instructions.length - 1];
    assert.equal(client.coder.instruction.decode(consumer.data)!.name, name);
    assert(consumer.keys[1].pubkey.equals(deriveDepositor(program, vault, user)));
    if (['claimDeposit', 'refundPendingDeposit', 'claimWithdrawal'].includes(name)) assert(consumer.keys.some(meta => meta.pubkey.equals(record)));
  }
  const withdraw = cases[7][1].slice(-1)[0];
  assert.equal(withdraw.data.readBigUInt64LE(8), 25n);
  assert.equal(withdraw.data.readBigUInt64LE(16), 10n);
  assert.throws(() => client.requestWithdrawInstructions(vault, state, user, -1n), /u64/);
  assert.throws(() => client.claimDepositInstructions(vault, state, user, 1n << 64n), /u64/);
});

test('funding builder rejects stale PDA evidence and closed time before constructing an action', async () => {
  let window = { vault, version: 1, closedEpoch: new BN(4), scheduledStart: new BN(100), deadline: new BN(200), eligible: true };
  const connection = { getAccountInfo: async (address: PublicKey) => {
    assert(address.equals(deriveFundingWindow(program, vault)));
    return { owner: program, data: await client.coder.accounts.encode('FundingWindow', window) };
  }, getMultipleAccountsInfo: async () => [] } as unknown as Connection;
  const funding = new FlpV4Client(connection, program), queued = { ...state, deferredHead: new BN(2) };
  const supplied = accounts('fundHeadV2');
  await assert.rejects(() => funding.fundHeadIfOpen(vault, queued, supplied, [], 99n), /not open/);
  assert.equal(funding.coder.instruction.decode((await funding.fundHeadIfOpen(vault, queued, supplied, [], 100n)).data)!.name, 'fundHeadV2');
  window = { ...window, closedEpoch: new BN(3) };
  await assert.rejects(() => funding.fundHeadIfOpen(vault, queued, supplied, [], 150n), /changed/);
});


test('packaged IDL matches the pinned RC6.1 interface', () => {
  const packaged = readFileSync(resolve(__dirname, '../../src/flp/idl/flp_vault_v4.json'));
  assert.equal(createHash('sha256').update(packaged).digest('hex'), FLP_V4_RELEASE.idlSha256);
  assert.equal(FLP_V4_RELEASE.vaultProgram, 'FLPRrDPN5tJpLx6wY6FUiGFN5Kws8gHUCYMCcs6Goa9Q');
});

test('v4 public trigger clocks require cash shortage and payout arithmetic floors once per fee', () => {
  const base = { ...state, headEligibleFailTs: new BN(100), headSkipReason: 2,
    recoveryParams: { graceProportionalS: 20, graceFullS: 60 }, unwind: { ...state.unwind, mode: 0 } } as VaultAccount;
  assert.equal(permissionlessTriggerAt(base, false)!.toString(), '120');
  assert.equal(permissionlessTriggerAt(base, true), null);
  assert.equal(permissionlessTriggerAt({ ...base, unwind: { ...base.unwind, mode: 1 } }, true)!.toString(), '160');
  for (const reason of [0, 1, 3, 4, 5, 6]) assert.equal(permissionlessTriggerAt({ ...base, headSkipReason: reason }, false), null);
  assert.equal(permissionlessTriggerAt({ ...base, headEligibleFailTs: new BN(0) }, false), null);
  assert.throws(() => permissionlessTriggerAt({ ...base, version: 3 }, false), /v4/);
  assert.deepEqual(batchPayout(101n, 200n, 3n, 100), { shares: 101n, gross: 6733n, fee: 67n, net: 6666n });
  assert.deepEqual(batchPayout(9007199254740993n, 1n, 1n, 0).net, 9007199254740993n);
  assert.throws(() => batchPayout(1n, 1n, 0n, 1), /ratio/);
});

test('admin setup, graduation, control and role builders retain their frozen ABI', () => {
  const params = client.coder.accounts.decode<VaultAccount>('Vault', Buffer.from(fixtures.vaultAccountHex, 'hex')).params as never;
  const signer = key(), nextAdmin = key(), guardian = key(), recipient = key(), delegate = key();
  const cases: [string, ReturnType<typeof client.instruction>][] = [
    ['graduate', client.graduate(vault, state, admin, accounts('graduate'), [])],
    ['setStatus', client.setStatus(vault, signer, 1, 2)],
    ['stageParamsV3', client.stageParams(vault, admin, params)],
    ['applyParams', client.applyParams(vault, admin)],
    ['stageRecoveryParams', client.stageRecoveryParams(vault, admin, { graceProportionalS: 100, graceFullS: 200, oracleBandBps: 75, maxStepQuote: new BN(1000000) })],
    ['applyRecoveryParams', client.applyRecoveryParams(vault, admin)],
    ['setRoles', client.setRoles(vault, admin, guardian, recipient)],
    ['proposeAdmin', client.proposeAdmin(vault, admin, nextAdmin)],
    ['acceptAdmin', client.acceptAdmin(vault, nextAdmin)],
    ['proposeDelegate', client.proposeDelegate(vault, admin, delegate)],
    ['activateDelegate', client.activateDelegate(vault, state, signer, core)],
    ['removeDelegate', client.removeDelegate(vault, state, signer, core)],
    ['cancelOrders', client.cancelOrders(vault, state, signer, core, [])],
    ['deactivatePerpPosition', client.deactivatePerpPosition(vault, state, core, key())],
    ['checkBreaker', client.checkBreaker(vault, state, accounts('checkBreaker'), [])],
    ['resetBreaker', client.resetBreaker(vault, state, admin, accounts('resetBreaker'), [])],
  ];
  for (const [name, ix] of cases) {
    assert.equal(client.coder.instruction.decode(ix.data)!.name, name);
    assert(ix.keys[0].pubkey.equals(vault));
  }
  const role = client.coder.instruction.decode(cases[6][1].data)!.data as any;
  assert(role.guardian.equals(guardian)); assert(role.feeRecipient.equals(recipient));
  const accept = cases[8][1]; assert(accept.keys[1].pubkey.equals(nextAdmin) && accept.keys[1].isSigner);
  const activation = cases[10][1];
  assert(activation.keys[2].pubkey.equals(state.group));
  assert(activation.keys[3].pubkey.equals(state.fermiAccount));
  assert(activation.keys[4].pubkey.equals(core));
  assert(activation.keys[5].pubkey.equals(signer) && activation.keys[5].isSigner);
  const noEpoch = client.refundPendingDepositInstructions(vault, state, user).slice(-1)[0];
  assert(noEpoch.keys[6].pubkey.equals(program));
  assert(!noEpoch.keys.some(meta => meta.pubkey.equals(user) && meta.isSigner));
  assert.throws(() => client.requestDepositInstructions(vault, { ...state, version: 3 }, user, 1n), /v4/);
  assert.throws(() => client.activateDelegate(vault, { ...state, version: 3 }, signer, core), /v4/);
});

test('approved deposit preserves minShares and pricing suffix while preparing Token-2022 ATA', () => {
  const health = [{ pubkey: key(), isSigner: false, isWritable: false }];
  const pricing = accounts('permissionedDeposit');
  const built = client.permissionedDepositInstructions(vault, state, user, 9007199254740993n, 77n, pricing, health);
  assert.equal(built.length, 3);
  const ix = built[2];
  assert.deepEqual(ix.data.subarray(0, 8), discriminator('permissioned_deposit'));
  assert.equal(ix.data.readBigUInt64LE(8), 9007199254740993n);
  assert.equal(ix.data.readBigUInt64LE(16), 77n);
  assert.deepEqual(ix.keys.slice(-1), health);
  assert.equal(built[1].keys[5].pubkey.toBase58(), 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  assert.throws(() => client.permissionedDepositInstructions(vault, state, user, 1n << 64n, 1n, pricing, []), /u64/);
});

test('settlement selects held refunds, normal claims and rejects cross-vault epochs', () => {
  const held = { vault, epoch: new BN(3), depGross: new BN(100), depDen: new BN(0) } as any;
  const name = (ixs: ReturnType<typeof client.settleDepositInstructions>) => client.coder.instruction.decode(ixs[ixs.length - 1].data)!.name;
  assert.equal(name(client.settleDepositInstructions(vault, state, user, held)), 'refundPendingDeposit');
  assert.equal(name(client.settleDepositInstructions(vault, state, user, { ...held, depDen: new BN(100) })), 'claimDeposit');
  assert.throws(() => client.settleDepositInstructions(vault, state, user, { ...held, vault: key() }), /identity/);
});
