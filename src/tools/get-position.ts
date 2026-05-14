import { z } from "zod";
import type { Address } from "viem";
import {
  BASE_CURRENCY_UNIT,
  getAaveAddresses,
  getClient,
} from "../rpc-client.js";
import { DATA_PROVIDER_ABI, ORACLE_ABI, POOL_ABI } from "../abis.js";
import {
  formatJson,
  fromUnits,
  pct,
  rayRateToApy,
  textResult,
  usd,
} from "../utils/formatting.js";
import { formatToolError, tryRead } from "../utils/errors.js";
import { resolveWallet } from "../utils/wallets.js";
import {
  CHAIN_CONFIG,
  DEFAULT_CHAIN,
  SUPPORTED_CHAINS,
  type SupportedChain,
} from "../chains.js";

const UINT256_MAX = (1n << 256n) - 1n;

export const getPositionDefinition = {
  description:
    "Returns the full AAVE v3 position of a wallet on a supported chain. The chain set is derived from @bgd-labs/aave-address-book and updates automatically when AAVE governance approves new deployments. Defaults to arbitrum if `chain` is omitted. Reads totals (collateral, debt, net equity, health factor, current LTV, liquidation margin) directly from the Pool contract via getUserAccountData, plus a per-asset breakdown (collateral, debt, USD values, supply/borrow APYs, isolation mode, eMode category) from the AaveProtocolDataProvider. Also returns annualised carry (supply yield, borrow cost, net carry). If `wallet` is omitted, falls back to wallets.json default or AAVE_DEFAULT_WALLET.",
  inputSchema: {
    wallet: z
      .string()
      .min(1)
      .max(42)
      .optional()
      .describe(
        "Either an Ethereum-style address (0x + 40 hex) or a name from wallets.json (e.g. 'trading'). Optional; falls back to the wallets.json default, or AAVE_DEFAULT_WALLET.",
      ),
    chain: z
      .enum(SUPPORTED_CHAINS as readonly [SupportedChain, ...SupportedChain[]])
      .optional()
      .describe(
        "AAVE v3 chain to query (e.g. arbitrum, ethereum, base, optimism, polygon, …). Full list derived dynamically from @bgd-labs/aave-address-book. Defaults to arbitrum.",
      ),
  },
  annotations: { readOnlyHint: true, title: "Get AAVE v3 Position" },
};

export async function getPositionHandler(args: {
  wallet?: string;
  chain?: SupportedChain;
}) {
  try {
    const chain: SupportedChain = args.chain ?? DEFAULT_CHAIN;
    const wallet = resolveWallet(args.wallet) as Address;

    const client = getClient(chain);
    const { pool, dataProvider, oracle } = await getAaveAddresses(chain);

    // Step 1: authoritative totals (+ HF) from the Pool, full reserves list
    // from the data provider, and the user's eMode category. All in parallel.
    // getUserEMode is best-effort: not exposed on all AAVE v3 deployments.
    const [accountData, reservesTokens, userEModeRaw] = await Promise.all([
      client.readContract({
        address: pool,
        abi: POOL_ABI,
        functionName: "getUserAccountData",
        args: [wallet],
      }),
      client.readContract({
        address: dataProvider,
        abi: DATA_PROVIDER_ABI,
        functionName: "getAllReservesTokens",
      }),
      tryRead(
        client.readContract({
          address: pool,
          abi: POOL_ABI,
          functionName: "getUserEMode",
          args: [wallet],
        }),
      ),
    ]);

    const [
      totalCollateralBaseRaw,
      totalDebtBaseRaw,
      availableBorrowsBaseRaw,
      currentLiquidationThresholdBps,
      ltvBps,
      healthFactorRaw,
    ] = accountData as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];

    const tokens = reservesTokens as readonly {
      symbol: string;
      tokenAddress: Address;
    }[];
    const reserveAddresses = tokens.map((t) => t.tokenAddress);

    // Step 2: batch per-reserve calls. viem's `batch: { multicall: true }`
    // transparently groups these eth_calls into one multicall3 request.
    const [userReserves, configs, rates, prices, debtCeilings, eModeCategories] =
      await Promise.all([
        Promise.all(
          reserveAddresses.map((asset) =>
            client.readContract({
              address: dataProvider,
              abi: DATA_PROVIDER_ABI,
              functionName: "getUserReserveData",
              args: [asset, wallet],
            }),
          ),
        ),
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
        // Best-effort: getDebtCeiling and getReserveEModeCategory aren't
        // exposed on every AAVE v3 deployment (e.g. v3.2+ removed eMode
        // from the data provider). Reverts become null and isolation/eMode
        // simply fall back to "unknown" in the response.
        Promise.all(
          reserveAddresses.map((asset) =>
            tryRead(
              client.readContract({
                address: dataProvider,
                abi: DATA_PROVIDER_ABI,
                functionName: "getDebtCeiling",
                args: [asset],
              }),
            ),
          ),
        ),
        Promise.all(
          reserveAddresses.map((asset) =>
            tryRead(
              client.readContract({
                address: dataProvider,
                abi: DATA_PROVIDER_ABI,
                functionName: "getReserveEModeCategory",
                args: [asset],
              }),
            ),
          ),
        ),
      ]);

    type Row = {
      symbol: string;
      address: Address;
      decimals: number;
      collateral: number;
      collateralUSD: number;
      isCollateralEnabled: boolean;
      isIsolated: boolean | null;
      eModeCategoryId: number | null;
      liquidationThreshold: number;
      variableDebt: number;
      stableDebt: number;
      debtUSD: number;
      priceUSD: number;
      supplyApy: number;
      variableBorrowApy: number;
      stableBorrowApy: number;
    };

    const rows: Row[] = [];
    let weightedSupplyApyUSD = 0;
    let weightedBorrowApyUSD = 0;
    let totalCollateralForApyUSD = 0;
    let totalDebtForApyUSD = 0;

    for (let i = 0; i < tokens.length; i++) {
      const { symbol, tokenAddress } = tokens[i];
      const userRes = userReserves[i] as readonly [
        bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean,
      ];
      const config = configs[i] as readonly [
        bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean,
      ];
      const rate = rates[i] as readonly [
        bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, number,
      ];
      const priceRaw = prices[i] as bigint;
      const debtCeilingRaw = debtCeilings[i] as bigint | null;
      const eModeCategoryRaw = eModeCategories[i] as bigint | null;
      const eModeCategoryId =
        eModeCategoryRaw === null ? null : Number(eModeCategoryRaw);

      const currentATokenBalance = userRes[0];
      const currentStableDebt = userRes[1];
      const currentVariableDebt = userRes[2];
      const usageAsCollateralEnabledOnUser = userRes[8];

      // Skip reserves the user has not touched.
      if (
        currentATokenBalance === 0n &&
        currentStableDebt === 0n &&
        currentVariableDebt === 0n
      ) {
        continue;
      }

      const decimals = Number(config[0]);
      const liquidationThresholdBps = Number(config[2]);
      const liquidationThreshold = liquidationThresholdBps / 10_000;
      const reserveUsageAsCollateralEnabled = config[5];

      const liquidityRate = rate[5];
      const variableBorrowRate = rate[6];
      const stableBorrowRate = rate[7];

      const priceUSD = Number(priceRaw) / Number(BASE_CURRENCY_UNIT);

      const collateral = fromUnits(currentATokenBalance, decimals);
      const variableDebt = fromUnits(currentVariableDebt, decimals);
      const stableDebt = fromUnits(currentStableDebt, decimals);

      const collateralUSD = collateral * priceUSD;
      const debtUSD = (variableDebt + stableDebt) * priceUSD;

      const supplyApy = rayRateToApy(liquidityRate);
      const variableBorrowApy = rayRateToApy(variableBorrowRate);
      const stableBorrowApy = rayRateToApy(stableBorrowRate);

      const isCollateralEnabled =
        usageAsCollateralEnabledOnUser &&
        reserveUsageAsCollateralEnabled &&
        collateralUSD > 0;

      const isIsolated = debtCeilingRaw === null ? null : debtCeilingRaw > 0n;

      if (isCollateralEnabled) {
        totalCollateralForApyUSD += collateralUSD;
        weightedSupplyApyUSD += collateralUSD * supplyApy;
      }
      if (debtUSD > 0) {
        const varUSD = variableDebt * priceUSD;
        const stbUSD = stableDebt * priceUSD;
        totalDebtForApyUSD += debtUSD;
        weightedBorrowApyUSD +=
          varUSD * variableBorrowApy + stbUSD * stableBorrowApy;
      }

      rows.push({
        symbol,
        address: tokenAddress,
        decimals,
        collateral,
        collateralUSD,
        isCollateralEnabled,
        isIsolated,
        eModeCategoryId,
        liquidationThreshold,
        variableDebt,
        stableDebt,
        debtUSD,
        priceUSD,
        supplyApy,
        variableBorrowApy,
        stableBorrowApy,
      });
    }

    // Authoritative totals from the Pool itself (computed on-chain).
    const totalCollateralUSD =
      Number(totalCollateralBaseRaw) / Number(BASE_CURRENCY_UNIT);
    const totalDebtUSD = Number(totalDebtBaseRaw) / Number(BASE_CURRENCY_UNIT);
    const availableBorrowsUSD =
      Number(availableBorrowsBaseRaw) / Number(BASE_CURRENCY_UNIT);
    const netEquityUSD = totalCollateralUSD - totalDebtUSD;

    const healthFactor =
      totalDebtBaseRaw === 0n || healthFactorRaw === UINT256_MAX
        ? null
        : Number(healthFactorRaw) / 1e18;

    const currentLiquidationThreshold =
      Number(currentLiquidationThresholdBps) / 10_000;
    const maxLTV = Number(ltvBps) / 10_000;

    // Real LTV of the position (debt / collateral). Different from maxLTV
    // (the weighted upper bound the protocol enforces).
    const currentLTV =
      totalCollateralUSD > 0 ? totalDebtUSD / totalCollateralUSD : 0;

    // Distance from liquidation: collateral can drop by this fraction
    // (assuming a uniform drawdown across assets) before HF hits 1.
    // Derivation: HF = collateral × liqThreshold / debt; liquidation when
    // HF=1, so the relative drop is 1 − 1/HF.
    const liquidationPriceMargin =
      healthFactor !== null && healthFactor > 0 ? 1 - 1 / healthFactor : null;

    // Weighted APYs (the Pool doesn't expose these).
    const avgSupplyApy =
      totalCollateralForApyUSD > 0
        ? weightedSupplyApyUSD / totalCollateralForApyUSD
        : 0;
    const avgBorrowApy =
      totalDebtForApyUSD > 0
        ? weightedBorrowApyUSD / totalDebtForApyUSD
        : 0;
    const netApy =
      netEquityUSD > 0
        ? (avgSupplyApy * totalCollateralUSD - avgBorrowApy * totalDebtUSD) /
          netEquityUSD
        : null;

    // Annualised carry. All numbers are USD/year. netCarryUSD < 0 means the
    // position is paying more on debt than it earns from collateral.
    const annualSupplyYieldUSD = totalCollateralUSD * avgSupplyApy;
    const annualBorrowCostUSD = totalDebtUSD * avgBorrowApy;
    const netCarryUSD = annualSupplyYieldUSD - annualBorrowCostUSD;

    const userEModeCategoryId =
      userEModeRaw === null ? null : Number(userEModeRaw as bigint);

    const output = {
      wallet,
      network: chain,
      chainId: CHAIN_CONFIG[chain].chain.id,
      protocol: "aave-v3",
      source: "rpc",
      totals: {
        totalCollateralUSD: Number(totalCollateralUSD.toFixed(2)),
        totalDebtUSD: Number(totalDebtUSD.toFixed(2)),
        availableBorrowsUSD: Number(availableBorrowsUSD.toFixed(2)),
        netEquityUSD: Number(netEquityUSD.toFixed(2)),
        healthFactor:
          healthFactor === null ? null : Number(healthFactor.toFixed(4)),
        currentLTV: Number(currentLTV.toFixed(6)),
        maxLTV,
        currentLiquidationThreshold,
        liquidationPriceMargin:
          liquidationPriceMargin === null
            ? null
            : Number(liquidationPriceMargin.toFixed(6)),
        avgSupplyApy: Number(avgSupplyApy.toFixed(6)),
        avgBorrowApy: Number(avgBorrowApy.toFixed(6)),
        netApy: netApy === null ? null : Number(netApy.toFixed(6)),
        annualSupplyYieldUSD: Number(annualSupplyYieldUSD.toFixed(2)),
        annualBorrowCostUSD: Number(annualBorrowCostUSD.toFixed(2)),
        netCarryUSD: Number(netCarryUSD.toFixed(2)),
        userEModeCategoryId,
      },
      reserves: rows.map((r) => ({
        symbol: r.symbol,
        address: r.address,
        decimals: r.decimals,
        priceUSD: Number(r.priceUSD.toFixed(6)),
        collateral: r.collateral,
        collateralUSD: Number(r.collateralUSD.toFixed(2)),
        isCollateralEnabled: r.isCollateralEnabled,
        isIsolated: r.isIsolated,
        eModeCategoryId: r.eModeCategoryId,
        liquidationThreshold: r.liquidationThreshold,
        variableDebt: r.variableDebt,
        stableDebt: r.stableDebt,
        debtUSD: Number(r.debtUSD.toFixed(2)),
        supplyApy: Number(r.supplyApy.toFixed(6)),
        variableBorrowApy: Number(r.variableBorrowApy.toFixed(6)),
        stableBorrowApy: Number(r.stableBorrowApy.toFixed(6)),
      })),
      humanReadable: {
        totalCollateral: usd(totalCollateralUSD),
        totalDebt: usd(totalDebtUSD),
        availableToBorrow: usd(availableBorrowsUSD),
        netEquity: usd(netEquityUSD),
        healthFactor:
          healthFactor === null ? "n/a (no debt)" : healthFactor.toFixed(4),
        currentLTV: pct(currentLTV),
        maxLTV: pct(maxLTV),
        currentLiquidationThreshold: pct(currentLiquidationThreshold),
        liquidationPriceMargin:
          liquidationPriceMargin === null
            ? "n/a (no debt)"
            : pct(liquidationPriceMargin),
        avgSupplyApy: pct(avgSupplyApy),
        avgBorrowApy: pct(avgBorrowApy),
        netApy: netApy === null ? "n/a" : pct(netApy),
        annualSupplyYield: usd(annualSupplyYieldUSD),
        annualBorrowCost: usd(annualBorrowCostUSD),
        netCarry: usd(netCarryUSD),
      },
    };

    return textResult(formatJson(output));
  } catch (e) {
    return textResult(formatToolError(e), true);
  }
}
