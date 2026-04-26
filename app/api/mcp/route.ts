import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loginInputSchema, loginTool } from "@/mcp/tools/login";
import { getProfileInputSchema, getProfileTool } from "@/mcp/tools/get_profile";
import {
  searchCateringsInputSchema,
  searchCateringsTool,
} from "@/mcp/tools/search_caterings";
import {
  getMealOptionsInputSchema,
  getMealOptionsTool,
} from "@/mcp/tools/get_meal_options";
import { placeOrderInputSchema, placeOrderTool } from "@/mcp/tools/place_order";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SessionBinding = {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
};

const sessions = new Map<string, SessionBinding>();

function wrapResult(result: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result),
      },
    ],
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "dietly-mcp-server",
    version: "0.1.0",
  });

  server.registerTool(
    "login",
    {
      title: "Dietly Login",
      description:
        "Log in as a Dietly user and return profile data with profileAddressId values.",
      inputSchema: loginInputSchema,
    },
    async (args) => wrapResult(await loginTool(args))
  );

  server.registerTool(
    "get_profile",
    {
      title: "Get Dietly Profile",
      description:
        "Fetch profile details for an authenticated user, including profileAddressId values.",
      inputSchema: getProfileInputSchema,
    },
    async (args) => wrapResult(await getProfileTool(args))
  );

  server.registerTool(
    "search_caterings",
    {
      title: "Search Caterings",
      description:
        "Search local Postgres for catering options in a city with optional filtering.",
      inputSchema: searchCateringsInputSchema,
    },
    async (args) => wrapResult(await searchCateringsTool(args))
  );

  server.registerTool(
    "get_meal_options",
    {
      title: "Get Meal Options",
      description:
        "Fetch live meal slots and meal IDs for fixed or menu-configuration diets.",
      inputSchema: getMealOptionsInputSchema,
    },
    async (args) => wrapResult(await getMealOptionsTool(args))
  );

  server.registerTool(
    "place_order",
    {
      title: "Place Order",
      description:
        "Create a Dietly cart order and return payment URL plus order ID.",
      inputSchema: placeOrderInputSchema,
    },
    async (args) => wrapResult(await placeOrderTool(args))
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

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (!sid) return;
    sessions.delete(sid);
  };

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
