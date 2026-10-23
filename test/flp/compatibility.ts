import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BN, BorshCoder, Idl } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import legacy from '../fixtures/flp-pr23-idl.json';
import fixtures from '../fixtures/flp-rust.json';
import { FLP_IDL, decodeVaultExtension } from '../../src/flp';

const old = legacy as Idl;
const oldCoder = new BorshCoder(old), current = new BorshCoder(FLP_IDL);
const key = new PublicKey(new Uint8Array(32).fill(17));
function value(type: any, idl: Idl): any {
  if (type === 'publicKey') return key;
  if (type === 'bool') return true;
  if (typeof type === 'string') return ['u64', 'i64', 'u128', 'i128'].includes(type) ? new BN(17) : 17;
  if (type.option) return null;
  if (type.array) return Array.from({ length: type.array[1] }, () => value(type.array[0], idl));
  if (type.defined) {
    const definition = idl.types!.find(t => t.name === type.defined)!;
    assert.equal(definition.type.kind, 'struct');
    return Object.fromEntries((definition.type as any).fields.map((f: any) => [f.name, value(f.type, idl)]));
  }
  throw new Error(JSON.stringify(type));
}
function metas(items: any[]): any {
  return items.map(({ name, isMut, isSigner, isOptional, accounts }) => accounts
    ? { name, accounts: metas(accounts) } : { name, isMut, isSigner, isOptional });
}
test('all 42 PR23 instruction bytes and account privileges retain their wire ABI', () => {
  assert.equal(old.instructions.length, 42);
  for (const ix of old.instructions) {
    const now = FLP_IDL.instructions.find(x => x.name === ix.name)!;
    assert.ok(now, ix.name);
    assert.deepEqual(metas(now.accounts), metas(ix.accounts), ix.name);
    const args = Object.fromEntries(ix.args.map(a => [a.name, value(a.type, old)]));
    assert.deepEqual(current.instruction.encode(ix.name, args), oldCoder.instruction.encode(ix.name, args), ix.name);
  }
});
test('PR23 account decoders read RC2 Rust fixtures at their original offsets', () => {
  for (const [name, size] of [['Vault', 1189], ['Depositor', 257], ['EpochRecord', 340]] as const) {
    assert.equal(current.accounts.size(FLP_IDL.accounts!.find(a => a.name === name)!), size);
    assert.equal(oldCoder.accounts.size(old.accounts!.find(a => a.name === name)!), size);
  }
  const bytes = Buffer.from(fixtures.vaultAccountHex, 'hex');
  const before = oldCoder.accounts.decode('Vault', bytes), after = current.accounts.decode('Vault', bytes);
  assert.deepEqual(after, before);
  assert.equal(bytes.length, 1189); // MM-bot's strict checked_data length.
  assert.equal(bytes[8], 3);
  for (const [field, offset] of [['group', 17], ['fermiAccount', 49], ['quoteBank', 81], ['quoteMint', 113], ['delegate', 369]] as const) {
    assert.equal(new PublicKey(bytes.subarray(offset, offset + 32)).toBase58(), after[field].toBase58());
  }
  assert.equal(decodeVaultExtension(after).params.equityWindowS, 900);
  assert.deepEqual(oldCoder.accounts.decode('Depositor', Buffer.from(fixtures.depositor)), current.accounts.decode('Depositor', Buffer.from(fixtures.depositor)));
});
test('legacy event prefixes remain decodable including extended recovery eligibility', () => {
  const encoded = Buffer.from(fixtures.equityEventHex, 'hex').toString('base64');
  const before = oldCoder.events.decode(encoded)!, after = current.events.decode(encoded)!;
  assert.equal(before.name, 'FlpEquityClose');
  assert.equal((before.data.remainingHead as BN).toNumber(), 4);
  assert.equal((before.data.wdDen as BN).toNumber(), 456);
  assert.equal(after.data.ineligibleReason, 2);
  for (const [name, val] of Object.entries(before.data)) assert.deepEqual(after.data[name], val, name);
  for (const event of old.events!) {
    const now = FLP_IDL.events!.find(e => e.name === event.name)!;
    assert.ok(now, event.name);
    assert.deepEqual(now.fields.slice(0, event.fields.length), event.fields, event.name);
  }
});
