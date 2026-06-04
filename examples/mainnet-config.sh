#!/usr/bin/env bash
set -euo pipefail

export FERMI_DEPLOYMENT="${FERMI_DEPLOYMENT:-fermi-r6-mainnet}"

npm run config
