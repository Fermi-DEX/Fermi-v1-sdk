import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

/**
 * SPL Memo v2 program ID. The relayer scans for a memo instruction carrying
 * `fee_credit:v1:<user_owner>:<mango_account>` to attribute the deposit.
 */
export const MEMO_PROGRAM_ID = new PublicKey(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
);

export type FeeQuote = {
  market_index: number;
  quoted_fee_lamports: number;
  service_base_lamports: number;
  chain_cost_lamports: number;
  queue_pressure_multiplier_bps: number;
  bg_pressure_multiplier_bps: number;
  applied_multiplier_bps: number;
  queue_count: number;
  queue_soft_limit: number;
  queue_gap_span: number;
  queue_head_available: boolean;
  bg_submit_inflight: number;
  bg_submit_capacity: number;
  normal_max_fee_lamports: number;
  emergency_max_fee_lamports: number;
  relayer_prioritization_fee_micro_lamports: number;
  executor_prioritization_fee_micro_lamports: number;
  warning?: string | null;
};

export type FeeAccount = {
  mango_account: string;
  user_owner: string;
  created_at_ms: number;
  updated_at_ms: number;
  sponsored_seed_total_lamports: number;
  sponsored_seed_remaining_lamports: number;
  paid_credit_total_lamports: number;
  paid_credit_remaining_lamports: number;
  reserved_lamports: number;
  debited_lamports_total: number;
  available_balance_lamports: number;
  daily_quota_limit: number | null;
  daily_quota_used: number;
  daily_quota_window_start_ms: number;
  last_debit_at_ms: number | null;
  last_credit_at_ms: number | null;
  status: 'active' | 'frozen' | string;
};

export type FeeDepositContext = {
  deposit_address: string;
  memo: string;
  crediting_path: string;
  enforcement_mode: string;
};

export type FeeLedgerEntry = {
  id: string;
  mango_account: string;
  user_owner: string;
  entry_type: string;
  amount_lamports: number;
  balance_after_lamports: number;
  reference_type: string;
  reference_id: string;
  metadata_json: Record<string, unknown>;
  created_at_ms: number;
};

export type FeeStatus = {
  ok: boolean;
  user_owner: string;
  mango_account: string;
  enforcement_mode: string;
  fee_account: FeeAccount;
  quote: FeeQuote;
  deposit: FeeDepositContext;
  recent_entries: FeeLedgerEntry[];
};

export type FeeDepositReport = {
  source_chain: string;
  source_tx_signature: string;
  instruction_index: number;
  user_owner: string;
  mango_account: string;
  amount_lamports: number | string;
  deposit_address: string;
  memo: string;
  observed_at_ms?: number;
};

export type FeeDepositReportResponse = {
  ok: boolean;
  duplicate: boolean;
  deposit_credit_hash: string;
  fee_account: FeeAccount;
  recent_entries: FeeLedgerEntry[];
};

export type FeeStatusQuery = {
  userOwner: PublicKey | string;
  mangoAccount: PublicKey | string;
  market?: number;
  group?: PublicKey | string;
  executionQueue?: PublicKey | string;
};

function pubkeyStr(value: PublicKey | string): string {
  return typeof value === 'string' ? value : value.toBase58();
}

/**
 * Build the canonical memo string the relayer expects inside the deposit tx
 * so it can attribute the transferred SOL to the right (owner, mango_account)
 * fee account: `fee_credit:v1:<user_owner>:<mango_account>`.
 */
export function buildFeeDepositMemo(
  userOwner: PublicKey | string,
  mangoAccount: PublicKey | string,
): string {
  return `fee_credit:v1:${pubkeyStr(userOwner)}:${pubkeyStr(mangoAccount)}`;
}

function memoInstruction(memo: string): TransactionInstruction {
  return new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo, 'utf-8'),
  });
}

export type BuildFeeDepositInstructionsInput = {
  payer: PublicKey;
  userOwner: PublicKey | string;
  mangoAccount: PublicKey | string;
  depositAddress: PublicKey | string;
  lamports: number | bigint;
};

export type FeeDepositInstructions = {
  instructions: TransactionInstruction[];
  memo: string;
  /** Index of the SystemProgram.transfer ix inside `instructions` (always 1). */
  transferInstructionIndex: number;
};

/**
 * Build the two instructions the deposit tx must contain: a Memo v2 ix carrying
 * the attribution string, followed by a SystemProgram.transfer from the payer
 * to the relayer's fee-deposit address. The relayer's `/fees-deposited`
 * endpoint requires `instruction_index` — that is `transferInstructionIndex`
 * returned here.
 */
export function buildFeeDepositInstructions(
  input: BuildFeeDepositInstructionsInput,
): FeeDepositInstructions {
  const lamports =
    typeof input.lamports === 'bigint' ? Number(input.lamports) : input.lamports;
  if (!Number.isFinite(lamports) || lamports <= 0) {
    throw new Error(`fee deposit lamports must be a positive number (got ${lamports})`);
  }
  const depositAddress =
    typeof input.depositAddress === 'string'
      ? new PublicKey(input.depositAddress)
      : input.depositAddress;
  const memo = buildFeeDepositMemo(input.userOwner, input.mangoAccount);
  const instructions: TransactionInstruction[] = [
    memoInstruction(memo),
    SystemProgram.transfer({
      fromPubkey: input.payer,
      toPubkey: depositAddress,
      lamports,
    }),
  ];
  return { instructions, memo, transferInstructionIndex: 1 };
}

export class ContinuumFeeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!baseUrl) {
      throw new Error('ContinuumFeeClient: baseUrl is required');
    }
  }

  private url(path: string): string {
    const trimmed = this.baseUrl.endsWith('/')
      ? this.baseUrl.slice(0, -1)
      : this.baseUrl;
    return `${trimmed}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /** GET /fees/status — returns wallet fee balance, current quote, and deposit wiring. */
  async getStatus(query: FeeStatusQuery): Promise<FeeStatus> {
    const params = new URLSearchParams();
    params.set('user_owner', pubkeyStr(query.userOwner));
    params.set('mango_account', pubkeyStr(query.mangoAccount));
    if (query.market !== undefined) params.set('market', String(query.market));
    if (query.group) params.set('group', pubkeyStr(query.group));
    if (query.executionQueue) {
      params.set('execution_queue', pubkeyStr(query.executionQueue));
    }
    const resp = await this.fetchImpl(
      `${this.url('/fees/status')}?${params.toString()}`,
    );
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`fees/status failed: HTTP ${resp.status} ${body}`);
    }
    return (await resp.json()) as FeeStatus;
  }

  /**
   * POST /fees-deposited — tell the relayer about a completed deposit tx so it
   * credits the wallet's fee balance. Idempotent on `source_tx_signature`. If
   * the relayer was started with `CTM_FEE_ADMIN_TOKEN`, callers must supply
   * `adminToken` for the Authorization header.
   */
  async reportDeposit(
    request: FeeDepositReport,
    adminToken?: string,
  ): Promise<FeeDepositReportResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (adminToken) headers['Authorization'] = adminToken;
    const body: Record<string, unknown> = {
      ...request,
      amount_lamports:
        typeof request.amount_lamports === 'bigint'
          ? String(request.amount_lamports)
          : request.amount_lamports,
    };
    const resp = await this.fetchImpl(this.url('/fees-deposited'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`fees-deposited failed: HTTP ${resp.status} ${text}`);
    }
    return (await resp.json()) as FeeDepositReportResponse;
  }
}

export type DepositFeeCreditInput = {
  connection: Connection;
  payer: Keypair;
  userOwner: PublicKey | string;
  mangoAccount: PublicKey | string;
  lamports: number | bigint;
  /**
   * If omitted, the SDK calls `feeClient.getStatus` first to discover the
   * relayer's current deposit address. Supply it to skip the preflight.
   */
  depositAddress?: PublicKey | string;
  feeClient: ContinuumFeeClient;
  /** `solana` cluster label reported to the relayer (default `solana-devnet`). */
  sourceChain?: string;
  /** Header value for `Authorization` if the relayer enforces admin auth. */
  adminToken?: string;
  /** Additional signers (defaults to just `payer`). */
  additionalSigners?: Keypair[];
};

/**
 * One-shot: discover deposit address (if needed), build + sign + send the
 * memo+transfer tx, then POST `/fees-deposited` so the relayer credits the
 * wallet. Returns the updated fee-account snapshot.
 */
export async function depositFeeCredit(
  input: DepositFeeCreditInput,
): Promise<FeeDepositReportResponse> {
  let depositAddress = input.depositAddress;
  if (!depositAddress) {
    const status = await input.feeClient.getStatus({
      userOwner: input.userOwner,
      mangoAccount: input.mangoAccount,
    });
    depositAddress = status.deposit.deposit_address;
  }

  const { instructions, memo, transferInstructionIndex } =
    buildFeeDepositInstructions({
      payer: input.payer.publicKey,
      userOwner: input.userOwner,
      mangoAccount: input.mangoAccount,
      depositAddress,
      lamports: input.lamports,
    });

  const tx = new Transaction().add(...instructions);
  const signers = [input.payer, ...(input.additionalSigners ?? [])];
  const signature = await sendAndConfirmTransaction(
    input.connection,
    tx,
    signers,
    { commitment: 'confirmed' },
  );

  const amountLamports =
    typeof input.lamports === 'bigint' ? Number(input.lamports) : input.lamports;
  return input.feeClient.reportDeposit(
    {
      source_chain: input.sourceChain ?? 'solana-devnet',
      source_tx_signature: signature,
      instruction_index: transferInstructionIndex,
      user_owner: pubkeyStr(input.userOwner),
      mango_account: pubkeyStr(input.mangoAccount),
      amount_lamports: amountLamports,
      deposit_address: pubkeyStr(depositAddress),
      memo,
      observed_at_ms: Date.now(),
    },
    input.adminToken,
  );
}
