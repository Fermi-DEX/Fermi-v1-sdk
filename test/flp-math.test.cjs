const assert = require('node:assert/strict');
const { test } = require('node:test');
const { flpV4: m } = require('../dist');

test('RC6.1 virtual offsets, fee rounding and recovery ratios use exact native integers', () => {
  assert.equal(m.pricingSupply(100n, 20n, 30n), 150n);
  assert.deepEqual(m.depositRatio(0n, 0n), { numerator: 1000000n, denominator: 1000000n });
  assert.deepEqual(m.depositRatio(100n, 200n), { numerator: 1000100n, denominator: 1000200n });
  assert.deepEqual(m.withdrawRatio(100n, 200n), { numerator: 1000200n, denominator: 1000100n });
  assert.deepEqual(m.recoveryWithdrawRatio(100n, 200n), { numerator: 200n, denominator: 100n });
  assert.deepEqual(m.quoteDeposit(101n, 0n, 0n, 100), { amount: 101n, fee: 2n, net: 99n, shares: 99n });
  assert.deepEqual(m.quoteDeposit(10000n, 1000000n, 3000000n, 100), { amount: 10000n, fee: 100n, net: 9900n, shares: 4950n });
  assert.equal(m.applyRatioFloor(101n, { numerator: 200n, denominator: 3n }), 6733n);
  assert.equal(m.priceE12(3000000n, 1000000n), 2000000000000n);
  assert.equal(m.priceE12(-1000000n, 10n), 0n);
  assert.equal(m.applyRatioFloor(9007199254740993n, m.depositRatio(0n, 0n)), 9007199254740993n);
  assert.equal(m.batchPayout(101n, 200n, 3n, 100).net, 6666n);
  assert.equal(m.claimPayout(101n, { numerator: 200n, denominator: 3n }, 100).net, 6665n);
});
test('share calculations reject insolvency and Rust integer overflows', () => {
  for (const nav of [0n, -1n, -1000000n]) {
    assert.throws(() => m.depositRatio(10n, nav), /insolvent/);
    assert.equal(m.withdrawRatio(10n, nav).numerator, 0n);
  }
  assert.throws(() => m.depositRatio(0n, -1000000n), /insolvent/);
  assert.throws(() => m.recoveryWithdrawRatio(0n, 0n), /insolvent/);
  assert.throws(() => m.recoveryWithdrawRatio(1n, -1n), /insolvent/);
  assert.throws(() => m.pricingSupply((1n << 64n) - 1n, 1n, 0n), /u64/);
  assert.throws(() => m.depositRatio(-1n, 1n), /u64/);
  assert.throws(() => m.withdrawRatio(1n, 1n << 63n), /i64/);
  assert.throws(() => m.applyRatioFloor(2n, { numerator: (1n << 128n) - 1n, denominator: 1n }), /overflow/);
  assert.throws(() => m.applyRatioFloor(1n, { numerator: 1n << 64n, denominator: 1n }), /u64/);
  assert.throws(() => m.applyRatioFloor(1n, { numerator: 1n, denominator: 0n }), /ratio/);
  for (const bps of [-1, 10001, NaN, 1.5]) assert.throws(() => m.quoteDeposit(1n, 0n, 0n, bps), /fee/);
});
