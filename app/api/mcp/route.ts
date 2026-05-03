// Next.js entry for the dietly MCP server. Architecture mirrors matrix-mcp:
// per-request `Server` construction (the SDK only allows one transport per
// Server), shared process-wide `DietlyClient` for cookie-cache reuse,
// session map keyed by MCP session ID for the streamable-HTTP transport.
//
// All tool definition, dispatch, and error handling live under `mcp/`.
// This route only does HTTP plumbing.

// eslint-disable-next-line @typescript-eslint/no-deprecated -- low-level Server is what buildServer returns
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { getDietlyClient } from "@/mcp/client";
import { buildServer } from "@/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SessionBinding {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see import
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
}

const sessions = new Map<string, SessionBinding>();

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

  const server = buildServer(getDietlyClient());
  await server.connect(transport);

  binding = { server, transport };
  return binding;
}

async function resolveBinding(
  request: Request,
  parsedBody: unknown,
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
      error: { code: -32_000, message: "Bad Request: No valid session ID provided" },
      id: null,
      jsonrpc: "2.0",
    },
    { status: 400 },
  );
}

async function handleRequest(request: Request): Promise<Response> {
  let parsedBody: unknown;
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
    return await bindingOrResponse.transport.handleRequest(request, { parsedBody });
  } catch (error) {
    console.error("[mcp] request failed", error);
    return Response.json(
      {
        error: { code: -32_603, message: "Internal server error" },
        id: null,
        jsonrpc: "2.0",
      },
      { status: 500 },
    );
  }
}

export function GET(request: Request) {
  return handleRequest(request);
}

export function POST(request: Request) {
  return handleRequest(request);
}

export function DELETE(request: Request) {
  return handleRequest(request);
}
