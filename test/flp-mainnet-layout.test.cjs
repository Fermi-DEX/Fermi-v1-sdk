const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PublicKey } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const fixture = require('./fixtures/flp-v4-mainnet.json');
const { flpV4: v4 } = require('../dist');
const { verifyVaultIdentity } = require('../dist/flp/mainnetSmoke');
const entries = Object.values(fixture.accounts);
const connection = {
  getAccountInfo: async address => {
    const account = entries.find(a => a.address === address.toBase58());
    assert(account, `Unexpected account read: ${address}`);
    return { owner: new PublicKey(account.owner), data: Buffer.from(account.data, 'base64') };
  },
};
const client = new v4.FlpV4Client(connection, new PublicKey(fixture.program));
const vault = new PublicKey(fixture.accounts.vault.address);
const user = new PublicKey(fixture.user);

test('all five RC6.1 layouts decode actual mainnet bytes and bind their identities', async () => {
  const state = await client.fetchVault(vault); // also authenticates RecoveryTargets
  verifyVaultIdentity(state, client.programId, vault);
  assert.equal(state.version, 4);
  assert.equal(state.expandedRecovery, true);
  assert.equal(state.epoch.toString(), '3');
  assert.equal(state.params.epochDurationS, 86400);
  assert.equal(state.params.minDeposit.toString(), '10000000');
  const depositor = await client.fetchDepositor(vault, user);
  assert.equal(depositor.depositApproved, true);
  assert.equal(depositor.totalDeposited.toString(), '20000000');
  const window = await client.fetchFundingWindow(vault, state);
  assert.equal(window.closedEpoch.toString(), '2');
  const epoch = await client.fetchEpoch(vault, new BN(2));
  assert.equal(epoch.epoch.toString(), window.closedEpoch.toString());
  assert.equal(state.shareMint.toBase58(), fixture.shareMint.address);
  assert.equal(fixture.shareMint.nonTransferable, true);
});

test('v4 user instructions preserve mainnet token identities and native amounts', async () => {
  const state = await client.fetchVault(vault);
  const cases = [
    [client.preDepositInstructions(vault, state, user, 10000000n), 'preDepositV3', 'amount', '10000000'],
    [client.preWithdrawInstructions(vault, state, user, 10000000n), 'preWithdrawV3', 'amount', '10000000'],
    [client.requestWithdrawInstructions(vault, state, user, 1000000n), 'requestWithdraw', 'shares', '1000000'],
  ];
  for (const [instructions, name, arg, amount] of cases) {
    const ix = instructions.at(-1), decoded = client.instructionCoder.decode(ix.data);
    assert.equal(decoded.name, name);
    assert.equal(decoded.data[arg].toString(), amount);
    assert(ix.programId.equals(client.programId));
    assert(ix.keys.some(meta => meta.pubkey.equals(vault)));
    assert(ix.keys.some(meta => meta.pubkey.equals(v4.deriveDepositor(client.programId, vault, user))));
  }
  const claim = client.claimWithdrawalInstructions(vault, state, user, 2n).at(-1);
  assert(claim.keys.some(meta => meta.pubkey.toBase58() === fixture.accounts.epoch.address));
  // Construction is not execution eligibility: this snapshot's user has no ticket.
  assert.equal((await client.fetchDepositor(vault, user)).wd.amount.toString(), '0');
});
