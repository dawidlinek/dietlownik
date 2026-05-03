import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { HttpError } from "@/scraper/api";
import {
  loginInputSchema,
  loginOutputSchema,
  loginTool,
} from "@/mcp/tools/login";
import {
  getProfileInputSchema,
  getProfileOutputSchema,
  getProfileTool,
} from "@/mcp/tools/get_profile";
import {
  searchCateringsInputSchema,
  searchCateringsOutputSchema,
  searchCateringsTool,
} from "@/mcp/tools/search_caterings";
import {
  getMealOptionsInputSchema,
  getMealOptionsOutputSchema,
  getMealOptionsTool,
} from "@/mcp/tools/get_meal_options";
import {
  placeOrderInputSchema,
  placeOrderTool,
  summarizeOrder,
} from "@/mcp/tools/place_order";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SessionBinding = {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
};

const sessions = new Map<string, SessionBinding>();

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(result: unknown): ToolResult {
  // structuredContent must be an object per spec; arrays/primitives go in
  // text only.
  const structured =
    result !== null && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : undefined;
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function recoveryHint(status: number, body: string): string {
  if (status === 401) return "Session likely expired — call `login` again with the same email.";
  if (status === 403 && /Just a moment|cf-browser-verification|__cf_chl_/i.test(body))
    return "Cloudflare rate-limited the request. Retry in 5–30s.";
  if (status === 404) return "ID not found. Re-resolve via `search_caterings` or `get_meal_options`.";
  if (status === 400) return "Bad request — check that all IDs come from `search_caterings`/`get_meal_options` (not invented).";
  return "";
}

function toErrorResult(err: unknown): ToolResult {
  if (err instanceof HttpError) {
    const hint = recoveryHint(err.status, err.bodySnippet);
    return errorResult(
      `${err.method} ${err.path} → ${err.status}: ${err.bodySnippet.slice(0, 300)}${hint ? `\n${hint}` : ""}`,
    );
  }
  if (err instanceof ZodError) {
    return errorResult(
      `Invalid arguments: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return errorResult(err instanceof Error ? err.message : String(err));
}

/**
 * Wraps a tool handler to convert thrown errors into MCP structured tool
 * errors with a recovery hint, and to attach `structuredContent` alongside
 * the text fallback on success.
 */
function runTool<I, O>(handler: (input: I) => Promise<O>) {
  return async (args: I): Promise<ToolResult> => {
    try {
      return ok(await handler(args));
    } catch (err) {
      return toErrorResult(err);
    }
  };
}

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "dietly-mcp-server",
      version: "0.1.0",
    },
    {
      instructions:
        "Auth flow: call `login` once per session, then reuse the same email " +
        "across `get_profile`, `get_meal_options`, and `place_order`. " +
        "Get `profileAddressId`, `tier_diet_option_id`, `diet_calories_id`, " +
        "and `diet_calories_meal_id` values from `search_caterings` + " +
        "`get_meal_options` results — never invent these IDs. " +
        "`place_order` is irreversible and incurs a real charge; always " +
        "show the user the order summary returned by the tool's " +
        "confirmation step before approving.",
    }
  );

  server.registerTool(
    "login",
    {
      title: "Dietly Login",
      description:
        "Log in as a Dietly user with email + password. Caches the session " +
        "server-side keyed by email. Returns profile data with " +
        "`profileAddressId` values needed by `place_order`. Skip if you " +
        "have already called this in the current process.",
      inputSchema: loginInputSchema,
      outputSchema: loginOutputSchema,
      annotations: { openWorldHint: true, idempotentHint: true },
    },
    runTool(loginTool)
  );

  server.registerTool(
    "get_profile",
    {
      title: "Get Dietly Profile",
      description:
        "Fetch profile details (incl. `profileAddressId` values) for an " +
        "already-logged-in email. Use this when the cached session is still " +
        "valid; if the email isn't logged in yet, call `login` first.",
      inputSchema: getProfileInputSchema,
      outputSchema: getProfileOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    runTool(getProfileTool)
  );

  server.registerTool(
    "search_caterings",
    {
      title: "Search Caterings",
      description:
        "Read the local scraper Postgres for catering options in a city, " +
        "optionally filtered by diet tag, max per-day price, min review " +
        "score, or active promo. Returns the IDs (`diet_calories_id`, " +
        "`tier_diet_option_id`, `is_menu_configuration`) that " +
        "`get_meal_options` and `place_order` require. No live API call.",
      inputSchema: searchCateringsInputSchema,
      outputSchema: searchCateringsOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runTool(searchCateringsTool)
  );

  server.registerTool(
    "get_meal_options",
    {
      title: "Get Meal Options",
      description:
        "Fetch live per-day meal slots + `diet_calories_meal_id` values " +
        "from dietly. For fixed diets, set `is_menu_configuration: false`. " +
        "For menu-configuration diets, set true and pass `tier_id` plus " +
        "the `base_meal_ids` from a prior call. Use the returned " +
        "`diet_calories_meal_id` values when building `place_order`'s " +
        "`meal_selections`.",
      inputSchema: getMealOptionsInputSchema,
      outputSchema: getMealOptionsOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    runTool(getMealOptionsTool)
  );

  server.registerTool(
    "place_order",
    {
      title: "Place Order",
      description:
        "Create a real Dietly cart order. IRREVERSIBLE — incurs a charge " +
        "unless `test_order: true`. Requires a logged-in email, a " +
        "`profile_address_id` from `login`/`get_profile`, " +
        "`diet_calories_id` from `search_caterings`, and " +
        "`meal_selections` built from `get_meal_options`. " +
        "First call shows a summary and asks for confirmation; " +
        "re-call with `confirmed: true` to actually place. Returns " +
        "payment URL + order ID.",
      inputSchema: placeOrderInputSchema.shape,
      annotations: {
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const input = placeOrderInputSchema.parse(args);
        if (!input.confirmed) {
          const summary = summarizeOrder(input);
          if (server.server.getClientCapabilities()?.elicitation) {
            const r = await server.server.elicitInput({
              message: `Place this order?\n\n${summary}`,
              requestedSchema: {
                type: "object",
                properties: {
                  confirm: {
                    type: "boolean",
                    title: input.test_order ? "Place test order" : "Place real order (will charge)",
                  },
                },
                required: ["confirm"],
              },
            });
            if (r.action !== "accept" || !(r.content as { confirm?: boolean })?.confirm) {
              return ok({ status: "cancelled", reason: r.action, summary });
            }
          } else {
            return ok({
              status: "confirmation_required",
              summary,
              next: "Show the user this summary. If they agree, re-call place_order with `confirmed: true`.",
            });
          }
        }
        return ok(await placeOrderTool(input));
      } catch (err) {
        return toErrorResult(err);
      }
    },
  );

  return server;
}

async function createSessionBinding(): Promise<SessionBinding> {
  let binding: SessionBinding | undefined;

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId) => {
      if (binding) sessions.set(sessionId, binding);
    },
    onsessionclosed: async (sessionId) => {
      const existing = sessions.get(sessionId);
      if (existing) {
        await existing.server.close();
        sessions.delete(sessionId);
      }
    },
  });

  const server = createServer();
  await server.connect(transport);

  binding = { server, transport };
  return binding;
}

async function resolveBinding(
  request: Request,
  parsedBody: unknown
): Promise<SessionBinding | Response> {
  const sessionId = request.headers.get("mcp-session-id");
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
  }

  if (request.method === "POST" && isInitializeRequest(parsedBody)) {
    return createSessionBinding();
  }

  return Response.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
    },
    { status: 400 }
  );
}

async function handleRequest(request: Request): Promise<Response> {
  let parsedBody: unknown = undefined;

  if (request.method === "POST") {
    try {
      parsedBody = await request.json();
    } catch {
      parsedBody = undefined;
    }
  }

  const bindingOrResponse = await resolveBinding(request, parsedBody);
  if (bindingOrResponse instanceof Response) return bindingOrResponse;

  try {
    return await bindingOrResponse.transport.handleRequest(request, {
      parsedBody,
    });
  } catch (error) {
    console.error("[mcp] request failed", error);
    return Response.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  return handleRequest(request);
}

export async function POST(request: Request) {
  return handleRequest(request);
}

export async function DELETE(request: Request) {
  return handleRequest(request);
}
