/**
 * Custom error class for AAVE RPC errors, with actionable messages.
 */
export class AaveRpcError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "AaveRpcError";
  }
}

/**
 * Wrap a promise so that any rejection becomes `null`. Use this for
 * best-effort RPC reads that may not exist on all AAVE deployments
 * (e.g. methods removed or renamed in v3.2+). The caller decides what
 * `null` means semantically.
 */
export async function tryRead<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/**
 * Converts any thrown value into a user-facing error string suitable for
 * returning in an MCP tool response.
 */
export function formatToolError(err: unknown): string {
  if (err instanceof AaveRpcError) {
    return `AAVE RPC error: ${err.message}`;
  }
  if (err instanceof Error) {
    return `Error: ${err.message}`;
  }
  return `Unknown error: ${String(err)}`;
}
