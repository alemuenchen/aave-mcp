# aave-mcp

An MCP (Model Context Protocol) server that monitors **AAVE v3 positions across every chain where the protocol is live**, by reading the protocol contracts directly over each chain's RPC. No API key, no subgraph, no signup.

It gives Claude (Desktop / Code / Cowork / any MCP-compatible client) read-only access to:

- All your AAVE v3 positions, on all chains, at once.
- Per-asset breakdowns (collateral, debt, APYs, health factor, eMode, isolation).
- Current reserve rates and risk parameters, asset-by-asset.
- The wallets you've configured by name.

The chain list is **derived dynamically** from [`@bgd-labs/aave-address-book`](https://github.com/bgd-labs/aave-address-book) — the canonical, governance-maintained registry of every AAVE deployment. When AAVE governance approves a new L2, you pick it up with a single `npm update`. No code change required.

> **Unofficial.** This project is not affiliated with, endorsed by, or sponsored by Avara Limited or Aave. *Aave* is a registered trademark of Avara Limited.

## What's supported

At time of writing, 17 mainnets are auto-discovered: Arbitrum, Avalanche, Base, BNB, Celo, Ethereum, Gnosis, Linea, Mantle, Metis, Optimism, Plasma, Polygon, Scroll, Soneium, Sonic, zkSync. Run `aave_list_positions` once with no arguments and you'll see the full list materialise.

Testnets, white-label deployments and Ethereum sub-markets (Lido, EtherFi, Horizon) are filtered out by design — phase 1 treats one deployment per chain.

## Tools

The four AAVE tools are strictly read-only (`readOnlyHint: true`) — they never sign or submit a transaction. One helper tool (`aave_manage_wallets`) writes to the local `wallets.json` config file only; it does not touch the chain.

| Tool | Read-only | Purpose |
|---|:-:|---|
| `aave_get_position` | ✓ | Full AAVE v3 position of a wallet on one chain. Totals (collateral, debt, HF, LTV, liquidation margin, eMode, annualised carry) plus per-asset breakdown. |
| `aave_get_reserve_rates` | ✓ | Current rates and pool stats for the chain's reserves. No wallet required. Use for cross-asset comparisons. |
| `aave_list_positions` | ✓ | Scans every supported chain in parallel and returns active chains, empty chains, failed chains, plus an aggregate. One-shot "show me everything". |
| `aave_list_wallets` | ✓ | Lists the wallets configured in `wallets.json` (name → address) and which one is the current default. |
| `aave_manage_wallets` | local write | Atomically apply a batch of wallet config operations (`add`, `remove`, `setDefault`) in a single tool call. All ops in the batch run in the given order against one read-modify-write of `wallets.json`. If any op fails, the whole batch is rejected and the file is left untouched. |

## Installation

```bash
git clone https://github.com/alemuenchen/aave-mcp.git
cd aave-mcp
npm install
npm run build
```

## Configuration

### Wallets

The server tracks the wallets you care about in a local `wallets.json` file. You never need to edit it by hand — the `aave_manage_wallets` tool manages it for you — but the file is plain JSON and remains fully human-editable if you prefer.

#### Adding a wallet (conversational)

After installing the server, just say something like:

> *"Add my main wallet `0xAaaa…` and call it 'trading'."*

Claude calls `aave_manage_wallets({ operations: [{ type: "add", name: "trading", address: "0xAaaa…" }] })`. The new entry becomes the `default` **if and only if**: (a) you explicitly pass `makeDefault: true` (e.g. *"…and make it the default"*), or (b) `wallets.json` had no entries at the moment of the add (so the natural default is the only entry that exists). In every other case the existing `default` is left untouched.

You can also batch multiple changes into a single atomic call:

> *"Register my two wallets: 'trading' is `0xAaaa…`, 'cold' is `0xBbbb…`, and make 'cold' the default."*

→ `aave_manage_wallets({ operations: [{ type: "add", name: "trading", address: "0xAaaa…" }, { type: "add", name: "cold", address: "0xBbbb…", makeDefault: true }] })`. The batch is applied in order against a single read-modify-write of `wallets.json` — guaranteed atomic, no race even if other tool calls land back-to-back.

#### Listing the wallets you have

> *"Which wallets do you know about?"*

→ `aave_list_wallets` returns the current `wallets.json` contents (names + addresses) and the current `default`.

#### Removing a wallet

> *"Remove the wallet called 'trading'."*

→ `aave_manage_wallets({ operations: [{ type: "remove", name: "trading" }] })`. The entry is dropped. If the removed wallet was the current default, the `default` field is also cleared so it doesn't dangle.

#### Changing the default

> *"From now on, treat 'cold' as my default wallet."*

→ `aave_manage_wallets({ operations: [{ type: "setDefault", name: "cold" }] })`. The entry must already exist; otherwise the call is rejected and nothing changes.

#### Referring to wallets in tool calls

`aave_get_position` and `aave_list_positions` accept the `wallet` argument as either:

- a raw `0x…` address, or
- a name from `wallets.json` (e.g. `"trading"`).

If you omit `wallet`, the server falls back, in order:

1. The `default` entry in `wallets.json`, if set.
2. The `AAVE_DEFAULT_WALLET` env var (legacy single-wallet setups).
3. A clear error message listing the configured names.

#### Where the file lives

By default `wallets.json` sits next to `package.json` in the project root. To put it elsewhere, set `AAVE_WALLETS_FILE=/absolute/path/to/wallets.json` in the environment.

#### Manual file format

If you'd rather hand-edit:

```jsonc
{
  "wallets": [
    { "name": "trading",   "address": "0xAaaa…" },
    { "name": "long-term", "address": "0xBbbb…" }
  ],
  "default": "trading"
}
```

The server picks up changes on the next call (5-second in-memory cache).

#### Single-wallet legacy setup

If you only have one wallet, you can skip `wallets.json` entirely and set `AAVE_DEFAULT_WALLET=0x…` in your `.env`. This was the original setup pattern and still works.

### RPC endpoints

The server ships with sensible public defaults for all supported chains (publicnode.com / chain-native endpoints). They work without API keys but rate-limit under heavier use. For sustained use point them at your own Alchemy / Infura / QuickNode / drpc endpoints with per-chain env vars:

```bash
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/<key>
ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/<key>
# … and so on. Pattern is <CHAIN>_RPC_URL where <CHAIN> is the chain key in uppercase.
```

See `.env.example` for the full list.

## Claude Desktop / Cowork configuration

```json
{
  "mcpServers": {
    "aave": {
      "command": "node",
      "args": ["/absolute/path/to/aave-mcp/dist/index.js"],
      "env": {
        "ETHEREUM_RPC_URL": "https://eth-mainnet.g.alchemy.com/v2/<key>"
      }
    }
  }
}
```

Place `wallets.json` next to `package.json` in the project root, or point `AAVE_WALLETS_FILE` at it. Restart Claude Desktop and the `aave_*` tools will become available.

## Test with MCP Inspector

```bash
npm run inspect
```

This launches the official MCP Inspector against the built server so you can list and call tools interactively. `wallets.json` and any `<CHAIN>_RPC_URL` env vars are picked up automatically.

## Notes & limits

- **Auto-updating chain list**: `npm update @bgd-labs/aave-address-book` after every AAVE governance vote that approves a new deployment. No code change needed.
- **No on-chain writes, ever**: the four AAVE tools (`aave_get_position`, `aave_get_reserve_rates`, `aave_list_positions`, `aave_list_wallets`) only read from public contracts. They never sign or submit a transaction. The single wallet-management tool (`aave_manage_wallets`) writes only to the local `wallets.json` config file — it cannot move funds and has no access to private keys.
- **Atomic batches**: `aave_manage_wallets` accepts a list of operations and applies them in order against a single read-modify-write cycle. If any operation in the batch fails validation or pre-conditions, the whole batch is rejected and the file is left untouched. There is no path through which two competing tool calls can interleave on `wallets.json` mid-write.
- **Health factor**: returned as a number (e.g. `1.85`). When debt is zero, AAVE returns `2^256 - 1`; we surface `null` to make "no debt, no liquidation risk" unambiguous.
- **Per-chain failures don't abort `aave_list_positions`**: chains that error (rate-limited public RPC, transient network issue) are reported under `failedChains` rather than throwing.
- **Base currency**: AAVE v3 normalises USD with 8 decimals on every chain. The server converts to plain USD floats — sufficient for analysis, not for accounting.
- **`wallets.json` multi-process edits**: within a single server process, wallet writes are atomic (single tmp-file + rename, single synchronous read-modify-write per batch). If you point two server instances at the same `wallets.json` via `AAVE_WALLETS_FILE`, concurrent writes from different processes can race. Run one instance against any given file.

## Trademark and ToS

*Aave* is a registered trademark of Avara Limited. This project is independent and unofficial; it does not use AAVE's logos or branding, and the repository name is a descriptive reference to the public protocol API (nominative use).

Your interaction with the AAVE protocol via this server is your responsibility and subject to whatever terms apply to the public RPC endpoints and the AAVE protocol smart contracts. This is read-only software with no fund custody and no transaction-signing capability.

## License

MIT — see `LICENSE`.
