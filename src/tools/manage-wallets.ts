import { z } from "zod";
import { formatJson, textResult } from "../utils/formatting.js";
import { formatToolError } from "../utils/errors.js";
import {
  applyWalletOperations,
  getWalletsFilePath,
  type WalletOperation,
} from "../utils/wallets.js";

const operationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    name: z
      .string()
      .min(1)
      .max(40)
      .regex(
        /^[a-zA-Z0-9_-]+$/,
        "Names must be 1-40 chars, alphanumeric / _ / -.",
      ),
    address: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'Expected "0x" + 40 hex characters.'),
    makeDefault: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("remove"),
    name: z.string().min(1).max(40),
  }),
  z.object({
    type: z.literal("setDefault"),
    name: z.string().min(1).max(40),
  }),
]);

export const manageWalletsDefinition = {
  description:
    "Atomically apply a batch of wallet config operations to `wallets.json`. All operations in a single call run in the given order against one read-modify-write of the file — there is no risk of reordering, partial writes, or interleaving with concurrent calls. Use this whenever you need to mutate `wallets.json` (instead of asking the user to edit the file by hand). The three operation types are: `add` (add or replace a wallet under a name, optionally making it the default), `remove` (drop a wallet by name; if it was the default, the default is cleared), and `setDefault` (point the `default` at an existing wallet name). If any operation in the batch fails validation or pre-conditions, the whole batch is rejected and the file is left untouched. **This tool WRITES to the local filesystem** (the wallets config file) but never touches the chain.",
  inputSchema: {
    operations: z
      .array(operationSchema)
      .min(1)
      .describe(
        "Non-empty list of wallet operations to apply in order, atomically. Examples: [{\"type\":\"add\",\"name\":\"trading\",\"address\":\"0x…\"}] to register one wallet; [{\"type\":\"add\",\"name\":\"a\",\"address\":\"0x…\"},{\"type\":\"add\",\"name\":\"b\",\"address\":\"0x…\",\"makeDefault\":true}] to register two and make 'b' the default; [{\"type\":\"remove\",\"name\":\"old\"}] to forget a wallet; [{\"type\":\"setDefault\",\"name\":\"trading\"}] to change which wallet tools fall back to when `wallet` is omitted.",
      ),
  },
  annotations: {
    readOnlyHint: false,
    title: "Manage Local Wallets (atomic batch)",
  },
};

export async function manageWalletsHandler(args: {
  operations: WalletOperation[];
}) {
  try {
    const { applied, finalState } = applyWalletOperations(args.operations);
    return textResult(
      formatJson({
        ok: true,
        file: getWalletsFilePath(),
        applied: applied.map((a) => ({
          op: a.op,
          result: a.result,
        })),
        wallets: finalState.wallets,
        default: finalState.default ?? null,
      }),
    );
  } catch (e) {
    return textResult(formatToolError(e), true);
  }
}
