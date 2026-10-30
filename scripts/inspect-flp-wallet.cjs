// Offline inspection of a getTransaction response (base64 encoding).
const fs = require('node:fs');
const w = require('@solana/web3.js');
const { legacyTransactionBytes } = require('../dist/flp');
const result = JSON.parse(fs.readFileSync(process.argv[2] || 'test/fixtures/flp-phantom-reported.json')).result;
const bytes = Buffer.from(result.transaction[0], 'base64');
const transaction = w.Transaction.from(bytes);
const message = transaction.compileMessage();
const extra = new w.TransactionInstruction({ programId: w.PublicKey.unique(), keys: [
  { pubkey: w.PublicKey.unique(), isSigner: false, isWritable: false }], data: Buffer.alloc(0) });
console.log(JSON.stringify({ slot: result.slot, version: result.version, bytes: bytes.length,
  headroomBytes: 1232 - bytes.length, accounts: message.accountKeys.length,
  writableAccounts: message.accountKeys.filter((_, index) => message.isAccountWritable(index)).length,
  signatures: message.header.numRequiredSignatures, historicalUnitsConsumed: result.meta.computeUnitsConsumed,
  hypotheticalExtraInstructionBytes: legacyTransactionBytes([...transaction.instructions, extra], transaction.feePayer),
  instructions: transaction.instructions.map(ix => ({ program: ix.programId.toBase58(),
    accounts: ix.keys.length, dataHex: ix.data.toString('hex') })) }, null, 2));
