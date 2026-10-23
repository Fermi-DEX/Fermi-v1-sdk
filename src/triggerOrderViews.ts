// Synced from fermi-v1 7afba98770b6bae99d839c296f3c7fd4750ab18c.
/**
 * The public, redacted view of a stop-loss / take-profit leg, as served by the
 * trigger-orders keeper (`GET /v1/trigger-orders`, see
 * trigger-orders-hardening-contract.md, "Public read API (redacted)").
 *
 * A stored leg is a signed, replayable intent. Nothing that leaves the keeper
 * through the bridge or the harness may carry the signed request, so both
 * rebuild every leg from an explicit list of fields instead of forwarding
 * the keeper's objects:
 *
 * - `sanitizeTriggerLegView` (harness): strict. A leg whose identity, market
 *   or price fields are not exactly as specified is dropped.
 * - `redactTriggerKeeperResponse` (bridge): lenient. Keeps the keeper's
 *   values but only under whitelisted keys, and strips the forbidden keys
 *   everywhere else in the response.
 *
 * No dependencies: this file is imported by the harness and by the bridge.
 */

export type TriggerLegKind = 'stop_loss' | 'take_profit';
export type TriggerLegDirection = 'at_or_below' | 'at_or_above';
export type TriggerLegSide = 'bid' | 'ask';

export type TriggerLegArmed = {
  slot: number;
  ts_ms: number;
  position_lots: string;
};

export type TriggerLegLastFire = {
  attempt: number;
  sequence: string | null;
  ts_ms: number;
  outcome: string | null;
};

export type TriggerLegView = {
  id: string;
  mango_account: string;
  account_owner: string;
  market_index: number;
  client_order_id: string;
  kind: TriggerLegKind;
  direction: TriggerLegDirection;
  side: TriggerLegSide;
  trigger_price_lots: string;
  limit_price_lots: string;
  max_base_lots: string;
  reduce_only: boolean;
  oco_group: string;
  expiry_ts: string;
  state: string;
  state_reason: string | null;
  wait_reason: string | null;
  resign_required: boolean;
  created_ms: number;
  updated_ms: number;
  armed: TriggerLegArmed | null;
  last_fire: TriggerLegLastFire | null;
};

/** Every key a leg view may carry. Nothing else is ever passed through. */
export const TRIGGER_LEG_VIEW_FIELDS = [
  'id',
  'mango_account',
  'account_owner',
  'market_index',
  'client_order_id',
  'kind',
  'direction',
  'side',
  'trigger_price_lots',
  'limit_price_lots',
  'max_base_lots',
  'reduce_only',
  'oco_group',
  'expiry_ts',
  'state',
  'state_reason',
  'wait_reason',
  'resign_required',
  'created_ms',
  'updated_ms',
  'armed',
  'last_fire',
] as const;

export const TRIGGER_LEG_ARMED_FIELDS = [
  'slot',
  'ts_ms',
  'position_lots',
] as const;

export const TRIGGER_LEG_LAST_FIRE_FIELDS = [
  'attempt',
  'sequence',
  'ts_ms',
  'outcome',
] as const;

/**
 * Keys of a stored leg that make it replayable. They are removed wherever
 * they appear in a keeper response, at any depth.
 */
export const TRIGGER_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'payload_b64',
  'user_signature_b64',
  'remaining_accounts',
  'request',
]);

/** States in which a leg can still fire. */
export const TRIGGER_LEG_ACTIVE_STATES: ReadonlySet<string> = new Set([
  'pending',
  'armed',
  'firing',
  'awaiting_outcome',
]);

export const TRIGGER_LEG_TERMINAL_STATES: ReadonlySet<string> = new Set([
  'filled',
  'cancelled',
  'expired',
  'failed',
  'fire_unknown',
]);

const UNSIGNED_DECIMAL = /^\d{1,20}$/;
const SIGNED_DECIMAL = /^-?\d{1,20}$/;
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LEG_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const STATE_NAME = /^[a-z_]{1,48}$/;
const MAX_REASON_CHARS = 200;
const MAX_REDACT_DEPTH = 12;

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBase58Pubkey(value: unknown): value is string {
  return typeof value === 'string' && BASE58_PUBKEY.test(value);
}

export function isTriggerLegId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    LEG_ID.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

/**
 * A u64 / i64 the keeper sends as a decimal string. A JSON number is also
 * accepted when it is a safe integer, and is returned as a string so the
 * output always has the contract's type.
 */
function decimalString(value: unknown, signed = false): string | null {
  if (typeof value === 'string') {
    return (signed ? SIGNED_DECIMAL : UNSIGNED_DECIMAL).test(value)
      ? value
      : null;
  }
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    (signed || value >= 0)
  ) {
    return String(value);
  }
  return null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && UNSIGNED_DECIMAL.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** `null` and absent are both "no reason"; anything else must be a string. */
function reasonString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.length > MAX_REASON_CHARS
    ? value.slice(0, MAX_REASON_CHARS)
    : value;
}

function sanitizeArmed(value: unknown): TriggerLegArmed | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const slot = nonNegativeSafeInteger(value.slot);
  const tsMs = nonNegativeSafeInteger(value.ts_ms);
  const positionLots = decimalString(value.position_lots, true);
  if (slot === null || tsMs === null || positionLots === null) {
    return null;
  }
  return { slot, ts_ms: tsMs, position_lots: positionLots };
}

function sanitizeLastFire(value: unknown): TriggerLegLastFire | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const attempt = nonNegativeSafeInteger(value.attempt);
  const tsMs = nonNegativeSafeInteger(value.ts_ms);
  const sequence =
    value.sequence === null || value.sequence === undefined
      ? null
      : decimalString(value.sequence);
  const outcome = reasonString(value.outcome);
  if (
    attempt === null ||
    tsMs === null ||
    outcome === undefined ||
    (sequence === null &&
      value.sequence !== null &&
      value.sequence !== undefined)
  ) {
    return null;
  }
  return { attempt, sequence, ts_ms: tsMs, outcome };
}

/**
 * Strict validation of one leg from the keeper. Returns a fresh object that
 * holds the whitelisted fields only, or `null` when the leg is malformed.
 *
 * The fields a client needs to show and to match a leg (ids, account,
 * market, kind, direction, side, prices, size, expiry, state, the
 * `resign_required` flag and the timestamps) must be exactly as specified.
 * `armed` and `last_fire` are detail: when one of them is malformed it
 * becomes `null` instead of hiding a live stop from its owner.
 */
export function sanitizeTriggerLegView(raw: unknown): TriggerLegView | null {
  if (!isPlainRecord(raw)) {
    return null;
  }
  const marketIndex = nonNegativeSafeInteger(raw.market_index);
  const clientOrderId = decimalString(raw.client_order_id);
  const triggerPriceLots = decimalString(raw.trigger_price_lots);
  const limitPriceLots = decimalString(raw.limit_price_lots);
  const maxBaseLots = decimalString(raw.max_base_lots);
  const ocoGroup = decimalString(raw.oco_group);
  const expiryTs = decimalString(raw.expiry_ts);
  const createdMs = nonNegativeSafeInteger(raw.created_ms);
  const updatedMs = nonNegativeSafeInteger(raw.updated_ms);
  const stateReason = reasonString(raw.state_reason);
  const waitReason = reasonString(raw.wait_reason);
  if (
    !isTriggerLegId(raw.id) ||
    !isBase58Pubkey(raw.mango_account) ||
    !isBase58Pubkey(raw.account_owner) ||
    marketIndex === null ||
    marketIndex > 0xffff ||
    clientOrderId === null ||
    (raw.kind !== 'stop_loss' && raw.kind !== 'take_profit') ||
    (raw.direction !== 'at_or_below' && raw.direction !== 'at_or_above') ||
    (raw.side !== 'bid' && raw.side !== 'ask') ||
    triggerPriceLots === null ||
    limitPriceLots === null ||
    maxBaseLots === null ||
    typeof raw.reduce_only !== 'boolean' ||
    ocoGroup === null ||
    expiryTs === null ||
    typeof raw.state !== 'string' ||
    !STATE_NAME.test(raw.state) ||
    stateReason === undefined ||
    waitReason === undefined ||
    typeof raw.resign_required !== 'boolean' ||
    createdMs === null ||
    updatedMs === null
  ) {
    return null;
  }
  return {
    id: raw.id,
    mango_account: raw.mango_account,
    account_owner: raw.account_owner,
    market_index: marketIndex,
    client_order_id: clientOrderId,
    kind: raw.kind,
    direction: raw.direction,
    side: raw.side,
    trigger_price_lots: triggerPriceLots,
    limit_price_lots: limitPriceLots,
    max_base_lots: maxBaseLots,
    reduce_only: raw.reduce_only,
    oco_group: ocoGroup,
    expiry_ts: expiryTs,
    state: raw.state,
    state_reason: stateReason,
    wait_reason: waitReason,
    resign_required: raw.resign_required,
    created_ms: createdMs,
    updated_ms: updatedMs,
    armed: sanitizeArmed(raw.armed),
    last_fire: sanitizeLastFire(raw.last_fire),
  };
}

function isJsonScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function pickScalars(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (
      Object.prototype.hasOwnProperty.call(value, field) &&
      isJsonScalar(value[field])
    ) {
      out[field] = value[field];
    }
  }
  return out;
}

/**
 * Lenient whitelist of one leg: the keeper's scalar values under the leg
 * view's keys, nothing else. Returns `null` for a non-object.
 */
export function whitelistTriggerLegView(
  raw: unknown,
): Record<string, unknown> | null {
  if (!isPlainRecord(raw)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const field of TRIGGER_LEG_VIEW_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) {
      continue;
    }
    const value = raw[field];
    if (field === 'armed') {
      out[field] = pickScalars(value, TRIGGER_LEG_ARMED_FIELDS);
    } else if (field === 'last_fire') {
      out[field] = pickScalars(value, TRIGGER_LEG_LAST_FIRE_FIELDS);
    } else if (isJsonScalar(value)) {
      out[field] = value;
    }
  }
  return out;
}

function stripForbiddenKeys(value: unknown, depth: number): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripForbiddenKeys(item, depth + 1));
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (TRIGGER_FORBIDDEN_KEYS.has(key) || key === '__proto__') {
        continue;
      }
      out[key] = stripForbiddenKeys(value[key], depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Defence in depth for the bridge: whatever JSON the keeper answered, the
 * forbidden keys are removed at every depth, and the legs under `orders` and
 * `order` are reduced to the leg view's fields. Everything else (errors,
 * `history`, cancel `results`) keeps its shape.
 */
export function redactTriggerKeeperResponse(body: unknown): unknown {
  const stripped = stripForbiddenKeys(body, 0);
  if (!isPlainRecord(stripped)) {
    return stripped;
  }
  if (Array.isArray(stripped.orders)) {
    stripped.orders = stripped.orders
      .map((leg) => whitelistTriggerLegView(leg))
      .filter((leg) => leg !== null);
  }
  if (stripped.order !== undefined && stripped.order !== null) {
    stripped.order = whitelistTriggerLegView(stripped.order);
  }
  return stripped;
}
