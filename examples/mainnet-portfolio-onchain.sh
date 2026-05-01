#!/usr/bin/env bash
set -euo pipefail

export CONTINUUM_DEPLOYMENT="${CONTINUUM_DEPLOYMENT:-fermi-r6-mainnet}"

: "${USER_KEYPAIR:?set USER_KEYPAIR to a mainnet wallet keypair JSON path}"
: "${MANGO_ACCOUNT_PK:?set MANGO_ACCOUNT_PK to the Mango account to inspect}"

npm run onchain-portfolio
