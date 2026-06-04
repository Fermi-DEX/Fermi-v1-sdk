#!/usr/bin/env bash
set -euo pipefail

export FERMI_DEPLOYMENT="${FERMI_DEPLOYMENT:-fermi-r6-mainnet}"
export FERMI_ACCOUNT_NUM="${FERMI_ACCOUNT_NUM:-0}"

: "${USER_KEYPAIR:?set USER_KEYPAIR to a mainnet wallet keypair JSON path}"
: "${USDC_AMOUNT_UI:?set USDC_AMOUNT_UI to the USDC amount to deposit}"

npm run deposit-usdc
