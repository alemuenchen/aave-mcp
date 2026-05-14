import type { Address, Chain } from "viem";
import * as viemChains from "viem/chains";
import * as AaveBook from "@bgd-labs/aave-address-book";

/**
 * AAVE v3 deployments supported by this server.
 *
 * The list is derived at module load time from
 * `@bgd-labs/aave-address-book` — the canonical, governance-maintained
 * registry of every AAVE deployment. To pick up a new chain after AAVE
 * deploys to it, run `npm update @bgd-labs/aave-address-book` and
 * restart the server. No manual addition required.
 *
 * What we filter OUT of the address book:
 *  - Testnets (Sepolia / Fuji / MegaEth, etc.).
 *  - Ethereum variants (`EtherFi`, `Horizon`, `Lido`): same chain id
 *    as `Ethereum` mainnet but different liquidity pools. Phase 1
 *    treats one deployment per chain; multi-instance support is a
 *    future enhancement.
 *  - Whitelabel partner deployments (`Ink`).
 */

// Names from @bgd-labs/aave-address-book that we explicitly skip.
// Suffix-matched (any name containing these tokens after "AaveV3").
const SKIP_NAME_TOKENS = [
  // Testnets we know about by name. Anything else missing here is
  // caught by the viem `chain.testnet === true` check below.
  "Sepolia",
  "Goerli",
  "Fuji",
  "MegaEth",
  // Ethereum-mainnet variants (different pool, same chain id).
  // Excluded in phase 1; the canonical `AaveV3Ethereum` is kept.
  "EtherFi",
  "Horizon",
  "Lido",
  // Whitelabel / partner deployments, not part of the core AAVE roster.
  "Whitelabel",
];

// Public RPC fallbacks per chain id, used when:
//  - the user did not set <CHAIN>_RPC_URL, AND
//  - viem's chain definition doesn't already carry a usable default.
// Best-effort, public endpoints (no API key) — fine for occasional reads.
const PUBLIC_RPC_FALLBACK: Record<number, string> = {
  1: "https://ethereum-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  56: "https://bsc-rpc.publicnode.com",
  100: "https://rpc.gnosischain.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  146: "https://rpc.soniclabs.com",
  324: "https://mainnet.era.zksync.io",
  1088: "https://andromeda.metis.io/?owner=1088",
  1868: "https://rpc.soneium.org",
  5000: "https://rpc.mantle.xyz",
  8453: "https://base-rpc.publicnode.com",
  9745: "https://rpc.plasma.to",
  42161: "https://arb1.arbitrum.io/rpc",
  42220: "https://forno.celo.org",
  43114: "https://avalanche-c-chain-rpc.publicnode.com",
  59144: "https://rpc.linea.build",
  534352: "https://rpc.scroll.io",
};

export interface ChainConfig {
  /** Lowercase identifier used by tools, e.g. "arbitrum", "ethereum". */
  key: string;
  /** Pretty name from the address book, e.g. "Arbitrum", "Ethereum". */
  name: string;
  /** viem Chain object (looked up from viem/chains or synthesized). */
  chain: Chain;
  /** Canonical AAVE v3 PoolAddressesProvider on this chain. */
  poolAddressesProvider: Address;
  /** Env var name for an optional custom RPC URL override. */
  rpcEnvVar: string;
  /** Public RPC fallback. `null` means: skip this chain unless the env override is set. */
  defaultRpc: string | null;
}

// Build the registry at module load.
function buildRegistry(): Record<string, ChainConfig> {
  const viemByChainId = new Map<number, Chain>();
  for (const c of Object.values(viemChains) as Chain[]) {
    if (c && typeof c === "object" && typeof c.id === "number") {
      viemByChainId.set(c.id, c);
    }
  }

  const registry: Record<string, ChainConfig> = {};

  for (const [exportName, deployment] of Object.entries(AaveBook)) {
    // Match the AaveV3<ChainName> pattern. Skip everything else
    // (libs, abis, helper structs).
    const match = /^AaveV3([A-Z][a-zA-Z]+)$/.exec(exportName);
    if (!match) continue;
    const chainName = match[1];

    // Token-based skip list (testnets, variants, whitelabel).
    if (SKIP_NAME_TOKENS.some((t) => chainName.includes(t))) continue;

    // Each AaveV3* export carries CHAIN_ID and POOL_ADDRESSES_PROVIDER.
    const d = deployment as { CHAIN_ID?: number; POOL_ADDRESSES_PROVIDER?: Address };
    if (typeof d.CHAIN_ID !== "number" || !d.POOL_ADDRESSES_PROVIDER) continue;

    // viem testnet flag is a stronger filter than name matching:
    // catches anything we missed in SKIP_NAME_TOKENS.
    const viemChain = viemByChainId.get(d.CHAIN_ID);
    if (viemChain && (viemChain as Chain & { testnet?: boolean }).testnet) continue;

    const key = chainName.toLowerCase();
    const rpcEnvVar = `${chainName.toUpperCase()}_RPC_URL`;

    // Determine default RPC priority:
    //   1. Our curated PUBLIC_RPC_FALLBACK (most reliable for AAVE chains).
    //   2. viem's chain.rpcUrls.default.http[0].
    //   3. null (= "no default, requires env override").
    const viemDefault = viemChain?.rpcUrls?.default?.http?.[0];
    const defaultRpc =
      PUBLIC_RPC_FALLBACK[d.CHAIN_ID] ?? viemDefault ?? null;

    // If viem doesn't know this chain, synthesize a minimal Chain object
    // (id + name + a stub rpcUrls; we never actually rely on this for
    // RPC selection — getRpcUrl() reads from rpcEnvVar / defaultRpc).
    const chain: Chain = viemChain ?? {
      id: d.CHAIN_ID,
      name: chainName,
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: defaultRpc ? [defaultRpc] : [] } },
    };

    registry[key] = {
      key,
      name: chainName,
      chain,
      poolAddressesProvider: d.POOL_ADDRESSES_PROVIDER,
      rpcEnvVar,
      defaultRpc,
    };
  }

  return registry;
}

export const CHAIN_CONFIG: Record<string, ChainConfig> = buildRegistry();

/** All supported chain keys (lowercase), derived from the address book. */
export const SUPPORTED_CHAINS: readonly string[] = Object.freeze(
  Object.keys(CHAIN_CONFIG).sort(),
);

/**
 * Loose alias kept for backwards compatibility with existing tool code.
 * The set of valid values is now dynamic (driven by the address book),
 * so we type it as `string` and rely on `isSupportedChain` /
 * Zod enum validation at runtime.
 */
export type SupportedChain = string;

export function isSupportedChain(s: string): s is SupportedChain {
  return s in CHAIN_CONFIG;
}

/** Default chain used when a tool is called without an explicit `chain`. */
export const DEFAULT_CHAIN: SupportedChain = "arbitrum";
