const { test } = require('node:test');
const assert = require('node:assert/strict');
const w = require('@solana/web3.js');
const { prepareFlpWalletTransaction: prepare } = require('../dist/flp/v4');
const { legacyTransactionBytes } = require('../dist/flp');
const evidence = require('./fixtures/flp-phantom-reported.json').result;
const original = w.Transaction.from(Buffer.from(evidence.transaction[0], 'base64'));
const payer = original.feePayer;
const table = new w.AddressLookupTableAccount({ key: w.PublicKey.unique(), state: {
  deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0,
  addresses: original.compileMessage().accountKeys.filter(k => !k.equals(payer)),
} });
function rpc(err = null) {
  const calls = [];
  return { calls, getLatestBlockhash: async () => ({ blockhash: w.PublicKey.default.toBase58(), lastValidBlockHeight: 10 }),
    simulateTransaction: async (tx, config) => { calls.push({ tx, config }); return { context: { slot: 1 }, value: { err, logs: ['fixture'], unitsConsumed: 100 } }; } };
}
const options = () => ({ payer, instructions: original.instructions, supportsV0: true, lookupTables: [table] });
function normalize(ix) { return { program: ix.programId.toBase58(), data: ix.data.toString('hex'), keys: ix.keys.map(k => ({ ...k, pubkey: k.pubkey.toBase58() })) }; }
test('reported permissioned deposit: exact size, accounts, limit and historical CU', () => {
  assert.equal(legacyTransactionBytes(original.instructions, payer), 1196);
  assert.equal(original.compileMessage().accountKeys.length, 31);
  assert.equal(evidence.meta.computeUnitsConsumed, 138480);
  assert.equal(original.instructions[0].data.readUInt32LE(1), 300000);
});
test('36 bytes is insufficient for a new program plus one new account, even without data', () => {
  const extra = new w.TransactionInstruction({ programId: w.PublicKey.unique(), keys: [{ pubkey: w.PublicKey.unique(), isSigner: false, isWritable: false }], data: Buffer.alloc(0) });
  assert.equal(legacyTransactionBytes([...original.instructions, extra], payer), 1264);
});
test('v0 compresses real operation without changing its instructions, account privileges or slippage', async () => {
  const connection = rpc(); const result = await prepare(connection, options());
  assert(result.bytes < 1104);
  assert.equal(result.accountCount, 31);
  assert.equal(result.transaction.version, 0);
  const unpacked = w.TransactionMessage.decompile(result.transaction.message, { addressLookupTableAccounts: [table] });
  const canonical = w.TransactionMessage.decompile(original.compileMessage());
  assert.deepEqual(unpacked.instructions.map(normalize), canonical.instructions.map(normalize));
  assert.equal(connection.calls[0].tx, result.transaction);
  assert.deepEqual(connection.calls[0].config, { commitment: 'confirmed', sigVerify: false });
  assert.equal(result.unitsConsumed, 100);
  assert.equal(result.lastValidBlockHeight, 10);
  assert(result.transaction.signatures.every(s => s.every(b => b === 0)));
});
test('near-limit transaction fails before simulation without lookup table or wallet support', async () => {
  for (const patch of [{ lookupTables: [] }, { supportsV0: false }]) {
    const connection = rpc();
    await assert.rejects(prepare(connection, { ...options(), ...patch }), /provide an active lookup table/);
    assert.equal(connection.calls.length, 0);
  }
});
test('small atomic operation keeps legacy format', async () => {
  const result = await prepare(rpc(), { payer, instructions: original.instructions.slice(0, 3), supportsV0: false });
  assert.equal(result.transaction.version, 'legacy');
});
test('ineffective/deactivated tables fail closed', async () => {
  const empty = new w.AddressLookupTableAccount({ key: table.key, state: { ...table.state, addresses: [] } });
  await assert.rejects(prepare(rpc(), { ...options(), lookupTables: [empty] }), /insufficient wallet headroom/);
  const inactive = new w.AddressLookupTableAccount({ key: table.key, state: { ...table.state, deactivationSlot: 1n } });
  await assert.rejects(prepare(rpc(), { ...options(), lookupTables: [inactive] }), /deactivated/);
});
test('simulation error and RPC failure are never returned for signing', async () => {
  await assert.rejects(prepare(rpc({ InstructionError: [4, { Custom: 6034 }] }), options()), /6034.*fixture/);
  const connection = rpc(); connection.simulateTransaction = async () => { throw new Error('RPC unavailable'); };
  await assert.rejects(prepare(connection, options()), /RPC unavailable/);
});
test('invalid reserves and empty operation rejected', async () => {
  for (const reserveBytes of [-1, NaN, 0.5, 1232]) await assert.rejects(prepare(rpc(), { ...options(), reserveBytes }), /Invalid/);
  await assert.rejects(prepare(rpc(), { ...options(), instructions: [] }), /Empty/);
});
test('separate payer signatures remain required and counted', async () => {
  const result = await prepare(rpc(), { ...options(), payer: w.PublicKey.unique() });
  assert.equal(result.transaction.signatures.length, 2);
  assert.equal(result.accountCount, 32);
});
