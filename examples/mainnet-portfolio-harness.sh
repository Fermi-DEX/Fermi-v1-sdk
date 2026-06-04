#!/usr/bin/env bash
set -euo pipefail

export FERMI_DEPLOYMENT="${FERMI_DEPLOYMENT:-fermi-r6-mainnet}"
export VIEW="${VIEW:-optimistic}"

: "${OWNER:?set OWNER to the wallet owner pubkey}"

npm run portfolio
