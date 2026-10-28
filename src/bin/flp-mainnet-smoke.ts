#!/usr/bin/env node
/** Operator-invoked only. Defaults to read-only preflight; never imported by SDK root. */
import fs from 'fs';
import path from 'path';
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, AddressLookupTableAccount, AddressLookupTableProgram } from '@solana/web3.js';
import { SmokeError, SmokeOptions, SmokeReceipt, SmokeRecord, newReceipt, validateReceipt,
  validateSmokeOptions, nativeAmount, smokePreflight, buildSmokeAction, reconcileReceipt, withdrawalEstimate, submitSmokeOnce, smokeSummary } from '../flp/mainnetSmoke';

function args(argv: string[]): Record<string, string> {
  const allowed = new Set(['action', 'owner', 'rpc-url', 'receipt', 'transact', 'acknowledge-risk', 'keypair',
    'amount-native', 'cap-native', 'min-shares', 'max-fee-lamports', 'max-sol-lamports', 'lookup-table']);
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !allowed.has(name) || name in flags) throw new SmokeError('Unknown or duplicate CLI argument');
    if (['transact', 'acknowledge-risk'].includes(name)) flags[name] = 'true';
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new SmokeError('Missing CLI argument value');
      flags[name] = argv[++i];
    }
  }
  return flags;
}
function base58(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex')), out = '';
  while (n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of bytes) { if (byte) break; out = '1' + out; }
  return out;
}
function save(file: string, receipt: SmokeReceipt): void {
  receipt.summary = smokeSummary(receipt);
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

async function main() {
  const flags = args(process.argv.slice(2));
  const options: SmokeOptions = {
    action: (flags.action ?? 'preflight') as SmokeOptions['action'], transact: flags.transact === 'true',
    acknowledgeRisk: flags['acknowledge-risk'] === 'true', owner: flags.owner,
    amount: flags['amount-native'], cap: flags['cap-native'], minShares: flags['min-shares'], maxFeeLamports: flags['max-fee-lamports'],
  };
  if (!options.owner) throw new SmokeError('--owner is required (public key only)');
  validateSmokeOptions(options);
  if (!options.transact && flags.keypair) throw new SmokeError('Do not supply a keypair in read-only mode');
  if (options.transact && !flags.keypair) throw new SmokeError('Transaction mode requires a user-selected keypair file');
  if (options.transact) nativeAmount(flags['max-sol-lamports'], 'max-sol-lamports');
  const rpc = flags['rpc-url'] ?? process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  if (new URL(rpc).protocol !== 'https:') throw new SmokeError('Mainnet smoke requires HTTPS RPC');
  const file = path.resolve(flags.receipt ?? '.flp-smoke/receipt.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Exclusive process lock plus durable signature-before-send journal. Never auto-delete a stale lock.
  const lock = fs.openSync(file + '.lock', 'wx', 0o600);
  let receipt: SmokeReceipt;
  try {
    receipt = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : newReceipt(options.owner);
    validateReceipt(receipt, options.owner);
    const connection = new Connection(rpc, { commitment: 'confirmed', disableRetryOnRateLimit: true });
    const owner = new PublicKey(options.owner);
    const current = await smokePreflight(connection, owner);
    await reconcileReceipt(connection, current.client, receipt);
    receipt.lastPreflight = { ...current.snapshot, settledClaimEstimate: withdrawalEstimate(current) };
    for (const record of receipt.records) {
      if (!record.after && ['confirmed', 'finalized'].includes(record.status) && record.slot !== undefined &&
        BigInt(current.snapshot.observedSlot) >= BigInt(record.slot)) record.after = current.snapshot;
    }
    save(file, receipt);
    if (['preflight', 'status'].includes(options.action)) {
      console.log(JSON.stringify(receipt, null, 2));
      return;
    }
    const instructions = buildSmokeAction(options, receipt, current);
    const tables: AddressLookupTableAccount[] = [];
    if (flags['lookup-table']) {
      const tableKey = new PublicKey(flags['lookup-table']);
      const tableInfo = await connection.getAccountInfo(tableKey, 'confirmed');
      if (!tableInfo?.owner.equals(AddressLookupTableProgram.programId)) throw new SmokeError('Wrong lookup table owner');
      const result = await connection.getAddressLookupTable(tableKey);
      if (!result.value || !result.value.isActive()) throw new SmokeError('Lookup table is missing or inactive');
      tables.push(result.value);
    }
    const latest = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({ payerKey: owner, recentBlockhash: latest.blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instructions] }).compileToV0Message(tables);
    const tx = new VersionedTransaction(message);
    let bytes: number;
    try { bytes = tx.serialize().length; } catch { throw new SmokeError('Transaction too large; select an appropriate public lookup table'); }
    if (bytes > 1232) throw new SmokeError('Transaction exceeds 1232 bytes; select an appropriate public lookup table');
    const fee = (await connection.getFeeForMessage(message, 'confirmed')).value;
    if (fee === null || !Number.isSafeInteger(fee)) throw new SmokeError('Fee estimate unavailable or unsafe');
    if (options.transact && BigInt(fee) > nativeAmount(options.maxFeeLamports, 'max-fee-lamports')) throw new SmokeError('Network fee exceeds cap');
    const beforeSol = await connection.getBalance(owner, 'confirmed');
    const simulation = await connection.simulateTransaction(tx, {
      sigVerify: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [owner.toBase58()] },
    });
    if (simulation.value.err) throw new SmokeError('Simulation failed; no signing or submission. Refresh state and check instruction eligibility.');
    const afterSol = simulation.value.accounts?.[0]?.lamports;
    if (afterSol === undefined || !Number.isSafeInteger(beforeSol) || !Number.isSafeInteger(afterSol))
      throw new SmokeError('Simulation payer balance unavailable or unsafe');
    // Add the fee conservatively even if RPC simulation already deducted it.
    const estimatedSolDebit = BigInt(Math.max(0, beforeSol - afterSol)) + BigInt(fee);
    const preview = { action: options.action, mode: options.transact ? 'transact' : 'read-only-simulation',
      amount: options.amount, cap: options.cap, minShares: options.minShares, feeLamports: fee,
      estimatedSolDebitLamports: estimatedSolDebit.toString(), bytes, unitsConsumed: simulation.value.unitsConsumed,
      simulatedEvents: current.client.parseEvents(simulation.value.logs ?? []).map(e => ({ name: e.name })),
      requestTargetEpoch: current.snapshot.requestTargetEpoch, claimEstimate: withdrawalEstimate(current) };
    if (!options.transact) { console.log(JSON.stringify(preview, null, 2)); return; }
    if (estimatedSolDebit > nativeAmount(flags['max-sol-lamports'], 'max-sol-lamports')) throw new SmokeError('Estimated SOL fee/rent debit exceeds cap');
    // Every validation and simulation above runs before reading the private key.
    const raw = JSON.parse(fs.readFileSync(flags.keypair, 'utf8'));
    if (!Array.isArray(raw) || raw.length !== 64 || raw.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new SmokeError('Expected a Solana keypair JSON file');
    const keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
    if (!keypair.publicKey.equals(owner)) throw new SmokeError('Keypair does not match --owner');
    const record: SmokeRecord = { action: options.action, amount: options.amount, cap: options.cap,
      minShares: options.minShares, maxFeeLamports: options.maxFeeLamports,
      maxSolLamports: flags['max-sol-lamports'], estimatedSolDebitLamports: estimatedSolDebit.toString(), status: 'prepared', before: current.snapshot };
    await submitSmokeOnce(receipt, record, {
      persist: () => save(file, receipt),
      sign: () => {
        tx.sign([keypair]);
        return { signature: base58(tx.signatures[0]), bytes: tx.serialize(), ...latest };
      },
      send: bytes => connection.sendRawTransaction(bytes, { skipPreflight: false, maxRetries: 0, preflightCommitment: 'confirmed' }),
    });
    // One read; confirmation may take longer. No retry loop or chained withdrawal.
    await reconcileReceipt(connection, current.client, receipt);
    save(file, receipt);
    console.log(JSON.stringify({ ...preview, receipt }, null, 2));
  } finally {
    fs.closeSync(lock); fs.unlinkSync(file + '.lock');
  }
}
if (require.main === module) main().catch(error => {
  // RPC errors can contain credential-bearing URLs. Never echo them or key-file contents.
  console.error(error instanceof SmokeError ? error.message : 'Smoke run stopped. Inspect the receipt and RPC availability; sensitive error details withheld. No automatic retry.');
  process.exitCode = 1;
});
