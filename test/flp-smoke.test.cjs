const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PublicKey, Keypair } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const s = require('../dist/flp/mainnetSmoke');
const v4 = require('../dist/flp/v4');
const owner = Keypair.generate().publicKey.toBase58();
const base = { action: 'deposit', transact: false, acknowledgeRisk: false, owner, amount: '100', cap: '100', minShares: '10' };
const key = () => Keypair.generate().publicKey;
const signed = { signature: 'original-signature', bytes: new Uint8Array([1, 2]), blockhash: 'original-blockhash', lastValidBlockHeight: 123 };
const record = () => ({ action: 'deposit', status: 'prepared', before: {} });

test('smoke defaults and explicit transaction/amount caps reject unsafe invocations before RPC', () => {
  s.validateSmokeOptions(base);
  for (const bad of [{ amount: '101' }, { amount: '1.5' }, { amount: '-1' }, { cap: undefined }, { minShares: '0' }, { action: 'close' }, { transact: true }])
    assert.throws(() => s.validateSmokeOptions({ ...base, ...bad }));
  assert.throws(() => s.validateSmokeOptions({ ...base, transact: true, acknowledgeRisk: true }));
  s.validateSmokeOptions({ ...base, transact: true, acknowledgeRisk: true, maxFeeLamports: '10000' });
  for (const flags of [[], ['--owner', owner, '--keypair', '/must/not/be/read'], ['--owner', owner, '--transact'], ['--owner', owner, '--action', 'close']]) {
    const result = spawnSync(process.execPath, ['dist/bin/flp-mainnet-smoke.js', ...flags], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert(!result.stderr.includes('ENOENT'), result.stderr);
    assert(!result.stderr.includes('/must/not/be/read'));
  }
});

test('wrong genesis stops before any account read or signer access', async () => {
  await assert.rejects(() => s.smokePreflight({ getGenesisHash: async () => 'devnet' }, new PublicKey(owner)), /mainnet/);
});

test('full mainnet genesis reaches deployment verification; truncated hash is rejected', async () => {
  // Independent RPC value, deliberately not copied from MAINNET_SMOKE.
  const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  const reachedPrograms = new Error('reached program verification');
  await assert.rejects(() => s.smokePreflight({
    getGenesisHash: async () => genesis,
    getMultipleAccountsInfo: async () => { throw reachedPrograms; },
  }, new PublicKey(owner)), error => error === reachedPrograms);
  await assert.rejects(() => s.smokePreflight({
    getGenesisHash: async () => genesis.slice(0, 32),
  }, new PublicKey(owner)), /mainnet/);
});

test('mainnet vault identity binds group, core account, mint, escrows and version', () => {
  const program = new PublicKey(s.MAINNET_SMOKE.vaultProgram), group = new PublicKey(s.MAINNET_SMOKE.group);
  const addresses = v4.deriveVaultAddresses(program, group, 1);
  assert.equal(addresses.vault.toBase58(), s.MAINNET_SMOKE.vault);
  const state = { version: 4, vaultId: 1, group, quoteMint: new PublicKey(s.MAINNET_SMOKE.quoteMint),
    quoteBank: new PublicKey(s.MAINNET_SMOKE.quoteBank), ...addresses,
    fermiAccount: v4.deriveFermiAccount(new PublicKey(s.MAINNET_SMOKE.coreProgram), group, addresses.authority, 1) };
  s.verifyVaultIdentity(state, program, addresses.vault);
  for (const bad of [{ version: 3 }, { vaultId: 2 }, { quoteMint: key() }, { quoteBank: key() }, { group: key() }, { fermiAccount: key() }, { shareMint: key() }])
    assert.throws(() => s.verifyVaultIdentity({ ...state, ...bad }, program, addresses.vault));
});

test('release verification rejects wrong loader, ProgramData, ELF mutation and nonzero padding', () => {
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), dataKey = key();
  const bytes = Buffer.from('synthetic-test-elf');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const executable = Buffer.alloc(36); executable.writeUInt32LE(2); dataKey.toBuffer().copy(executable, 4);
  const program = { owner: loader, executable: true, data: executable };
  const wire = Buffer.alloc(45 + bytes.length + 10); wire.writeUInt32LE(3); bytes.copy(wire, 45);
  const data = { owner: loader, executable: false, data: wire };
  const verify = (p = program, d = data) => s.verifyProgramBytes(p, d, dataKey.toBase58(), bytes.length, hash);
  verify();
  assert.throws(() => verify({ ...program, owner: key() }), /mismatch/);
  assert.throws(() => verify({ ...program, executable: false }), /mismatch/);
  assert.throws(() => s.verifyProgramBytes(program, data, key().toBase58(), bytes.length, hash), /mismatch/);
  const mutation = Buffer.from(wire); mutation[45] ^= 1;
  assert.throws(() => verify(program, { ...data, data: mutation }), /ELF/);
  const padding = Buffer.from(wire); padding[padding.length - 1] = 1;
  assert.throws(() => verify(program, { ...data, data: padding }), /ELF/);
});

test('durable smoke journal saves original signature before the only send and blocks duplicates', async () => {
  const receipt = s.newReceipt(owner), log = [];
  await s.submitSmokeOnce(receipt, record(), {
    persist: () => log.push(['save', receipt.records[0].status, receipt.records[0].signature]),
    sign: () => { log.push(['sign']); return signed; },
    send: async bytes => { log.push(['send']); assert.deepEqual(bytes, signed.bytes); return signed.signature; },
  });
  assert.deepEqual(log.map(x => x[0]), ['save', 'sign', 'save', 'send', 'save']);
  assert.deepEqual(log[2], ['save', 'signed', signed.signature]);
  assert.equal(receipt.records[0].status, 'unknown');
  assert.equal(receipt.records[0].solscan, 'https://solscan.io/tx/original-signature');
  await assert.rejects(() => s.submitSmokeOnce(receipt, record(), { persist: () => {}, sign: () => { throw Error('must not sign'); }, send: async () => '' }), /already recorded/);
});

test('journal write failure stops broadcast and uncertain submission never replaces a signature', async () => {
  let sends = 0, writes = 0;
  const first = s.newReceipt(owner);
  await assert.rejects(() => s.submitSmokeOnce(first, record(), { persist: () => { if (++writes === 2) throw Error('disk full'); },
    sign: () => signed, send: async () => { sends++; return signed.signature; } }), /disk full/);
  assert.equal(sends, 0);
  const second = s.newReceipt(owner);
  await assert.rejects(() => s.submitSmokeOnce(second, record(), { persist: () => {}, sign: () => signed,
    send: async () => { sends++; throw Error('network timeout'); } }), /uncertain/);
  assert.equal(sends, 1);
  assert.equal(second.records[0].signature, signed.signature);
  assert.equal(second.records[0].status, 'unknown');
  assert.throws(() => s.assertNoReplay(second, 'request-withdraw'), /unresolved/);
});

test('receipt reconciliation preserves unknown results and reads original confirmed events', async () => {
  const receipt = s.newReceipt(owner);
  receipt.records.push({ ...record(), signature: signed.signature, status: 'unknown' });
  const queried = [];
  let status = null;
  const connection = {
    getSignatureStatuses: async signatures => { queried.push(signatures); return { value: [status] }; },
    getTransaction: async signature => { assert.equal(signature, signed.signature); return { meta: { err: null, logMessages: ['public log'], preTokenBalances: [], postTokenBalances: [] } }; },
  };
  const client = { parseEvents: () => [{ name: 'FlpPermissionedDeposit', data: { vault: new PublicKey(s.MAINNET_SMOKE.vault), user: new PublicKey(owner), amount: new BN(100), shares: new BN(99) } }] };
  await s.reconcileReceipt(connection, client, receipt);
  assert.equal(receipt.records[0].status, 'unknown');
  status = { confirmationStatus: 'processed', err: null, slot: 10 };
  await s.reconcileReceipt(connection, client, receipt);
  assert.equal(receipt.records[0].status, 'unknown');
  status = { confirmationStatus: 'finalized', err: null, slot: 10 };
  await s.reconcileReceipt(connection, client, receipt);
  assert.equal(s.confirmedEvent(receipt, 'deposit', 'FlpPermissionedDeposit').shares, '99');
  assert(queried.every(q => q.length === 1 && q[0] === signed.signature));
  status = { confirmationStatus: 'finalized', err: { InstructionError: [1, 6000] }, slot: 10 };
  await s.reconcileReceipt(connection, client, receipt);
  assert.equal(receipt.records[0].status, 'failed');
  assert.throws(() => s.confirmedEvent(receipt, 'deposit', 'FlpPermissionedDeposit'), /confirmed/);
});

test('approved lifecycle gates whitelist, pending tickets, minted-share bound and actual settlement', () => {
  const receipt = s.newReceipt(owner), empty = { amount: new BN(0), epoch: v4.NONE_EPOCH, requestId: new BN(0) };
  const state = { status: 0, params: { minDeposit: new BN(10), minWithdrawShares: new BN(10) } };
  const current = { state, vault: new PublicKey(s.MAINNET_SMOKE.vault), depositor: { depositApproved: false, wd: empty, dep: empty },
    quoteBalance: 100n, shareBalance: 99n, pricing: { pricingAccounts: {}, pricingHealth: [] },
    client: { permissionedDepositInstructions: () => ['deposit'], requestWithdrawInstructions: () => ['withdraw'], claimWithdrawalInstructions: () => ['claim'] } };
  assert.throws(() => s.buildSmokeAction(base, receipt, current), /not approved/);
  current.depositor.depositApproved = true;
  assert.deepEqual(s.buildSmokeAction(base, receipt, current), ['deposit']);
  assert.throws(() => s.buildSmokeAction({ ...base, amount: '9' }, receipt, current), /minimum/);
  assert.throws(() => s.buildSmokeAction(base, receipt, { ...current, state: { ...state, status: v4.STATUS.breaker } }), /unavailable/);
  receipt.records.push({ ...record(), status: 'finalized', events: [{ name: 'FlpPermissionedDeposit', data: { vault: s.MAINNET_SMOKE.vault, user: owner, amount: '100', shares: '99' } }] });
  const withdraw = { ...base, action: 'request-withdraw', amount: '99', cap: '99' };
  assert.deepEqual(s.buildSmokeAction(withdraw, receipt, current), ['withdraw']);
  assert.throws(() => s.buildSmokeAction({ ...withdraw, amount: '100', cap: '100' }, receipt, current), /exceeds/);
  receipt.records.push({ action: 'request-withdraw', status: 'finalized', before: {}, events: [{ name: 'FlpWithdrawRequested', data: { vault: s.MAINNET_SMOKE.vault, user: owner, epoch: '5', requestId: '7', shares: '99' } }] });
  current.depositor.wd = { amount: new BN(99), epoch: new BN(5), requestId: new BN(7) };
  const claim = { ...base, action: 'claim' };
  assert.throws(() => s.buildSmokeAction(claim, receipt, current), /not actually settled/);
  current.epochRecord = { wdStatus: 2 };
  assert.throws(() => s.buildSmokeAction(claim, receipt, current), /not actually settled/);
  current.epochRecord.wdStatus = 1;
  assert.deepEqual(s.buildSmokeAction(claim, receipt, current), ['claim']);
  current.depositor.wd.amount = new BN(100);
  assert.throws(() => s.buildSmokeAction(claim, receipt, current), /does not match/);
});


test('receipt completion requires an exact on-chain claim, and distinguishes partial exits', () => {
  const receipt = s.newReceipt(owner);
  const add = (action, name, data) => receipt.records.push({ action, status: 'finalized', before: {},
    events: [{ name, data: { vault: s.MAINNET_SMOKE.vault, user: owner, ...data } }] });
  add('deposit', 'FlpPermissionedDeposit', { amount: '100', shares: '99' });
  add('request-withdraw', 'FlpWithdrawRequested', { requestId: '7', epoch: '5', shares: '99' });
  assert.equal(s.smokeSummary(receipt).fullLifecycleComplete, false);
  add('claim', 'FlpClaimed', { kind: 1, requestId: '7', epoch: '5', amountIn: '99', amountOut: '98' });
  assert.equal(s.smokeSummary(receipt).fullLifecycleComplete, true);
  assert.equal(s.smokeSummary(receipt).claimedQuoteNative, '98');
  receipt.records[0].events[0].data.shares = '199';
  assert.equal(s.smokeSummary(receipt).fullLifecycleComplete, false);
  assert.equal(s.smokeSummary(receipt).partialClaimComplete, true);
  assert.equal(s.smokeSummary(receipt).unwithdrawnSmokeShares, '100');
  receipt.records[2].events[0].data.epoch = '6';
  assert.equal(s.smokeSummary(receipt).partialClaimComplete, false);
});

test('receipt keeps the stored NAV valuation slot distinct from the later account read', () => {
  const receipt = s.newReceipt(owner);
  receipt.lastPreflight = { observedSlot: '462992569', lastNav: { slot: '462938543', navLow: '1926660679' } };
  assert.equal(s.smokeSummary(receipt).navObservationSlot, '462938543');
  assert.equal(s.smokeSummary(receipt).accountReadSlot, '462992569');
  receipt.lastPreflight = { observedSlot: '462992569' };
  assert.equal(s.smokeSummary(receipt).navObservationSlot, null);
});
