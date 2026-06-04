#!/usr/bin/env bash
set -euo pipefail

export FERMI_DEPLOYMENT="${FERMI_DEPLOYMENT:-fermi-r6-mainnet}"
export FERMI_ACCOUNT_NUM="${FERMI_ACCOUNT_NUM:-0}"
export FERMI_ACCOUNT_NAME="${FERMI_ACCOUNT_NAME:-}"

: "${USER_KEYPAIR:?set USER_KEYPAIR to a mainnet wallet keypair JSON path}"

npm run create-fermi-account
