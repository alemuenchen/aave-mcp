import { z } from "zod";
import type { Address } from "viem";
import {
  BASE_CURRENCY_UNIT,
  getAaveAddresses,
  getClient,
} from "../rpc-client.js";
import { POOL_ABI } from "../abis.js";
import { formatJson, pct, textResult, usd } from "../utils/formatting.js";
import { formatToolError } from "../utils/errors.js";
import { resolveWallet } from "../utils/wallets.js";
import {
  CHAIN_CONFIG,
  SUPPORTED_CHAINS,
  type SupportedChain,
} from "../chains.js";

const UINT256_MAX = (1n << 256n) - 1n;

export const listPositionsDefinition = {
  description:
    "Scans every supported AAVE v3 chain in parallel and returns the wallet's account summary on each chain where it has activity (any collateral or debt). The chain set is derived from @bgd-labs/aave-address-book and updates automatically when AAVE governance approves new deployments. Useful as a one-shot 'show me all my AAVE positions across chains'. For each active chain returns total collateral, total debt, net equity, health factor and current LTV. Use `aave_get_position` afterwards for a per-asset breakdown of any specific chain. If `wallet` is omitted, falls back to wallets.json default or AAVE_DEFAULT_WALLET.",
  inputSchema: {
    wallet: z
      .string()
      .min(1)
      .max(42)
      .optional()
      .describe(
        "Either an Ethereum-style address (0x + 40 hex) or a name from wallets.json (e.g. 'trading'). Optional; falls back to the wallets.json default, or AAVE_DEFAULT_WALLET.",
      ),
  },
  annotations: {
    readOnlyHint: true,
    title: "List AAVE v3 Positions (all chains)",
  },
};

interface ChainResult {
  chain: SupportedChain;
  chainId: number;
  hasPosition: boolean;
  totalCollateralUSD: number;
  totalDebtUSD: number;
  netEquityUSD: number;
  healthFactor: number | null;
  currentLTV: number;
  error?: string;
}

async function fetchOnChain(
  chain: SupportedChain,
  wallet: Address,
): Promise<ChainResult> {
  const base: ChainResult = {
    chain,
    chainId: CHAIN_CONFIG[chain].chain.id,
    hasPosition: false,
    totalCollateralUSD: 0,
    totalDebtUSD: 0,
    netEquityUSD: 0,
    healthFactor: null,
    currentLTV: 0,
  };

  try {
    const client = getClient(chain);
    const { pool } = await getAaveAddresses(chain);

    const accountData = (await client.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: "getUserAccountData",
      args: [wallet],
    })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];

    const [
      totalCollateralBaseRaw,
      totalDebtBaseRaw,
      ,
      ,
      ,
      healthFactorRaw,
    ] = accountData;

    if (totalCollateralBaseRaw === 0n && totalDebtBaseRaw === 0n) {
      return base;
    }

    const totalCollateralUSD =
      Number(totalCollateralBaseRaw) / Number(BASE_CURRENCY_UNIT);
    const totalDebtUSD =
      Number(totalDebtBaseRaw) / Number(BASE_CURRENCY_UNIT);
    const netEquityUSD = totalCollateralUSD - totalDebtUSD;
    const currentLTV =
      totalCollateralUSD > 0 ? totalDebtUSD / totalCollateralUSD : 0;
    const healthFactor =
      totalDebtBaseRaw === 0n || healthFactorRaw === UINT256_MAX
        ? null
        : Number(healthFactorRaw) / 1e18;

    return {
      ...base,
      hasPosition: true,
      totalCollateralUSD: Number(totalCollateralUSD.toFixed(2)),
      totalDebtUSD: Number(totalDebtUSD.toFixed(2)),
      netEquityUSD: Number(netEquityUSD.toFixed(2)),
      healthFactor:
        healthFactor === null ? null : Number(healthFactor.toFixed(4)),
      currentLTV: Number(currentLTV.toFixed(6)),
    };
  } catch (e) {
    // Per-chain failures shouldn't break the whole listing — record and move on.
    return {
      ...base,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function listPositionsHandler(args: { wallet?: string }) {
  try {
    const wallet = resolveWallet(args.wallet) as Address;

    const results = await Promise.all(
      SUPPORTED_CHAINS.map((chain) => fetchOnChain(chain, wallet)),
    );

    const active = results.filter((r) => r.hasPosition);
    const failed = results.filter((r) => r.error);
    const empty = results
      .filter((r) => !r.hasPosition && !r.error)
      .map((r) => r.chain);

    const totalCollateralUSD = active.reduce(
      (s, r) => s + r.totalCollateralUSD,
      0,
    );
    const totalDebtUSD = active.reduce((s, r) => s + r.totalDebtUSD, 0);
    const totalNetEquityUSD = totalCollateralUSD - totalDebtUSD;
    const aggregatedLTV =
      totalCollateralUSD > 0 ? totalDebtUSD / totalCollateralUSD : 0;

    const output = {
      wallet,
      protocol: "aave-v3",
      source: "rpc",
      asOf: new Date().toISOString(),
      activeChains: active.map((r) => r.chain),
      emptyChains: empty,
      failedChains: failed.map((r) => ({ chain: r.chain, error: r.error })),
      aggregate: {
        totalCollateralUSD: Number(totalCollateralUSD.toFixed(2)),
        totalDebtUSD: Number(totalDebtUSD.toFixed(2)),
        netEquityUSD: Number(totalNetEquityUSD.toFixed(2)),
        currentLTV: Number(aggregatedLTV.toFixed(6)),
      },
      perChain: active.map((r) => ({
        chain: r.chain,
        chainId: r.chainId,
        totalCollateralUSD: r.totalCollateralUSD,
        totalDebtUSD: r.totalDebtUSD,
        netEquityUSD: r.netEquityUSD,
        healthFactor: r.healthFactor,
        currentLTV: r.currentLTV,
      })),
      humanReadable: {
        totalCollateral: usd(totalCollateralUSD),
        totalDebt: usd(totalDebtUSD),
        netEquity: usd(totalNetEquityUSD),
        aggregatedLTV: pct(aggregatedLTV),
        chainsWithPosition: active.length,
      },
    };

    return textResult(formatJson(output));
  } catch (e) {
    return textResult(formatToolError(e), true);
  }
}
