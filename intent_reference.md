# Intent Reference

This file captures the current `v2` relayer intent shape and the direct
on-chain enqueue fallback now implemented in this SDK.

The SDK now exposes two perp intent paths in [src/trading.ts](./src/trading.ts):

- relayed submit via `submitPerp*ViaRelayer(...)`
- direct on-chain enqueue via `submitPerp*Direct(...)`

Both paths use the same user-signed `v2` intent digest. The difference is:

- relayed submit sends the signed intent to the relayer, which derives and
  finalizes dispatch accounts server-side
- direct enqueue sends the user signature plus `execution_queue_enqueue_direct`
  on-chain, with no CTM signature and the program-assigned delayed execution
  speedbump

## Current Deployment Values

- `bridge_url`: `https://34.178.149.237/relay/submit-intent`
- `relayer_grpc_addr`: `34.178.149.237:9090`
- `group`: `Cj8vUC2nWbREhofnD3iWk4j8CD9Fo6j9c33M5ZFKLVPB`
- `execution_queue`: `8J7vAomtCVabazRNs8XH4BF3w4BVP852QoASg9yrXUaa`
- `market`: `0`
- `user_owner`: `7RZq8cu1UCRPEWWkREgUSscfTz5UiYckWVMsvS8x5jj3`
- `mango_account`: `B4DiKgfGdFSjmjQzrfoaCRJgjiVTJi96XJsGKoWaX87N`

## HTTP Bridge JSON

Use this against `POST https://34.178.149.237/relay/submit-intent`.

Important:

- The HTTP bridge expects `payload_b64` and `user_signature_b64`.
- The gRPC relayer expects raw `payload` bytes and raw `user_signature` bytes.
- The fee preference is external to the signed intent payload:
  - HTTP bridge: `_base_fee`
  - gRPC / proto: `base_fee`
- `intent_version`, `target_kind`, and `target_index` are now required for `v2`
  clients.
- `remaining_accounts` may still be sent for debugging, but `v2` relayer
  execution derives canonical accounts locally.
- Some older docs still show `payload` and `user_signature` in the HTTP body. The live bridge code does not.

```json
{
  "group": "Cj8vUC2nWbREhofnD3iWk4j8CD9Fo6j9c33M5ZFKLVPB",
  "execution_queue": "8J7vAomtCVabazRNs8XH4BF3w4BVP852QoASg9yrXUaa",
  "market": "0",
  "intent_version": 2,
  "target_kind": 0,
  "target_index": 0,
  "_base_fee": "AUTO",
  "payload_b64": "<base64-encoded queue payload bytes>",
  "remaining_accounts": [
    {
      "pubkey": "Cj8vUC2nWbREhofnD3iWk4j8CD9Fo6j9c33M5ZFKLVPB",
      "is_signer": false,
      "is_writable": false
    },
    {
      "pubkey": "B4DiKgfGdFSjmjQzrfoaCRJgjiVTJi96XJsGKoWaX87N",
      "is_signer": false,
      "is_writable": true
    },
    {
      "pubkey": "7RZq8cu1UCRPEWWkREgUSscfTz5UiYckWVMsvS8x5jj3",
      "is_signer": false,
      "is_writable": false
    },
    {
      "pubkey": "83GFRTYyAeubQBuhS9f7QKJXYCJEM7xCBqDYKSgghA1w",
      "is_signer": false,
      "is_writable": true
    },
    {
      "pubkey": "3Cvb3Uaee1g4eqrxxb9aHBRcWskcJ8ehNKzV7GjVZLE6",
      "is_signer": false,
      "is_writable": true
    },
    {
      "pubkey": "9HKD3XFPhvZoNQHdhobyERrpV6vesSYUzhaaZFoHoEZD",
      "is_signer": false,
      "is_writable": true
    },
    {
      "pubkey": "BCTQe6tm973Rxk4TZDX2ozvxiWpvKZoiQFvDeLKtHScV",
      "is_signer": false,
      "is_writable": true
    },
    {
      "pubkey": "EpuCmegExhEPhxofRcktPQvxhQd7GyBkyE8DYyGEnavF",
      "is_signer": false,
      "is_writable": false
    },
    {
      "pubkey": "BabdPVkYbeCf44nFFbmzGnkCm27RV2RombwUn33U4t59",
      "is_signer": false,
      "is_writable": false
    },
    {
      "pubkey": "BnVHvdioN12A2bsCLwMaPJAGR6VAAdbuLC3Wf1tHC7Qa",
      "is_signer": false,
      "is_writable": false
    },
    {
      "pubkey": "83GFRTYyAeubQBuhS9f7QKJXYCJEM7xCBqDYKSgghA1w",
      "is_signer": false,
      "is_writable": false
    },
    {
      "pubkey": "EpuCmegExhEPhxofRcktPQvxhQd7GyBkyE8DYyGEnavF",
      "is_signer": false,
      "is_writable": false
    }
  ],
  "min_execute_slot": "0",
  "expires_at_slot": "0",
  "user_owner": "7RZq8cu1UCRPEWWkREgUSscfTz5UiYckWVMsvS8x5jj3",
  "mango_account": "B4DiKgfGdFSjmjQzrfoaCRJgjiVTJi96XJsGKoWaX87N",
  "user_signature_b64": "<base64-ed25519-signature-over-user_intent_message>"
}
```

For most clients, `_base_fee: "AUTO"` is the correct default.

If you want to cap what the relayer may charge, send a maximum instead of
`AUTO`, for example:

- `"25000lamports"`
- `"0.00002sol"`

Fields that must be generated locally by the bot:

- `payload_b64`
- `user_signature_b64`
- `intent_version`
- `target_kind`
- `target_index`

`_base_fee` should be set by the client, but it is not part of the user-signed
digest.

See [fee_system.md](./fee_system.md) for the exact fee-balance and deposit flow.

## Critical Payload Warning

`payload_b64` must be the raw execution-queue payload bytes.

It must not be:

- an Anchor instruction discriminator plus body
- a serialized JSON object
- a hex string encoded as UTF-8
- base64 of human-readable hex text

For `PerpPlaceOrderV2`, the queue payload always starts with this 4-byte header:

```text
01 00 00 00
```

Meaning:

- `01` = queue payload version v1
- `00` = `PerpPlaceOrderV2` variant
- `0000` = flags

Wrong:

```text
e8e09a4e9eb806db ...
```

That is an Anchor instruction discriminator for direct `perp_place_order_v2` instruction data. If you send that to the relayer as `payload_b64`, the queue decoder rejects it with error `6086`.

Right:

```text
01 00 00 00 ...
```

For the example order:

- `side = bid`
- `priceLots = 10000`
- `maxBaseLots = 100`
- `maxQuoteLots = i64::MAX`
- `clientOrderId = 1775489806394`
- `orderType = postOnly`
- `selfTradeBehavior = decrementTake`
- `reduceOnly = false`
- `expiryTimestamp = 0`
- `limit = 10`

the correct queue payload hex is:

```text
010000000010270000000000006400000000000000ffffffffffffff7f3a7070639d010000020000000000000000000a
```

This is:

```text
01000000
+ 00
+ 1027000000000000
+ 6400000000000000
+ ffffffffffffff7f
+ 3a7070639d010000
+ 02
+ 00
+ 00
+ 0000000000000000
+ 0a
```

If the first byte of the decoded payload is not `01`, the program throws:

- `6086`
- `ExecutionQueuePayloadVersionUnsupported`
- `execution queue payload version unsupported`

## Exact User Intent Signing Construction

The user signs a 32-byte digest. The user does not sign the JSON request body.

Authoritative implementation:

- `src/trading.ts`
- `../mng-v4/ts/client/src/executionQueue.ts`

The canonical `v2` flow is:

1. Build the raw queue payload bytes for the requested action.
2. Compute `payload_hash = sha256(payload)`.
3. Build `user_intent_message = sha256(...)` over the exact byte concat below.
4. Sign `user_intent_message` with Ed25519 detached signature.
5. Encode the raw 64-byte signature as base64 and send it as `user_signature_b64`.

The user message no longer signs `accounts_hash`. The explicit target is signed
instead, which lets the relayer derive `remaining_accounts` safely.

The exact digest is:

```text
sha256(
  utf8("mango-v4-user-intent-v2")
  || group_pubkey_32
  || mango_account_pubkey_32
  || user_owner_pubkey_32
  || kind_u8
  || target_kind_u8
  || target_index_u16_le
  || payload_hash_32
)
```

For relayed perp intents:

- `kind = 0`
- `target_kind = 0` (`PerpMarket`)
- `target_index = market_index`
- the pubkeys are raw 32-byte values, not base58 strings
- `market`, `min_execute_slot`, and `expires_at_slot` are request metadata and
  are not part of the user-signed digest
- `base_fee` / `_base_fee` is also request metadata and is not part of the
  user-signed digest

For direct on-chain enqueue:

- the same `v2` user digest is signed
- there is no CTM signature
- the SDK builds `execution_queue_enqueue_direct`
- the program assigns `sequence = max_seen_sequence + 1`
- the program enforces the direct-submit speedbump before execution

## Exact Accounts Hash Rule

Each account contributes exactly 34 bytes:

```text
pubkey_32 || is_signer_u8 || is_writable_u8
```

The hash is:

```text
sha256(
  account0_34
  || account1_34
  || account2_34
  || ...
)
```

Important:

- account order matters
- duplicates matter
- do not de-duplicate the list

For CTM relayer submissions, the helper path uses the relayer-compatible account hash, not the plain raw hash. It first merges effective runtime flags from:

- `group`, writable `true`
- `execution_queue`, writable `true`
- `Sysvar1nstructions1111111111111111111111111`, writable `false`

and then reapplies those effective flags to the submitted `remaining_accounts` array before hashing.

That is why the sample lane above may submit the first `group` account as not writable, but it is still hashed as writable in the canonical relayer path.

## `buildExecutionQueueUserIntent(...)`

This SDK already uses the correct helper flow in `src/trading.ts`.

The intended pattern is:

```ts
const remainingAccounts = await buildCanonicalPerpRemainingAccounts(
  context,
  marketIndex,
);

const intent = await buildExecutionQueueUserIntent({
  group: context.group.publicKey,
  executionQueue: context.executionQueuePk,
  mangoAccount: context.mangoAccount.publicKey,
  userOwner: context.user.publicKey,
  payload,
  remainingAccounts,
});

const userSignature = signExecutionQueueIntentMessage(
  context.user.secretKey,
  intent.userIntentMessage,
);
```

Important:

- pass `executionQueue` into `buildExecutionQueueUserIntent(...)`
- if `executionQueue` is omitted, the helper falls back to plain `hashExecutionQueueAccounts(...)`
- for relayer submissions, that fallback can produce the wrong `accounts_hash`

## Minimal Reference Implementation

```ts
import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const USER_INTENT_DOMAIN = Buffer.from('mango-v4-user-intent-v1', 'utf8');
const SYSVAR_INSTRUCTIONS = 'Sysvar1nstructions1111111111111111111111111';

type Meta = {
  pubkey: string;
  is_signer: boolean;
  is_writable: boolean;
};

function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

function pubkey32(pk: string): Buffer {
  return Buffer.from(bs58.decode(pk));
}

function canonicalizeRemainingAccountsForRelayer(
  group: string,
  executionQueue: string,
  remaining: Meta[],
): Meta[] {
  const merged = new Map<string, { is_signer: boolean; is_writable: boolean }>();
  const fixed: Meta[] = [
    { pubkey: group, is_signer: false, is_writable: true },
    { pubkey: executionQueue, is_signer: false, is_writable: true },
    { pubkey: SYSVAR_INSTRUCTIONS, is_signer: false, is_writable: false },
  ];

  for (const a of [...fixed, ...remaining]) {
    const prev = merged.get(a.pubkey);
    if (!prev) {
      merged.set(a.pubkey, {
        is_signer: !!a.is_signer,
        is_writable: !!a.is_writable,
      });
    } else {
      prev.is_signer = prev.is_signer || !!a.is_signer;
      prev.is_writable = prev.is_writable || !!a.is_writable;
    }
  }

  return remaining.map((a) => {
    const eff = merged.get(a.pubkey)!;
    return {
      pubkey: a.pubkey,
      is_signer: eff.is_signer,
      is_writable: eff.is_writable,
    };
  });
}

function hashRemainingAccounts(accounts: Meta[]): Buffer {
  const chunks: Buffer[] = [];
  for (const a of accounts) {
    chunks.push(pubkey32(a.pubkey));
    chunks.push(Buffer.from([a.is_signer ? 1 : 0]));
    chunks.push(Buffer.from([a.is_writable ? 1 : 0]));
  }
  return sha256(Buffer.concat(chunks));
}

function buildUserIntentMessage(params: {
  group: string;
  executionQueue: string;
  mangoAccount: string;
  userOwner: string;
  kind: number;
  payload: Buffer;
  remainingAccounts: Meta[];
}): Buffer {
  const payloadHash = sha256(params.payload);
  const effectiveRemaining = canonicalizeRemainingAccountsForRelayer(
    params.group,
    params.executionQueue,
    params.remainingAccounts,
  );
  const accountsHash = hashRemainingAccounts(effectiveRemaining);

  return sha256(
    Buffer.concat([
      USER_INTENT_DOMAIN,
      pubkey32(params.group),
      pubkey32(params.mangoAccount),
      pubkey32(params.userOwner),
      Buffer.from([params.kind]),
      payloadHash,
      accountsHash,
    ]),
  );
}

function signUserIntentMessage(
  secretKey64: Uint8Array,
  userIntentMessage: Buffer,
): Buffer {
  return Buffer.from(nacl.sign.detached(userIntentMessage, secretKey64));
}
```

## Compatibility Note

The relayer currently accepts a fallback where the user signs the ASCII hex string of the 32-byte digest. Do not rely on that mode unless you have to. The recommended path is to sign the raw 32-byte `user_intent_message`.
