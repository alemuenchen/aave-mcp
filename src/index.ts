#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  getPositionDefinition,
  getPositionHandler,
} from "./tools/get-position.js";
import {
  getReserveRatesDefinition,
  getReserveRatesHandler,
} from "./tools/get-reserve-rates.js";
import {
  listPositionsDefinition,
  listPositionsHandler,
} from "./tools/list-positions.js";
import {
  listWalletsDefinition,
  listWalletsHandler,
} from "./tools/list-wallets.js";
import {
  manageWalletsDefinition,
  manageWalletsHandler,
} from "./tools/manage-wallets.js";

const server = new McpServer({
  name: "aave-mcp",
  version: "0.4.0",
});

server.registerTool(
  "aave_get_position",
  getPositionDefinition,
  getPositionHandler as any,
);

server.registerTool(
  "aave_get_reserve_rates",
  getReserveRatesDefinition,
  getReserveRatesHandler as any,
);

server.registerTool(
  "aave_list_positions",
  listPositionsDefinition,
  listPositionsHandler as any,
);

server.registerTool(
  "aave_list_wallets",
  listWalletsDefinition,
  listWalletsHandler as any,
);

server.registerTool(
  "aave_manage_wallets",
  manageWalletsDefinition,
  manageWalletsHandler as any,
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("aave-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal error in aave-mcp:", err);
  process.exit(1);
});
