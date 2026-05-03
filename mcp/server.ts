// eslint-disable-next-line @typescript-eslint/no-deprecated -- Server is the low-level API; we own dispatch and don't need McpServer's higher-level wiring
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { DietlyClient } from "./client";
import { callTool, toMcpTool } from "./tool";
import { ALL_TOOLS } from "./tools";
import type { AnyToolDefinition } from "./types";

const MCP_TOOL_LIST = ALL_TOOLS.map(toMcpTool);
const TOOLS_BY_NAME: ReadonlyMap<string, AnyToolDefinition> = new Map(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ALL_TOOLS items embed Zod class instances; this map projector only reads `t.name`
  ALL_TOOLS.map((t) => [t.name, t])
);

const SERVER_INFO = {
  name: "dietly-mcp-server",
  version: "0.3.0",
};

const INSTRUCTIONS =
  "Tools wrap dietly.pl meal-delivery (catering diet) ordering for one user. " +
  "Typical flow:\n" +
  "  1. `find_diets(city: 'Wrocław', max_price_per_day: 80)` → list of offers, each with an opaque `offer_id`.\n" +
  "  2. `quote_order(offer_id, city, dates)` → exact PLN total + breakdown, no order placed.\n" +
  "  3. `login(email, password)` → caches the session for the rest of this conversation; returns `addresses` with stable `address_index` slots.\n" +
  "  4. `get_menu(offer_id, city, dates?)` → daily meals with `pick_id` per option (only needed when the offer is `is_configurable: true`).\n" +
  "  5. `place_order(offer_id, city, dates, picks?, address_index?, test_order?, confirmed)` → IRREVERSIBLE; always show the user the summary from the first call before re-calling with `confirmed: true`.\n" +
  "Pass `offer_id` and `pick_id` as opaque tokens — never parse, never fabricate. After `login`, the email arg on order tools is optional (defaults to the last login).";

/**
 * Build a fresh MCP `Server` wired to all registered tools. The SDK only
 * supports one transport per Server instance, so callers construct one per
 * request. The shared `DietlyClient` is reused across builds, so per-request
 * construction is cheap.
 */
// oxlint-disable-next-line typescript/no-deprecated, typescript/prefer-readonly-parameter-types -- Server is the low-level API (see import comment); DietlyClient is a class with public methods (login/authGet/authPost) the server intentionally invokes
export const buildServer = (client: DietlyClient): Server => {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see import comment
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await Promise.resolve();
    return { tools: MCP_TOOL_LIST };
  });

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- SDK contract: setRequestHandler's callback receives `req` and `extra` typed by the SDK as mutable; we only read from both
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool = TOOLS_BY_NAME.get(req.params.name);
    if (tool === undefined) {
      await Promise.resolve();
      return {
        content: [
          { text: `Unknown tool: ${req.params.name}`, type: "text" as const },
        ],
        isError: true,
      };
    }
    return callTool(tool, req.params.arguments, { client, extra, server });
  });

  return server;
};
