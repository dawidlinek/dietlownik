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
  name: "dietlownik",
  version: "0.4.0",
};

const INSTRUCTIONS =
  "dietlownik plans catering diets (dietly.pl meal delivery) day by day, " +
  "mixing caterings, and ranks them against free-form Polish preferences — " +
  "the same engine as the dietlownik dashboard. Flow:\n" +
  "  1. `get_context()` → orderable dates, kcal presets, caterings, sorts, keyword vocabulary, data freshness.\n" +
  "  2. `plan(prefer, avoid, kcal_min, kcal_max, dates?, sort?)` → per-day winner with meals and why they scored, alternatives, plan totals (list → promo → final), and `selections`.\n" +
  "     Check `keywords` in the reply: it says how each word was understood and flags weak (semantic-only) matches.\n" +
  "  3. `get_offer(offer_id, date)` to inspect a day or swap a dish; `find_diets` to browse by diet type (KETO, VEGAN…).\n" +
  "  4. `quote(selections)` → live dietly prices, promo acceptance. Nothing ordered.\n" +
  "  5. `login` then `send_to_basket(selections, catering)` → the user's dietly basket; they pay on dietly.pl. One catering per basket.\n" +
  "Prefer/avoid are soft scores, not filters: for an allergy, check `allergens` via get_offer. " +
  "Treat `offer_id` as opaque. Keywords are Polish (kurczak, dużo białka, bez glutenu); translate the user's words.";

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
