import { formatJson, textResult } from "../utils/formatting.js";
import { formatToolError } from "../utils/errors.js";
import {
  getDefaultWalletName,
  listConfiguredWallets,
} from "../utils/wallets.js";

export const listWalletsDefinition = {
  description:
    "Returns the wallets configured in `wallets.json` (name + address pairs) and which one is the current default. Use this when the user references a wallet by name ('my trading account') to confirm which 0x address it maps to, or to disambiguate before calling `aave_get_position` or `aave_list_positions`. If `wallets.json` is missing or empty, returns `count: 0` — in that case the server falls back to the AAVE_DEFAULT_WALLET environment variable.",
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    title: "List Configured Wallets",
  },
};

export async function listWalletsHandler() {
  try {
    const wallets = listConfiguredWallets();
    return textResult(
      formatJson({
        count: wallets.length,
        default: getDefaultWalletName() ?? null,
        wallets: wallets.map((w) => ({ name: w.name, address: w.address })),
      }),
    );
  } catch (e) {
    return textResult(formatToolError(e), true);
  }
}
