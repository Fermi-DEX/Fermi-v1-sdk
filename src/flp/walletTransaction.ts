import { AddressLookupTableAccount, Connection, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { legacyTransactionBytes } from './index';

/** Application policy, not a documented Phantom requirement or warning-free guarantee. */
export const DEFAULT_WALLET_RESERVE_BYTES = 128;

/** Prepare one atomic operation for wallet signing. Never removes/reorders instructions,
 * changes fees/compute limits, splits setup, signs, or submits. Fetch lookup tables from
 * the target cluster before calling. The wallet must explicitly advertise v0 support.
 */
export async function prepareFlpWalletTransaction(
  connection: Pick<Connection, 'getLatestBlockhash' | 'simulateTransaction'>,
  options: {
    payer: PublicKey;
    instructions: TransactionInstruction[];
    supportsV0: boolean;
    lookupTables?: AddressLookupTableAccount[];
    reserveBytes?: number;
  },
) {
  const reserve = options.reserveBytes ?? DEFAULT_WALLET_RESERVE_BYTES;
  if (!Number.isInteger(reserve) || reserve < 0 || reserve >= 1232)
    throw new Error('Invalid wallet byte reserve');
  if (!options.instructions.length) throw new Error('Empty FLP operation');
  const latest = await connection.getLatestBlockhash('confirmed');
  const builder = new TransactionMessage({ payerKey: options.payer,
    recentBlockhash: latest.blockhash, instructions: options.instructions });
  const legacyBytes = legacyTransactionBytes(options.instructions, options.payer);
  let message;
  if (legacyBytes <= 1232 - reserve) {
    message = builder.compileToLegacyMessage();
  } else {
    if (!options.supportsV0 || !options.lookupTables?.length)
      throw new Error(`FLP transaction needs ${legacyBytes} bytes; provide an active lookup table and a v0-capable wallet to retain ${reserve} bytes of headroom`);
    if (options.lookupTables.some(table => !table.isActive()))
      throw new Error('FLP lookup table is deactivated');
    message = builder.compileToV0Message(options.lookupTables);
  }
  const transaction = new VersionedTransaction(message);
  let bytes: number;
  try { bytes = transaction.serialize().length; }
  catch { throw new Error('FLP transaction cannot serialize; use a lookup table covering more operation accounts'); }
  if (bytes > 1232 - reserve)
    throw new Error(`FLP transaction uses ${bytes} bytes; insufficient wallet headroom (${reserve} required)`);
  // Simulate the exact message that will be signed. No replacement blockhash, no
  // signatures, no post-simulation changes. RPC errors fail closed.
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: 'confirmed', sigVerify: false,
  });
  if (simulation.value.err)
    throw new Error(`FLP pre-sign simulation failed: ${JSON.stringify(simulation.value.err)}; ${(simulation.value.logs ?? []).join('\n')}`);
  return { transaction, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight,
    bytes, headroomBytes: 1232 - bytes, accountCount: message.getAccountKeys(
      message.version === 0 ? { addressLookupTableAccounts: options.lookupTables } : undefined,
    ).length, unitsConsumed: simulation.value.unitsConsumed, simulationSlot: simulation.context.slot };
}
