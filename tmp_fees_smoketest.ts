import { Keypair, PublicKey } from '@solana/web3.js';
import {
  ContinuumFeeClient,
  buildFeeDepositInstructions,
  buildFeeDepositMemo,
} from './src/fees';

async function main() {
  const client = new ContinuumFeeClient('http://127.0.0.1:9093');
  const userOwner = new PublicKey(
    '3ZdHYqiUMC6dwYxCJfKVZp9ZJq7gNg4JUjefcomc43oi',
  );
  const mangoAccount = new PublicKey(
    '258wXSSpynNGUDcMrdUDx6TCtUa1qt82qUMQ4dFZ8wUY',
  );

  // 1. Fetch live fee status from the relayer.
  const status = await client.getStatus({
    userOwner,
    mangoAccount,
    market: 1,
  });
  console.log('status.quote.quoted_fee_lamports:', status.quote.quoted_fee_lamports);
  console.log('status.fee_account.available_balance:', status.fee_account.available_balance_lamports);
  console.log('status.enforcement_mode:', status.enforcement_mode);
  console.log('status.deposit.deposit_address:', status.deposit.deposit_address);
  console.log('status.deposit.memo:', status.deposit.memo);

  // 2. Confirm SDK memo builder matches the relayer's reported memo.
  const sdkMemo = buildFeeDepositMemo(userOwner, mangoAccount);
  console.log('sdk memo matches relayer:', sdkMemo === status.deposit.memo);

  // 3. Build deposit instructions (no send).
  const dummyPayer = Keypair.generate();
  const { instructions, memo, transferInstructionIndex } =
    buildFeeDepositInstructions({
      payer: dummyPayer.publicKey,
      userOwner,
      mangoAccount,
      depositAddress: status.deposit.deposit_address,
      lamports: 100_000_000, // 0.1 SOL
    });
  console.log('instructions.length:', instructions.length);
  console.log('transferInstructionIndex:', transferInstructionIndex);
  console.log(
    'ix[0] program (memo):',
    instructions[0].programId.toBase58(),
  );
  console.log(
    'ix[0] data utf8:',
    Buffer.from(instructions[0].data).toString('utf-8'),
  );
  console.log(
    'ix[1] program (system):',
    instructions[1].programId.toBase58(),
  );
  console.log('memo returned:', memo);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
