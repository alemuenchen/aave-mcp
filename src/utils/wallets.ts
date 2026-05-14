import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Wallet resolution.
 *
 * Three input shapes accepted by tools:
 *   1. Literal address ("0x" + 40 hex)         → used as-is.
 *   2. Name from `wallets.json`                 → resolved to address.
 *   3. Omitted (undefined)                      → falls back to a default.
 *
 * Default precedence (when input is omitted):
 *   a. `wallets.json` → `default` key, if it points to an entry.
 *   b. `AAVE_DEFAULT_WALLET` env var (legacy, single-wallet setups).
 *   c. Throw with an actionable message.
 *
 * `wallets.json` location precedence:
 *   1. `AAVE_WALLETS_FILE` env var (absolute path).
 *   2. `<connector-root>/wallets.json` (sibling of package.json).
 *
 * Missing `wallets.json` is NOT an error — it just means the user is
 * on the legacy env-var-only setup. Existing installs keep working
 * with no migration required.
 */

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const CACHE_TTL_MS = 5_000;

export interface WalletEntry {
  name: string;
  address: string;
}

interface WalletsFile {
  wallets: WalletEntry[];
  default?: string;
}

let _cache: WalletsFile | null = null;
let _cacheTime = 0;

function defaultWalletsPath(): string {
  // dist/index.js lives at <root>/dist/index.js — wallets.json sits
  // beside package.json at <root>/wallets.json.
  // Using import.meta.url makes this work regardless of CWD.
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "..", "wallets.json");
}

function walletsFilePath(): string {
  return process.env.AAVE_WALLETS_FILE || defaultWalletsPath();
}

function loadWalletsFile(): WalletsFile {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL_MS) return _cache;

  const file = walletsFilePath();
  let parsed: WalletsFile;
  try {
    const raw = fs.readFileSync(file, "utf-8");
    parsed = JSON.parse(raw) as WalletsFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      parsed = { wallets: [] };
    } else if (e instanceof SyntaxError) {
      throw new Error(
        `Invalid JSON in ${file}: ${e.message}. ` +
          `Expected shape: { "wallets": [{ "name": "...", "address": "0x..." }], "default": "..." }.`,
      );
    } else {
      throw e;
    }
  }

  if (!Array.isArray(parsed.wallets)) {
    throw new Error(
      `Invalid ${file}: missing "wallets" array. ` +
        `Expected shape: { "wallets": [{ "name": "...", "address": "0x..." }], "default": "..." }.`,
    );
  }

  const seenNames = new Set<string>();
  for (const w of parsed.wallets) {
    if (!w || typeof w !== "object") {
      throw new Error(`Invalid wallet entry in ${file}: not an object.`);
    }
    if (!NAME_RE.test(w.name ?? "")) {
      throw new Error(
        `Invalid wallet name in ${file}: ${JSON.stringify(w.name)}. ` +
          `Names must be 1-40 chars, alphanumeric / _ / -.`,
      );
    }
    if (!ADDR_RE.test(w.address ?? "")) {
      throw new Error(
        `Invalid wallet address in ${file} for "${w.name}": ` +
          `${JSON.stringify(w.address)}. Expected "0x" + 40 hex.`,
      );
    }
    if (seenNames.has(w.name)) {
      throw new Error(`Duplicate wallet name in ${file}: "${w.name}".`);
    }
    seenNames.add(w.name);
  }

  if (parsed.default && !seenNames.has(parsed.default)) {
    throw new Error(
      `Invalid "default" in ${file}: "${parsed.default}" does not match any wallet name.`,
    );
  }

  _cache = parsed;
  _cacheTime = now;
  return parsed;
}

/**
 * Resolve a tool's `wallet` argument to a lowercase 0x address.
 * See module doc for precedence rules.
 */
export function resolveWallet(input?: string): string {
  if (input) {
    if (ADDR_RE.test(input)) return input.toLowerCase();
    // Try as a name from wallets.json.
    const cfg = loadWalletsFile();
    const match = cfg.wallets.find((w) => w.name === input);
    if (match) return match.address.toLowerCase();
    throw new Error(
      `No wallet matching "${input}". Provide a 0x address ` +
        `or a name from wallets.json (${cfg.wallets.length} configured: ${
          cfg.wallets.map((w) => w.name).join(", ") || "none"
        }).`,
    );
  }

  // No input — fall back to a default.
  const cfg = loadWalletsFile();
  if (cfg.default) {
    const match = cfg.wallets.find((w) => w.name === cfg.default);
    if (match) return match.address.toLowerCase();
  }

  const env = process.env.AAVE_DEFAULT_WALLET;
  if (env && ADDR_RE.test(env)) return env.toLowerCase();
  if (env) {
    throw new Error(
      `Invalid AAVE_DEFAULT_WALLET: ${JSON.stringify(env)}. ` +
        'Expected "0x" + 40 hex characters.',
    );
  }

  throw new Error(
    "No wallet specified and no default configured. " +
      "Pass a `wallet` argument (0x address or a name from wallets.json), " +
      'set `"default"` in wallets.json, or set the AAVE_DEFAULT_WALLET environment variable.',
  );
}

/** List all wallets currently configured in wallets.json. Empty if file is missing. */
export function listConfiguredWallets(): WalletEntry[] {
  return loadWalletsFile().wallets.slice();
}

/** Current default name from wallets.json, or undefined if no default is set. */
export function getDefaultWalletName(): string | undefined {
  return loadWalletsFile().default;
}

/** Resolved path of the wallets.json file (for diagnostics / error messages). */
export function getWalletsFilePath(): string {
  return walletsFilePath();
}

function persistWalletsFile(next: WalletsFile): void {
  const file = walletsFilePath();
  // Ensure parent dir exists (relevant when AAVE_WALLETS_FILE points elsewhere).
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write to a tmp file then rename, so the swap is atomic at the FS level
  // (a reader either sees the old file or the new one, never a half-written one).
  // Then chmod 0600 explicitly: `writeFileSync({mode})` only takes effect when
  // CREATING the file, so a pre-existing wallets.json with looser perms would
  // keep them without this explicit chmod.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  // Invalidate the in-memory cache so the next read sees the new state.
  _cache = next;
  _cacheTime = Date.now();
}

/**
 * Discriminated union of operations accepted by `applyWalletOperations`.
 *
 * - `add`: add (or replace, idempotent on same name) a wallet entry. When
 *   `makeDefault` is true the entry becomes the default; otherwise the
 *   existing default is preserved.
 * - `remove`: drop an entry by name. If it was the default, the default
 *   is cleared.
 * - `setDefault`: set the default to an existing wallet name.
 */
export type WalletOperation =
  | { type: "add"; name: string; address: string; makeDefault?: boolean }
  | { type: "remove"; name: string }
  | { type: "setDefault"; name: string };

interface AppliedOp {
  op: WalletOperation;
  result: "added" | "replaced" | "removed" | "default-set";
  defaultBecame?: string | null;
}

function validateName(name: unknown, label = "name"): asserts name is string {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(
      `Invalid wallet ${label}: ${JSON.stringify(name)}. ` +
        `Names must be 1-40 chars, alphanumeric / _ / -.`,
    );
  }
}

function applyOneOp(state: WalletsFile, op: WalletOperation): AppliedOp {
  if (op.type === "add") {
    validateName(op.name);
    if (typeof op.address !== "string" || !ADDR_RE.test(op.address)) {
      throw new Error(
        `Invalid wallet address: ${JSON.stringify(op.address)}. ` +
          `Expected "0x" + 40 hex characters.`,
      );
    }
    const lowered = op.address.toLowerCase();
    const existed = state.wallets.some((w) => w.name === op.name);
    const wasEmpty = state.wallets.length === 0;
    state.wallets = [
      ...state.wallets.filter((w) => w.name !== op.name),
      { name: op.name, address: lowered },
    ];
    // First entry of an empty file is implicitly the default. After that,
    // the default only changes when caller sets makeDefault explicitly.
    if (op.makeDefault === true || wasEmpty) {
      state.default = op.name;
    } else if (state.default && !state.wallets.some((w) => w.name === state.default)) {
      delete state.default;
    }
    return { op, result: existed ? "replaced" : "added", defaultBecame: state.default ?? null };
  }

  if (op.type === "remove") {
    validateName(op.name);
    if (!state.wallets.some((w) => w.name === op.name)) {
      throw new Error(
        `No wallet named "${op.name}". ` +
          `Configured: ${state.wallets.map((w) => w.name).join(", ") || "none"}.`,
      );
    }
    state.wallets = state.wallets.filter((w) => w.name !== op.name);
    if (state.default === op.name) delete state.default;
    return { op, result: "removed", defaultBecame: state.default ?? null };
  }

  // setDefault
  validateName(op.name);
  if (!state.wallets.some((w) => w.name === op.name)) {
    throw new Error(
      `Cannot set default to "${op.name}": no wallet by that name. ` +
        `Configured: ${state.wallets.map((w) => w.name).join(", ") || "none"}.`,
    );
  }
  state.default = op.name;
  return { op, result: "default-set", defaultBecame: op.name };
}

/**
 * Apply a batch of wallet operations atomically: a single read of
 * `wallets.json`, all operations applied in order against an in-memory
 * working copy, and a single write at the end. If any operation throws,
 * the whole batch is aborted with no on-disk changes.
 *
 * Two batches dispatched concurrently each run their read-apply-write
 * synchronously, so they cannot interleave (the JS event loop runs
 * sync code to completion before yielding to the next handler).
 */
export function applyWalletOperations(
  operations: readonly WalletOperation[],
): { applied: AppliedOp[]; finalState: WalletsFile } {
  if (operations.length === 0) {
    throw new Error("applyWalletOperations called with empty operations list.");
  }
  // Deep-ish clone of current state to keep failures clean.
  const current = loadWalletsFile();
  const state: WalletsFile = {
    wallets: current.wallets.map((w) => ({ ...w })),
    default: current.default,
  };

  const applied: AppliedOp[] = [];
  for (const op of operations) {
    applied.push(applyOneOp(state, op));
  }

  // Tidy up: never write `default: undefined`.
  if (state.default === undefined) delete state.default;

  persistWalletsFile(state);
  return { applied, finalState: state };
}
