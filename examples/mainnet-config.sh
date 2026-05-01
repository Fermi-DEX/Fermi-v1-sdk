#!/usr/bin/env bash
set -euo pipefail

export CONTINUUM_DEPLOYMENT="${CONTINUUM_DEPLOYMENT:-fermi-r6-mainnet}"

npm run config
