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
  version: "0.2.0",
};

const INSTRUCTIONS =
  "Auth flow: call `login` once per session, then reuse the same email " +
  "across `get_profile`, `get_meal_options`, and `place_order`. " +
  "Get `profileAddressId`, `tier_diet_option_id`, `diet_calories_id`, " +
  "and `diet_calories_meal_id` values from `search_caterings` + " +
  "`get_meal_options` results — never invent these IDs. " +
  "`place_order` is irreversible and incurs a real charge; always " +
  "show the user the order summary returned by the tool's " +
  "confirmation step before approving.";

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
