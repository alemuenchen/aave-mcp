import { z } from "zod";
import type { Address } from "viem";
import { isAddress } from "viem";
import {
  BASE_CURRENCY_UNIT,
  getAaveAddresses,
  getClient,
} from "../rpc-client.js";
import { DATA_PROVIDER_ABI, ORACLE_ABI } from "../abis.js";
import {
  formatJson,
  fromUnits,
  rayRateToApy,
  textResult,
} from "../utils/formatting.js";
import { AaveRpcError, formatToolError } from "../utils/errors.js";
import {
  CHAIN_CONFIG,
  DEFAULT_CHAIN,
  SUPPORTED_CHAINS,
  type SupportedChain,
} from "../chains.js";

export const getReserveRatesDefinition = {
  description:
    "Returns current rates and pool stats for AAVE v3 reserves on a supported chain. The chain set is derived from @bgd-labs/aave-address-book and updates automatically when AAVE governance approves new deployments. Reads supply/borrow APYs, utilisation, total supplied/borrowed (USD), and risk parameters (LTV, liquidation threshold, reserve factor) directly from the AaveProtocolDataProvider — no wallet required. Use this for cross-asset comparisons, e.g. 'is it cheaper to borrow USDC or USDT?'. If `asset` is provided, returns just that reserve (matched by symbol or address); otherwise returns all active reserves on the chain.",
  inputSchema: {
    asset: z
      .string()
      .optional()
      .describe(
        "Optional asset filter: either a symbol like 'WETH' / 'USDC' (case-insensitive) or an address (0x + 40 hex). If omitted, returns all active reserves on the chain.",
      ),
    chain: z
      .enum(SUPPORTED_CHAINS as readonly [SupportedChain, ...SupportedChain[]])
      .optional()
      .describe(
        "AAVE v3 chain to query (e.g. arbitrum, ethereum, base, optimism, polygon, …). Full list derived dynamically from @bgd-labs/aave-address-book. Defaults to arbitrum.",
      ),
  },
  annotations: { readOnlyHint: true, title: "Get AAVE v3 Reserve Rates" },
};

export async function getReserveRatesHandler(args: {
  asset?: string;
  chain?: SupportedChain;
}) {
  try {
    const chain: SupportedChain = args.chain ?? DEFAULT_CHAIN;

    const client = getClient(chain);
    const { dataProvider, oracle } = await getAaveAddresses(chain);

    const reservesTokens = (await client.readContract({
      address: dataProvider,
      abi: DATA_PROVIDER_ABI,
      functionName: "getAllReservesTokens",
    })) as readonly { symbol: string; tokenAddress: Address }[];

    // Filter by asset if requested.
    let tokens: readonly { symbol: string; tokenAddress: Address }[] = reservesTokens;
    if (args.asset) {
      const filter = args.asset.trim();
      if (isAddress(filter)) {
        const lower = filter.toLowerCase();
        tokens = reservesTokens.filter(
          (t) => t.tokenAddress.toLowerCase() === lower,
        );
      } else {
        const upper = filter.toUpperCase();
        tokens = reservesTokens.filter(
          (t) => t.symbol.toUpperCase() === upper,
        );
      }
      if (tokens.length === 0) {
        const available = reservesTokens.map((t) => t.symbol).sort().join(", ");
        throw new AaveRpcError(
          `Asset '${args.asset}' not found on ${chain}. Available symbols: ${available}.`,
          "ASSET_NOT_FOUND",
        );
      }
    }

    const reserveAddresses = tokens.map((t) => t.tokenAddress);

    const [configs, rates, prices] = await Promise.all([
      Promise.all(
        reserveAddresses.map((asset) =>
          client.readContract({
            address: dataProvider,
            abi: DATA_PROVIDER_ABI,
            functionName: "getReserveConfigurationData",
            args: [asset],
          }),
        ),
      ),
      Promise.all(
        reserveAddresses.map((asset) =>
          client.readContract({
            address: dataProvider,
            abi: DATA_PROVIDER_ABI,
            functionName: "getReserveData",
            args: [asset],
          }),
        ),
      ),
      Promise.all(
        reserveAddresses.map((asset) =>
          client.readContract({
            address: oracle,
            abi: ORACLE_ABI,
            functionName: "getAssetPrice",
            args: [asset],
          }),
        ),
      ),
    ]);

    const reserves = [];

    for (let i = 0; i < tokens.length; i++) {
      const { symbol, tokenAddress } = tokens[i];
      const config = configs[i] as readonly [
        bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean,
      ];
      const rate = rates[i] as readonly [
        bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, number,
      ];
      const priceRaw = prices[i] as bigint;

      const decimals = Number(config[0]);
      const ltvBps = Number(config[1]);
      const liqThresholdBps = Number(config[2]);
      const reserveFactorBps = Number(config[4]);
      const borrowingEnabled = config[6];
      const isActive = config[8];
      const isFrozen = config[9];

      // Skip reserves the protocol has disabled.
      if (!isActive) continue;

      const totalAToken = rate[2];
      const totalStableDebt = rate[3];
      const totalVariableDebt = rate[4];
      const liquidityRate = rate[5];
      const variableBorrowRate = rate[6];
      const stableBorrowRate = rate[7];

      const priceUSD = Number(priceRaw) / Number(BASE_CURRENCY_UNIT);

      const totalSupplied = fromUnits(totalAToken, decimals);
      const totalVar = fromUnits(totalVariableDebt, decimals);
      const totalStb = fromUnits(totalStableDebt, decimals);
      const totalBorrowed = totalVar + totalStb;

      const totalSuppliedUSD = totalSupplied * priceUSD;
      const totalBorrowedUSD = totalBorrowed * priceUSD;

      // Utilisation = total borrowed / total supplied. Matches the formula
      // used by the AAVE interest rate strategy contract.
      const utilizationRate =
        totalSupplied > 0 ? totalBorrowed / totalSupplied : 0;

      reserves.push({
        symbol,
        address: tokenAddress,
        decimals,
        priceUSD: Number(priceUSD.toFixed(6)),
        supplyApy: Number(rayRateToApy(liquidityRate).toFixed(6)),
        variableBorrowApy: Number(rayRateToApy(variableBorrowRate).toFixed(6)),
        stableBorrowApy: Number(rayRateToApy(stableBorrowRate).toFixed(6)),
        utilizationRate: Number(utilizationRate.toFixed(6)),
        totalSuppliedUSD: Number(totalSuppliedUSD.toFixed(2)),
        totalBorrowedUSD: Number(totalBorrowedUSD.toFixed(2)),
        maxLTV: ltvBps / 10_000,
        liquidationThreshold: liqThresholdBps / 10_000,
        reserveFactor: reserveFactorBps / 10_000,
        borrowingEnabled,
        isFrozen,
      });
    }

    const output = {
      network: chain,
      chainId: CHAIN_CONFIG[chain].chain.id,
      protocol: "aave-v3",
      source: "rpc",
      asOf: new Date().toISOString(),
      count: reserves.length,
      reserves,
    };

    return textResult(formatJson(output));
  } catch (e) {
    return textResult(formatToolError(e), true);
  }
}
