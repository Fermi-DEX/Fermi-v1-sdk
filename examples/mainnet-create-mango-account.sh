#!/usr/bin/env bash
set -euo pipefail

export CONTINUUM_DEPLOYMENT="${CONTINUUM_DEPLOYMENT:-fermi-r6-mainnet}"
export MANGO_ACCOUNT_NUM="${MANGO_ACCOUNT_NUM:-0}"
export MANGO_ACCOUNT_NAME="${MANGO_ACCOUNT_NAME:-}"

: "${USER_KEYPAIR:?set USER_KEYPAIR to a mainnet wallet keypair JSON path}"

npm run create-mango-account
