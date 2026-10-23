const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PublicKey } = require('@solana/web3.js');
const protoLoader = require('@grpc/proto-loader');
const grpc = require('@grpc/grpc-js');
const nacl = require('tweetnacl');
const sdk = require('../dist');
const golden = require('./fixtures/trigger-intake-golden.json');
const pk = (value) => new PublicKey(value);
const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const params = {
  group: pk(golden.request.group),
  fermiAccount: pk(golden.request.mango_account),
  executionQueue: pk(golden.request.execution_queue),
  marketIndex: 2,
  signer: pk(golden.request.user_owner),
  remainingAccounts: golden.request.remaining_accounts.map((a) => ({
    pubkey: pk(a.pubkey),
    isSigner: a.is_signer,
    isWritable: a.is_writable,
  })),
  position: 'long',
  size: 'all',
  slippageBps: 0,
  expiryTs: 1790000000n,
};
const terms = {
  kind: 0,
  direction: 1,
  triggerPriceLots: 95000n,
  ocoGroup: 0x1122334455667788n,
  expiryTs: params.expiryTs,
  salt: 0x0a0b0c0d0e0f1011n,
};
function goldenLeg() {
  return sdk.buildTriggerOrderLeg(params, sdk.TriggerKind.StopLoss, 95000n, {
    ocoGroup: terms.ocoGroup,
    salt: terms.salt,
    limitPriceLots: 94500n,
  });
}
const apiKey = '00000000-0000-0000-0000-000000000000';
const response = (body, status = 200, headers) =>
  new Response(JSON.stringify(body), { status, headers });
const accepted = {
  status: 'withheld',
  trigger_order_id: golden.user_intent_hash_hex,
  trigger_order_status: 'armed',
};

test('trigger terms, IOC payload, signed intent and signature match the Rust intake fixture byte for byte', () => {
  const leg = goldenLeg();
  assert.equal(
    sdk
      .triggerTermsCommitment(params.group, params.fermiAccount, 2, terms)
      .toString(),
    golden.request.client_order_id,
  );
  assert.equal(leg.payload.toString('base64'), golden.request.payload_b64);
  assert.equal(leg.intentHash.toString('hex'), golden.user_intent_hash_hex);
  const signature = sdk.signTriggerOrderLeg(leg, key.secretKey);
  assert.equal(
    Buffer.from(signature).toString('base64'),
    golden.request.user_signature_b64,
  );
  const request = sdk.triggerOrderRequest(leg, signature);
  assert.equal(request.intent_version, 3);
  assert.deepEqual(request.trigger_order, golden.terms);
  assert.equal(request.min_execute_slot, '0');
  assert.equal(request.expires_at_slot, '0');
  assert.equal(request.max_fee_lamports, 'AUTO');
});

test('SL and TP direction, IOC rounding, close size and OCO grouping follow position side', () => {
  for (const position of ['long', 'short']) {
    const legs = sdk.buildSlTpLegs({
      ...params,
      position,
      size: 12n,
      slippageBps: 51,
      stopLossPriceLots: position === 'long' ? 900n : 1100n,
      takeProfitPriceLots: position === 'long' ? 1100n : 900n,
      oraclePriceLots: 1000n,
    });
    assert.equal(legs.length, 2);
    assert.equal(legs[0].terms.ocoGroup, legs[1].terms.ocoGroup);
    assert.notEqual(legs[0].terms.ocoGroup, 0n);
    assert.notEqual(legs[0].clientOrderId, legs[1].clientOrderId);
    assert.equal(legs[0].terms.direction, position === 'long' ? 1 : 0);
    assert.equal(legs[1].terms.direction, position === 'long' ? 0 : 1);
    for (const leg of legs) {
      const trigger = leg.terms.triggerPriceLots;
      const limit =
        position === 'long'
          ? (trigger * 9949n) / 10000n
          : (trigger * 10051n + 9999n) / 10000n;
      assert.equal(leg.payload.readBigInt64LE(5), limit);
      assert.equal(leg.payload.readBigInt64LE(13), 12n);
      assert.equal(leg.payload[37], 1); // bounded IOC
      assert.equal(leg.payload[39], 1); // reduce-only
    }
  }
  const solo = sdk.buildSlTpLegs({ ...params, stopLossPriceLots: 900n });
  assert.equal(solo[0].terms.ocoGroup, 0n);
  assert.equal(solo[0].payload.readBigInt64LE(13), (1n << 63n) - 1n);
});

test('invalid trigger input is rejected before signing', () => {
  const build = (overrides) =>
    sdk.buildSlTpLegs({ ...params, stopLossPriceLots: 900n, ...overrides });
  for (const overrides of [
    { size: 0n },
    { size: -1n },
    { size: 3 },
    { slippageBps: -1 },
    { slippageBps: 1.5 },
    { slippageBps: 10000 },
    { marketIndex: 65535 },
    { expiryTs: 0n },
    { stopLossPriceLots: 1n << 63n },
  ]) {
    assert.throws(() => build(overrides));
  }
  assert.throws(() => build({ oraclePriceLots: 900n }), /already met/);
  assert.throws(() => sdk.buildSlTpLegs(params), /set stopLoss/);
  assert.throws(
    () => sdk.buildTriggerOrderLeg(params, 0, 1000n, { limitPriceLots: 1001n }),
    /marketable/,
  );
});

test('signature helpers support raw and wallet hex hashes, and reject wrong signers or changed terms', () => {
  const leg = goldenLeg();
  assert.throws(
    () => sdk.signTriggerOrderLeg(leg, nacl.sign.keyPair().secretKey),
    /signer/,
  );
  assert.throws(
    () => sdk.triggerOrderRequest(leg, new Uint8Array(64)),
    /signature/,
  );
  const hexSignature = nacl.sign.detached(
    Buffer.from(leg.intentHash.toString('hex')),
    key.secretKey,
  );
  assert.equal(sdk.triggerOrderRequest(leg, hexSignature).intent_version, 3);
  const signature = sdk.signTriggerOrderLeg(leg, key.secretKey);
  assert.throws(
    () =>
      sdk.triggerOrderRequest(
        { ...leg, terms: { ...leg.terms, expiryTs: leg.terms.expiryTs + 1n } },
        signature,
      ),
    /changed/,
  );
  const payload = Buffer.from(leg.payload);
  payload[5] ^= 1;
  assert.throws(
    () => sdk.triggerOrderRequest({ ...leg, payload }, signature),
    /changed/,
  );
});

const cancelParams = {
  group: params.group,
  fermiAccount: params.fermiAccount,
  signer: params.signer,
  issuedAtMs: 1790000000000n,
  scope: 'ids',
  clientOrderIds: [BigInt(golden.request.client_order_id)],
};
test('all cancellation scopes use the keeper Rust golden hashes and exact u64 values', () => {
  assert.equal(
    sdk.triggerCancelMessageHash(cancelParams).toString('hex'),
    'dfd233eed84b75ed977f334defb65913aadf50cf8761b3f2c44f729ee212f965',
  );
  assert.equal(
    sdk
      .triggerCancelMessageHash({
        ...cancelParams,
        scope: 'oco_group',
        clientOrderIds: [],
        ocoGroup: terms.ocoGroup,
        marketIndex: 2,
      })
      .toString('hex'),
    'c2dd8124ec3f8727a9e227cb15458e037554ac7c283de66b4c56b967d9161cca',
  );
  const signature = sdk.signTriggerCancel(
    { ...cancelParams, scope: 'all', clientOrderIds: [] },
    key.secretKey,
  );
  assert.equal(signature.length, 64);
  assert.throws(
    () => sdk.triggerCancelMessageHash({ ...cancelParams, clientOrderIds: [] }),
    /ids/,
  );
  assert.throws(
    () =>
      sdk.triggerCancelMessageHash({
        ...cancelParams,
        scope: 'oco_group',
        ocoGroup: 0n,
      }),
    /non-zero/,
  );
  assert.throws(
    () => sdk.triggerCancelMessageHash({ ...cancelParams, issuedAtMs: -1n }),
    /range/,
  );
});

test('gateway trigger submission sends authentication and v3 terms without committing a normal order', async () => {
  const leg = goldenLeg();
  let calls = 0;
  const client = new sdk.FermiV1TriggerClient({
    gatewayUrl: 'https://gateway.invalid/prod',
    apiKey,
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.equal(url, 'https://gateway.invalid/prod/relay/submit-intent');
      assert.equal(init.headers['x-api-key'], apiKey);
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      assert.equal(body.intent_version, 3);
      assert.deepEqual(body.trigger_order, golden.terms);
      assert.equal(body.payload_b64, golden.request.payload_b64);
      assert.equal(body.client_order_id, golden.request.client_order_id);
      return response(accepted);
    },
  });
  assert.deepEqual(
    await client.submitTriggerOrder(
      leg,
      sdk.signTriggerOrderLeg(leg, key.secretKey),
    ),
    accepted,
  );
  assert.equal(calls, 1);
});

test('trigger status and signed cancellation preserve pending outcomes and redact stored requests', async () => {
  const calls = [];
  const client = new sdk.FermiV1TriggerClient({
    gatewayUrl: 'https://gateway.invalid',
    apiKey,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'POST')
        return response({
          results: [
            { id: 'leg-1', outcome: 'cancel_pending', state: 'firing' },
          ],
          cancelled: [],
        });
      return response({
        orders: [
          {
            id: 'leg-1',
            state: 'armed',
            request: { payload_b64: 'SECRET' },
            payload_b64: 'SECRET',
          },
        ],
        history: [
          { request: { user_signature_b64: 'SECRET' }, event: 'armed' },
        ],
      });
    },
  });
  const list = await client.getTriggerOrders({
    fermiAccount: params.fermiAccount,
    activeOnly: true,
    clientOrderId: BigInt(golden.request.client_order_id),
    marketIndex: 2,
    limit: 1000,
  });
  assert(!JSON.stringify(list).includes('SECRET'));
  assert(
    calls[0].url.includes('client_order_id=' + golden.request.client_order_id),
  );
  assert(
    calls[0].url.includes('mango_account=' + golden.request.mango_account),
  );
  const result = await client.cancelTriggerOrders(
    cancelParams,
    sdk.signTriggerCancel(cancelParams, key.secretKey),
  );
  assert.equal(sdk.triggerCancelIsFinal(result), false);
  const body = JSON.parse(calls[1].init.body);
  assert.deepEqual(body.client_order_ids, [golden.request.client_order_id]);
  assert.equal(body.issued_at_ms, '1790000000000');
  assert.equal(body.mango_account, golden.request.mango_account);
  assert.equal(
    sdk.triggerCancelIsFinal({
      results: [{ outcome: 'cancelled' }, { outcome: 'already_terminal' }],
      cancelled: [],
    }),
    true,
  );
  assert.equal(
    sdk.triggerCancelIsFinal({
      results: [{ outcome: 'not_found' }],
      cancelled: [],
    }),
    false,
  );
  await assert.rejects(client.getTriggerOrder('../secret'), /invalid/);
  await assert.rejects(client.getTriggerOrders({}), /required/);
});

test('trigger routing never retries or falls back after unsupported, rate-limited or ambiguous replies', async () => {
  const leg = goldenLeg();
  const signature = sdk.signTriggerOrderLeg(leg, key.secretKey);
  for (const status of [404, 429, 503]) {
    let calls = 0;
    const client = new sdk.FermiV1TriggerClient({
      gatewayUrl: 'https://gateway.invalid',
      apiKey,
      fetchImpl: async () => {
        calls += 1;
        return response({ error: 'unavailable' }, status, {
          'retry-after': '3',
        });
      },
    });
    await assert.rejects(
      client.submitTriggerOrder(leg, signature),
      (err) => err.status === status,
    );
    assert.equal(calls, 1);
  }
  const client = new sdk.FermiV1TriggerClient({
    gatewayUrl: 'https://gateway.invalid',
    apiKey,
    fetchImpl: async () =>
      response({ sequence: '123', tx_signature: 'unexpected-immediate-order' }),
  });
  await assert.rejects(
    client.submitTriggerOrder(leg, signature),
    /not acknowledged/,
  );
});

test('protobuf adds trigger field 17 and response fields without changing existing wire fields', () => {
  const definition = protoLoader.loadSync(
    require('node:path').join(__dirname, '../proto/ctm_sequencer.proto'),
    { keepCase: true, longs: String, defaults: true },
  );
  const service =
    grpc.loadPackageDefinition(definition).ctmsequencer.CtmSequencerRelayer
      .service.SubmitIntent;
  const leg = goldenLeg();
  const request = sdk.triggerOrderRequest(
    leg,
    sdk.signTriggerOrderLeg(leg, key.secretKey),
  );
  const decoded = service.requestDeserialize(service.requestSerialize(request));
  assert.equal(decoded.intent_version, 3);
  assert.deepEqual(decoded.trigger_order, golden.terms);
  const normal = service.requestDeserialize(
    service.requestSerialize({
      ...request,
      trigger_order: undefined,
      intent_version: 2,
    }),
  );
  assert.equal(normal.trigger_order, null);
  assert.equal(normal.intent_version, 2);
  const reply = service.responseDeserialize(
    service.responseSerialize({
      sequence: '0',
      tx_signature: '',
      trigger_order_id: accepted.trigger_order_id,
      trigger_order_status: 'armed',
    }),
  );
  assert.equal(reply.trigger_order_id, accepted.trigger_order_id);
});

test('gRPC trigger helper preserves withheld results and blocks a v2 routing marker before network IO', async () => {
  const leg = goldenLeg();
  const signature = sdk.signTriggerOrderLeg(leg, key.secretKey);
  const result = await sdk.submitTriggerOrderViaRelayer(
    {
      submitIntent: async (req) => {
        assert.equal(req.intent_version, 3);
        assert(req.trigger_order);
        return { ...accepted, sequence: '0', tx_signature: '' };
      },
    },
    leg,
    signature,
  );
  assert.equal(result.trigger_order_id, accepted.trigger_order_id);
  await assert.rejects(
    sdk.FermiV1RelayerClient.prototype.submitIntent.call(
      {},
      { trigger_order: golden.terms, intent_version: 2 },
    ),
    /intent_version 3/,
  );
});

test('FLP metadata routes preserve native quantities and unavailable user history through the gateway', async () => {
  const paths = [];
  const snapshot = {
    schema_version: 1,
    generated_ts_ms: 1,
    vault: golden.request.mango_account,
    owner: null,
    user_account_exists: false,
    source: { warnings: ['indicative valuation'] },
    data: { shares: { pricingSupply: '18446744073709551615' }, user: null },
  };
  const state = new sdk.FermiV1StateClient({
    gatewayUrl: 'https://gateway.invalid/prod',
    apiKey,
    fetchImpl: async (url, init) => {
      paths.push(url);
      assert.equal(init.headers['x-api-key'], apiKey);
      return response(snapshot);
    },
  });
  for (const result of [
    await state.getFlpVault(params.fermiAccount),
    await state.getFlpVaultPortfolio(params.fermiAccount),
    await state.getFlpVaultUser(params.fermiAccount, params.signer),
  ]) {
    assert.equal(result.data.shares.pricingSupply, '18446744073709551615');
    assert.equal(result.data.user, null);
    assert.deepEqual(result.source.warnings, ['indicative valuation']);
  }
  assert(paths[0].endsWith('/state/vaults/' + params.fermiAccount));
  assert(paths[1].endsWith('/portfolio'));
  assert(paths[2].endsWith('/users/' + params.signer));
  const wrong = new sdk.FermiV1StateClient({
    gatewayUrl: 'https://gateway.invalid',
    apiKey,
    fetchImpl: async () => response({ schema_version: 2 }),
  });
  await assert.rejects(wrong.getFlpVault(params.fermiAccount), /unsupported/);
});

test('FLP pricing context uses vault ownership and active-position health before event queues', async () => {
  const vault = pk(golden.request.mango_account);
  const client = new sdk.FlpClient({}, params.group);
  const authority = client.authority(vault);
  const state = {
    group: params.group,
    fermiAccount: params.fermiAccount,
    quoteMint: params.group,
    quoteBank: params.executionQueue,
    shareMint: params.signer,
    feeRecipient: params.signer,
  };
  const account = { group: params.group, owner: authority };
  const queue = params.signer;
  const core = {
    programId: params.group,
    getFermiAccount: async () => account,
    getGroup: async () => ({
      getFirstBankByMint: () => ({
        publicKey: state.quoteBank,
        vault,
        oracle: queue,
      }),
    }),
    buildHealthRemainingAccounts: async (group, accounts, banks) => {
      assert.equal(accounts[0], account);
      assert.equal(banks[0].publicKey, state.quoteBank);
      return [state.quoteBank];
    },
  };
  client.withEventQueues = async (health) => [
    ...health,
    { pubkey: queue, isSigner: false, isWritable: false },
  ];
  const pricing = await sdk.buildFlpPricingContext(core, client, vault, state);
  assert.equal(pricing.health.length, 1);
  assert.equal(pricing.pricingHealth.length, 2);
  assert.equal(
    pricing.pricingAccounts['pricing.fermi.fermiAccount'],
    state.fermiAccount,
  );
  assert.equal(pricing.accounts['fermi.fermiProgram'], core.programId);
  account.owner = PublicKey.default;
  await assert.rejects(
    sdk.buildFlpPricingContext(core, client, vault, state),
    /authority/,
  );
});

test('UI trigger preparation uses converted lots and the canonical sorted all-market health suffix', async () => {
  const address = (n) => new PublicKey(new Uint8Array(32).fill(n));
  const bank = { tokenIndex: 0, publicKey: address(10), oracle: address(11) };
  const market = (index) => ({
    publicKey: address(20 + index),
    perpMarketIndex: index,
    bids: address(30 + index),
    asks: address(40 + index),
    eventQueue: address(50 + index),
    oracle: address(60 + index),
    uiPrice: 100,
    uiPriceToLots: (n) => BigInt(Math.floor(n * 10)),
    uiBaseToLots: (n) => BigInt(Math.floor(n * 100)),
  });
  const markets = [market(0), market(1), market(2)];
  const context = {
    programId: address(70),
    user: { publicKey: params.signer },
    fermiAccount: {
      publicKey: params.fermiAccount,
      tokens: [{ tokenIndex: 0 }],
      serum3: [],
    },
    group: {
      publicKey: params.group,
      getPerpMarketByMarketIndex: (i) => markets[i],
      getFirstBankForPerpSettlement: () => bank,
      mintInfosMapByTokenIndex: new Map([
        [
          0,
          {
            tokenIndex: 0,
            firstBank: () => bank.publicKey,
            oracle: bank.oracle,
          },
        ],
      ]),
      perpMarketsMapByMarketIndex: new Map([
        [2, markets[2]],
        [0, markets[0]],
        [1, markets[1]],
      ]),
    },
    client: { deriveFallbackOracleContexts: async () => new Map() },
  };
  const legs = await sdk.prepareSlTpOrdersUi(context, {
    marketIndex: 0,
    position: 'long',
    size: 0.01,
    stopLossPrice: 90,
    takeProfitPrice: 120,
    slippageBps: 50,
    expiryTs: 1790000000n,
  });
  assert.deepEqual(
    legs.map((l) => l.terms.triggerPriceLots),
    [900n, 1200n],
  );
  assert.equal(legs[0].payload.readBigInt64LE(13), 1n);
  assert.equal(
    legs[0].params.executionQueue.toBase58(),
    sdk.findExecutionQueueV5Pda(context.programId, params.group, 0).toBase58(),
  );
  assert.deepEqual(
    legs[0].params.remainingAccounts.slice(8).map((m) => m.pubkey.toBase58()),
    [
      bank.publicKey,
      bank.oracle,
      ...markets.map((m) => m.publicKey),
      ...markets.map((m) => m.oracle),
    ].map(String),
  );
});
