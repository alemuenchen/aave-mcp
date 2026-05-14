import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { POOL_ADDRESSES_PROVIDER_ABI } from "./abis.js";
import { CHAIN_CONFIG, type SupportedChain } from "./chains.js";

/**
 * AAVE v3 base currency on every chain we support is USD with 8 decimals.
 * (Same constant for all chains, hence top-level export.)
 */
export const BASE_CURRENCY_UNIT = 10n ** 8n;

function getRpcUrl(chain: SupportedChain): string {
  const cfg = CHAIN_CONFIG[chain];
  const fromEnv = process.env[cfg.rpcEnvVar];
  if (fromEnv) return fromEnv;
  if (cfg.defaultRpc) return cfg.defaultRpc;
  // No public fallback for this chain and no env override: fail fast with
  // an actionable message instead of letting viem try to call an empty URL.
  throw new Error(
    `No RPC URL configured for chain '${chain}'. Set the ${cfg.rpcEnvVar} ` +
      `environment variable (e.g. an Alchemy / Infura / QuickNode endpoint).`,
  );
}

const _clients: Partial<Record<SupportedChain, PublicClient>> = {};

export function getClient(chain: SupportedChain): PublicClient {
  if (!_clients[chain]) {
    _clients[chain] = createPublicClient({
      chain: CHAIN_CONFIG[chain].chain,
      transport: http(getRpcUrl(chain)),
      batch: { multicall: true },
    });
  }
  return _clients[chain]!;
}

interface AaveAddresses {
  pool: Address;
  dataProvider: Address;
  oracle: Address;
}

const _addresses: Partial<Record<SupportedChain, AaveAddresses>> = {};

/**
 * Resolve Pool, PoolDataProvider and PriceOracle addresses for the given
 * chain by reading them from the AddressesProvider. Cached in-process —
 * restart the server to pick up protocol upgrades.
 */
export async function getAaveAddresses(
  chain: SupportedChain,
): Promise<AaveAddresses> {
  const cached = _addresses[chain];
  if (cached) return cached;

  const client = getClient(chain);
  const provider = CHAIN_CONFIG[chain].poolAddressesProvider;

  const [pool, dataProvider, oracle] = await Promise.all([
    client.readContract({
      address: provider,
      abi: POOL_ADDRESSES_PROVIDER_ABI,
      functionName: "getPool",
    }),
    client.readContract({
      address: provider,
      abi: POOL_ADDRESSES_PROVIDER_ABI,
      functionName: "getPoolDataProvider",
    }),
    client.readContract({
      address: provider,
      abi: POOL_ADDRESSES_PROVIDER_ABI,
      functionName: "getPriceOracle",
    }),
  ]);

  const addrs: AaveAddresses = { pool, dataProvider, oracle };
  _addresses[chain] = addrs;
  return addrs;
}

export function getDefaultWallet(): string | undefined {
  return process.env.AAVE_DEFAULT_WALLET?.toLowerCase();
}
