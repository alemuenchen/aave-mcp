#!/usr/bin/env bash
# Wrapper for aave-mcp: loads configuration from a sibling .env file
# (MCP/aave-mcp/.env) instead of stuffing it into claude_desktop_config.json.
#
# No credentials are required: public RPCs for all supported chains
# (derived dynamically from @bgd-labs/aave-address-book — 17 mainnets
# at time of writing) work without API keys, subject to rate limits.
#
# The .env file is for optional overrides:
#   AAVE_DEFAULT_WALLET     legacy single-wallet default; prefer wallets.json
#   AAVE_WALLETS_FILE       path override for wallets.json
#   <CHAIN>_RPC_URL         per-chain custom RPC, e.g. ETHEREUM_RPC_URL,
#                           ARBITRUM_RPC_URL, BASE_RPC_URL, ZKSYNC_RPC_URL, …
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HERE/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

exec /usr/bin/env node "$HERE/dist/index.js"
