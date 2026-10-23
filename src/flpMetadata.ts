/** Harness metadata preserves native integers as decimal strings and unknown values as null. */
export type FlpMetadataSnapshot = {
  schema_version: 1;
  generated_ts_ms: number;
  vault: string;
  owner: string | null;
  user_account_exists: boolean | null;
  source: Record<string, unknown>;
  data: {
    shares?: { pricingSupply: string; [key: string]: unknown };
    user?: Record<string, unknown> | null;
    portfolio?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
