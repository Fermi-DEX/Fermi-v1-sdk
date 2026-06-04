#!/usr/bin/env bash
set -euo pipefail

export FERMI_DEPLOYMENT="${FERMI_DEPLOYMENT:-fermi-r6-mainnet}"

: "${USER_KEYPAIR:?set USER_KEYPAIR to a mainnet wallet keypair JSON path}"
: "${FERMI_ACCOUNT_PK:?set FERMI_ACCOUNT_PK to the Fermi v1 account to inspect}"

npm run onchain-portfolio
