const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const {
  AnchorProvider,
  Wallet,
  BN,
  BorshAccountsCoder,
} = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { Group } = require('@blockworks-foundation/mango-v4');
const sdk = require('../dist');
const fixture = require('./fixtures/r9-user.json');
const groupFixture = require('./fixtures/r9-group.json');
const d = sdk.FERMI_R9_MAINNET;
const pk = (value) => new PublicKey(value);
const group = { publicKey: pk(d.group) };
const accountInfo = (f = fixture) => ({
  ...f.account,
  owner: pk(f.account.owner),
  data: Buffer.from(f.account.data[0], 'base64'),
});
const makeClient = () =>
  sdk.FermiV1AccountClient.connect(
    new AnchorProvider(
      new Connection('http://127.0.0.1:8899'),
      new Wallet(Keypair.generate()),
      {},
    ),
    'mainnet-beta',
    pk(d.programId),
  );

test('r9 account PDA matches the existing mainnet smoke account', () => {
  assert.equal(
    sdk
      .findFermiV1AccountPda(
        pk(d.programId),
        group.publicKey,
        pk(d.groupAdmin),
        0,
      )
      .toBase58(),
    fixture.publicKey,
  );
  for (const num of [-1, 1.5, 0x100000000]) {
    assert.throws(
      () =>
        sdk.findFermiV1AccountPda(
          pk(d.programId),
          group.publicKey,
          pk(d.groupAdmin),
          num,
        ),
      /32-bit/,
    );
  }
});

test('production registry derives every authority, queue and direct-pool PDA', () => {
  const defaultClient = sdk.FermiV1AccountClient.connectDefault(
    'http://127.0.0.1:8899',
  );
  const namedClient = sdk.FermiV1AccountClient.connectForGroupName(
    defaultClient.fermiProgram.provider,
    d.name,
  );
  assert.equal(defaultClient.programId.toBase58(), d.programId);
  assert.equal(
    namedClient.fermiProgram.coder.accounts.memcmp('fermiAccount').bytes,
    'i1BN83QxYJw',
  );
  assert.equal(
    sdk
      .findExecutionQueueAuthorityStatePda(pk(d.programId), group.publicKey)
      .toBase58(),
    d.authorityState,
  );
  for (const market of d.markets) {
    assert.equal(
      sdk
        .findExecutionQueueV5Pda(
          pk(d.programId),
          group.publicKey,
          market.marketIndex,
        )
        .toBase58(),
      market.queue,
    );
    assert.equal(
      sdk
        .findExecutionQueueV5DirectPda(
          pk(d.programId),
          group.publicKey,
          market.marketIndex,
        )
        .toBase58(),
      market.directPool,
    );
  }
  assert.equal(sdk.requireFermiV1Deployment('fermi-r9-mainnet'), d);
  assert.throws(
    () => sdk.requireFermiV1Deployment('fermi-r6-mainnet'),
    /unknown/,
  );
  assert.throws(
    () =>
      sdk.resolveProgramIdForGroup({
        cluster: 'devnet',
        groupPk: Keypair.generate().publicKey,
      }),
    /explicit programId/,
  );
  assert.throws(
    () => sdk.resolveProgramIdForGroup({ cluster: 'devnet', groupPk: d.group }),
    /mainnet-beta/,
  );
  assert.throws(
    () =>
      sdk.resolveProgramIdForGroup({
        cluster: 'mainnet-beta',
        groupPk: d.group,
        programId: sdk.FERMI_R6_MAINNET.programId,
      }),
    /does not match/,
  );
});

test('r9 decoder reads real mainnet data and rejects the legacy discriminator and wrong owner', () => {
  const client = makeClient();
  const account = client.getMangoAccountFromAi(
    pk(fixture.publicKey),
    accountInfo(),
  );
  assert.equal(account.owner.toBase58(), d.groupAdmin);
  assert.equal(account.group.toBase58(), d.group);
  assert.equal(account.name, 'r9-mainnet-smoke');
  assert.equal(account.accountNum, 0);
  assert.equal(account.tokens.length, 4);
  assert.equal(account.perps.length, 4);
  assert.equal(account.openbookV2.length, 0);
  assert.equal(
    client.fermiProgram.coder.accounts.memcmp('fermiAccount').bytes,
    'i1BN83QxYJw',
  );
  assert.throws(
    () =>
      client.getMangoAccountFromAi(pk(fixture.publicKey), {
        ...accountInfo(),
        owner: PublicKey.default,
      }),
    /wrong program owner/,
  );
  const legacy = accountInfo();
  Buffer.from('f3e4f703a934af1f', 'hex').copy(legacy.data);
  assert.throws(
    () => client.getMangoAccountFromAi(pk(fixture.publicKey), legacy),
    /discriminator/,
  );
  assert.equal(
    BorshAccountsCoder.accountDiscriminator('mangoAccount').toString('hex'),
    'f3e4f703a934af1f',
  );
});

test('owner lookup, legacy aliases and account scans use the r9 identity', async () => {
  const client = makeClient();
  client.connection.getAccountInfo = async (address) => {
    assert.equal(address.toBase58(), fixture.publicKey);
    return accountInfo();
  };
  assert.equal(
    (await client.getFermiAccountForOwner(group, pk(d.groupAdmin))).name,
    'r9-mainnet-smoke',
  );
  assert.equal(
    (await client.getMangoAccountForOwner(group, pk(d.groupAdmin), 0)).name,
    'r9-mainnet-smoke',
  );
  assert.equal(
    (await client.getMangoAccount(pk(fixture.publicKey))).group.toBase58(),
    d.group,
  );
  const scans = [];
  client.connection.getProgramAccounts = async (program, config) => {
    assert.equal(program.toBase58(), d.programId);
    assert.equal(config.filters[0].memcmp.bytes, 'i1BN83QxYJw');
    assert.deepEqual(config.filters[1], {
      memcmp: { offset: 8, bytes: d.group },
    });
    scans.push(config.filters);
    return [{ pubkey: pk(fixture.publicKey), account: accountInfo() }];
  };
  await client.getFermiAccountsForOwner(group, pk(d.groupAdmin));
  await client.getMangoAccountsForOwner(group, pk(d.groupAdmin));
  await client.getMangoAccountsForDelegate(group, PublicKey.default);
  await client.getAllMangoAccounts(group);
  assert.equal(scans[0][2].memcmp.offset, 40);
  assert.equal(scans[2][2].memcmp.offset, 104);
  assert.equal(scans[3].length, 2);
  client.connection.getAccountInfo = async () => null;
  assert.equal(
    await client.getFermiAccountForOwner(group, pk(d.groupAdmin)),
    undefined,
  );
});

test('account creation keeps the instruction discriminator and uses Fermi seeds with r9 defaults', async () => {
  const client = makeClient();
  const ix = await client.createFermiAccountIx(group, 7, 'sdk-r9');
  assert.equal(
    ix.keys[1].pubkey.toBase58(),
    sdk
      .findFermiV1AccountPda(
        pk(d.programId),
        group.publicKey,
        client.walletPk,
        7,
      )
      .toBase58(),
  );
  assert.equal(
    ix.data.subarray(0, 8).toString('hex'),
    crypto
      .createHash('sha256')
      .update('global:account_create')
      .digest()
      .subarray(0, 8)
      .toString('hex'),
  );
  assert.equal(ix.data.readUInt32LE(8), 7);
  assert.deepEqual([...ix.data.subarray(12, 16)], [1, 0, 3, 32]);
  let sent;
  client.sendAndConfirmTransactionForGroup = async (_, ixs) => {
    sent = ixs;
    return { signature: 'offline' };
  };
  await client.createMangoAccount(group);
  assert.equal(sent[0].data[13], 0);
  await assert.rejects(
    client.createFermiAccountIx(group, 0, '', 1, 1),
    /Serum3/,
  );
});

test('group decoder exposes the renamed field and awaits reload', async () => {
  const client = makeClient();
  client.connection.getAccountInfoAndContext = async () => ({
    context: { slot: groupFixture.slot },
    value: accountInfo(groupFixture),
  });
  const reload = Group.prototype.reloadAll;
  let calls = 0;
  Group.prototype.reloadAll = async function () {
    calls += 1;
  };
  try {
    const found = await client.getGroup(group.publicKey);
    assert.equal(found.admin.toBase58(), d.groupAdmin);
    assert(
      found.buybackFeesSwapFermiAccount.equals(
        found.buybackFeesSwapMangoAccount,
      ),
    );
    assert.equal(calls, 1);
  } finally {
    Group.prototype.reloadAll = reload;
  }
});

test('deposit and withdrawal builders encode r9 instructions without sending transactions', async () => {
  const client = makeClient();
  const account = client.getMangoAccountFromAi(
    pk(fixture.publicKey),
    accountInfo(),
  );
  const bank = {
    publicKey: pk(d.usdcBank),
    mint: pk(d.usdcMint),
    vault: pk(d.usdcVault),
    oracle: pk(d.usdcOracle),
  };
  const g = {
    ...group,
    getFirstBankByMint: () => bank,
    getMintDecimals: () => 6,
  };
  client.buildHealthRemainingAccounts = async () => [
    bank.publicKey,
    bank.oracle,
  ];
  let sent;
  client.sendAndConfirmTransactionForGroup = async (_, ixs) => {
    sent = ixs;
    return { signature: 'offline' };
  };
  await client.tokenDeposit(g, account, bank.mint, 1.25, false);
  assert.equal(
    sent[0].data.subarray(0, 8).toString('hex'),
    crypto
      .createHash('sha256')
      .update('global:token_deposit')
      .digest()
      .subarray(0, 8)
      .toString('hex'),
  );
  assert.equal(sent[0].data.readBigUInt64LE(8), 1250000n);
  assert.equal(sent[0].keys[1].pubkey.toBase58(), fixture.publicKey);
  const withdraw = (
    await client.tokenWithdrawNativeIx(
      g,
      account,
      bank.mint,
      new BN(1250000),
      false,
    )
  ).at(-1);
  assert.equal(
    withdraw.data.subarray(0, 8).toString('hex'),
    crypto
      .createHash('sha256')
      .update('global:token_withdraw')
      .digest()
      .subarray(0, 8)
      .toString('hex'),
  );
  assert.equal(withdraw.data.readBigUInt64LE(8), 1250000n);
  assert.equal(withdraw.keys[1].pubkey.toBase58(), fixture.publicKey);
});

test('event decoding uses Fermi names while signed-message domains stay unchanged', () => {
  const client = makeClient();
  const event = sdk.FERMI_V1_IDL.events.find((e) => e.name === 'DepositLog');
  assert(event.fields.some((field) => field.name === 'fermiGroup'));
  assert(event.fields.some((field) => field.name === 'fermiAccount'));
  assert(sdk.FERMI_V1_IDL.events.some((e) => e.name === 'FermiAccountData'));
  const bytes = Buffer.concat([
    crypto
      .createHash('sha256')
      .update('event:DepositLog')
      .digest()
      .subarray(0, 8),
    group.publicKey.toBuffer(),
    pk(fixture.publicKey).toBuffer(),
    pk(d.groupAdmin).toBuffer(),
    Buffer.alloc(2 + 8 + 8 + 8),
  ]);
  const decoded = client.fermiProgram.coder.events.decode(
    bytes.toString('base64'),
  );
  assert.equal(decoded.name, 'DepositLog');
  assert.equal(decoded.data.fermiAccount.toBase58(), fixture.publicKey);
  assert.equal(sdk.USER_INTENT_DOMAIN, 'mango-v5-user-intent-v2');
  assert.equal(sdk.LEGACY_USER_INTENT_DOMAIN, 'mango-v4-user-intent-v2');
});

test('direct intent builder refuses an unlimited expiry on r9', () => {
  assert.throws(
    () =>
      sdk.buildExecutionQueueV5EnqueueDirectWithIntentIxs({
        payload: Buffer.alloc(0),
        expiresAtSlot: 0,
      }),
    /non-zero expiresAtSlot/,
  );
});

test('direct helpers reject an uninitialized mainnet preset before RPC or signing', async () => {
  await assert.rejects(
    sdk.cancelAllPerpOrdersDirect({ deployment: d }, { marketIndex: 0 }),
    /not initialized/,
  );
});
