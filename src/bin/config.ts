#!/usr/bin/env node

import 'dotenv/config';
import { ContinuumHarnessClient } from '../harness';
import { apiKeyFromEnv, gatewayUrlFromEnv } from './env';

async function main(): Promise<void> {
  const harness = new ContinuumHarnessClient({
    gatewayUrl: gatewayUrlFromEnv(),
    apiKey: apiKeyFromEnv(),
  });
  const config = process.env.CONFIG_SOURCE === 'bootstrap'
    ? await harness.getBootstrap()
    : await harness.getConfig();
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err?.body || err?.message || err);
  process.exit(1);
});
