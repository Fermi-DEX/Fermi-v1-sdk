/** Integer mirrors of RC6.1 math.rs. Inputs are native units, never UI decimals.
 * Supply must include accrued fee shares; NAV must come from current program-compatible valuation.
 * These helpers do not compute NAV from core positions or predict successful execution.
 */
export const VIRTUAL_ASSETS = 1_000_000n;
export const VIRTUAL_SHARES = 1_000_000n;
export const PRICE_SCALE = 1_000_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
function u64(n: bigint): bigint {
  if (n < 0n || n > U64_MAX) throw new Error('Expected u64');
  return n;
}
function navI64(n: bigint): bigint {
  if (n < -(1n << 63n) || n >= 1n << 63n) throw new Error('Expected i64 NAV');
  return n;
}
function feeRate(bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error('Invalid fee bps');
  return BigInt(bps);
}
export interface ShareRatio { numerator: bigint; denominator: bigint }
export function pricingSupply(mintSupply: bigint, owedUnmintedShares: bigint, lockedShares: bigint): bigint {
  return u64(u64(mintSupply) + u64(owedUnmintedShares) + u64(lockedShares));
}
export function depositRatio(supply: bigint, navHigh: bigint): ShareRatio {
  u64(supply); navI64(navHigh);
  if ((navHigh <= 0n && supply !== 0n) || navHigh + VIRTUAL_ASSETS <= 0n) throw new Error('Vault insolvent');
  return { numerator: supply + VIRTUAL_SHARES, denominator: navHigh + VIRTUAL_ASSETS };
}
export function withdrawRatio(supply: bigint, navLow: bigint): ShareRatio {
  u64(supply); navI64(navLow);
  return { numerator: navLow <= 0n ? 0n : navLow + VIRTUAL_ASSETS, denominator: supply + VIRTUAL_SHARES };
}
/** Recovery pays real assets against real supply, without virtual offsets. */
export function recoveryWithdrawRatio(supply: bigint, navLow: bigint): ShareRatio {
  u64(supply); navI64(navLow);
  if (supply === 0n || navLow < 0n) throw new Error('Vault insolvent');
  return { numerator: navLow, denominator: supply };
}
export function applyRatioFloor(amount: bigint, ratio: ShareRatio): bigint {
  u64(amount);
  const { numerator, denominator } = ratio;
  if (numerator < 0n || denominator <= 0n || numerator > U128_MAX || denominator > U128_MAX || amount * numerator > U128_MAX)
    throw new Error('Invalid or overflowing u128 ratio');
  return u64(amount * numerator / denominator);
}
export function priceE12(nav: bigint, supply: bigint): bigint {
  navI64(nav); u64(supply);
  const assets = nav + VIRTUAL_ASSETS;
  return assets <= 0n ? 0n : assets * PRICE_SCALE / (supply + VIRTUAL_SHARES);
}
/** Fee is rounded up before minting shares; minShares is still enforced on chain. */
export function quoteDeposit(amount: bigint, supply: bigint, navHigh: bigint, depositFeeBps: number) {
  u64(amount);
  const fee = (amount * feeRate(depositFeeBps) + 9_999n) / 10_000n;
  const net = amount - fee;
  return { amount, fee, net, shares: applyRatioFloor(net, depositRatio(supply, navHigh)) };
}
/** Individual withdrawal claims round their fee up (batch funding rounds it down). */
export function claimPayout(shares: bigint, ratio: ShareRatio, withdrawFeeBps: number) {
  const gross = applyRatioFloor(shares, ratio);
  const fee = (gross * feeRate(withdrawFeeBps) + 9_999n) / 10_000n;
  return { shares, gross, fee, net: gross - fee };
}
