import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { AccountMeta, PublicKey } from '@solana/web3.js';
import path from 'path';
import {
  API_KEY_HEADER,
  RateLimitedError,
  requireApiKey,
} from './auth';

export type RelayerAccountMeta = {
  pubkey: string;
  is_signer: boolean;
  is_writable: boolean;
};

export type SubmitIntentRequest = {
  group: string;
  execution_queue: string;
  market: string;
  payload: Uint8Array;
  remaining_accounts: RelayerAccountMeta[];
  min_execute_slot?: string;
  expires_at_slot?: string;
  user_owner: string;
  mango_account: string;
  user_signature: Uint8Array;
  base_fee?: string;
  max_fee_lamports?: string;
  intent_version?: number;
  target_kind?: number;
  target_index?: number;
  client_order_id?: string;
};

export type SubmitIntentResponse = {
  sequence: string;
  tx_signature: string;
  user_intent_message: Buffer;
  ctm_envelope_message: Buffer;
  accepted_latency_ms?: number;
  optimistic_processed_latency_ms?: number;
  resolved_intent_version?: number;
  resolved_target_kind?: number;
  resolved_target_index?: number;
  resolved_accounts_hash?: string;
};

type RelayerGrpcClient = {
  submitIntent(
    request: SubmitIntentRequest,
    callback: (err: Error | null, response: SubmitIntentResponse) => void,
  ): void;
  close(): void;
};

type LoadedProto = {
  ctmsequencer: {
    CtmSequencerRelayer: new (
      addr: string,
      creds: grpc.ChannelCredentials,
    ) => RelayerGrpcClient;
  };
};

function loadRelayerProto(protoPath: string): LoadedProto {
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(packageDefinition) as unknown as LoadedProto;
}

export function defaultRelayerProtoPath(): string {
  return path.resolve(__dirname, '../proto/ctm_sequencer.proto');
}

export function toRelayerAccountMeta(account: AccountMeta): RelayerAccountMeta {
  return {
    pubkey: account.pubkey.toBase58(),
    is_signer: !!account.isSigner,
    is_writable: !!account.isWritable,
  };
}

export type ContinuumRelayerClientOptions = {
  /** Continuum proxy gRPC address, e.g. `gateway.fermi.xyz:50052`. */
  gatewayGrpcAddr: string;
  /** UUID API key — attached as `x-api-key` metadata on every RPC. Required. */
  apiKey: string;
  protoPath?: string;
  /**
   * Channel credentials. Defaults to TLS; pass
   * `grpc.credentials.createInsecure()` for local dev against an unencrypted
   * proxy. API key metadata is attached on top via call credentials.
   */
  credentials?: grpc.ChannelCredentials;
};

function apiKeyCallCredentials(apiKey: string): grpc.CallCredentials {
  return grpc.credentials.createFromMetadataGenerator((_params, callback) => {
    const metadata = new grpc.Metadata();
    metadata.set(API_KEY_HEADER, apiKey);
    callback(null, metadata);
  });
}

export class ContinuumRelayerClient {
  private readonly client: RelayerGrpcClient;

  constructor(opts: ContinuumRelayerClientOptions) {
    if (!opts || !opts.gatewayGrpcAddr) {
      throw new Error('ContinuumRelayerClient: gatewayGrpcAddr is required');
    }
    const apiKey = requireApiKey(opts.apiKey, 'ContinuumRelayerClient');
    const proto = loadRelayerProto(opts.protoPath ?? defaultRelayerProtoPath());
    const channelCreds = opts.credentials ?? grpc.credentials.createSsl();
    const composed = grpc.credentials.combineChannelCredentials(
      channelCreds,
      apiKeyCallCredentials(apiKey),
    );
    this.client = new proto.ctmsequencer.CtmSequencerRelayer(
      opts.gatewayGrpcAddr,
      composed,
    );
  }

  async submitIntent(request: SubmitIntentRequest): Promise<SubmitIntentResponse> {
    return await new Promise<SubmitIntentResponse>((resolve, reject) => {
      this.client.submitIntent(request, (err, response) => {
        if (err) {
          // grpc-js exposes status code on Error.code; 8 = RESOURCE_EXHAUSTED
          const code = (err as Error & { code?: number }).code;
          if (code === grpc.status.RESOURCE_EXHAUSTED) {
            reject(
              new RateLimitedError(
                `gateway rate limit hit on SubmitIntent: ${err.message}`,
              ),
            );
            return;
          }
          reject(err);
          return;
        }
        resolve(response);
      });
    });
  }

  close(): void {
    this.client.close();
  }
}

export function publicKeyString(value: string | PublicKey): string {
  return value instanceof PublicKey ? value.toBase58() : value;
}
