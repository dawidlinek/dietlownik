// Next.js entry for the dietly MCP server. Architecture mirrors matrix-mcp:
// per-request `Server` construction (the SDK only allows one transport per
// Server), session map keyed by MCP session ID for the streamable-HTTP
// transport.
//
// IMPORTANT: each MCP session gets its OWN `DietlyClient` instance — the
// dietly cookie jar is per-session, never process-wide. This is critical
// for multi-user safety: without it, anyone calling a tool with another
// user's email could reuse that user's cached cookies.
//
// All tool definition, dispatch, and error handling live under `mcp/`.
// This route only does HTTP plumbing.

// eslint-disable-next-line @typescript-eslint/no-deprecated -- low-level Server is what buildServer returns
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { DietlyClient } from "@/mcp/client";
import { buildServer } from "@/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SessionBinding {
  client: DietlyClient;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see import
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
}

const sessions = new Map<string, SessionBinding>();

const createSessionBinding = async (): Promise<SessionBinding> => {
  // Holder so the transport's `onsessioninitialized` callback can reach the
  // binding that we construct *after* the transport (chicken-and-egg: the
  // callback closure is needed at transport construction time).
  const holder: { current: SessionBinding | undefined } = {
    current: undefined,
  };

  const transport = new WebStandardStreamableHTTPServerTransport({
    onsessionclosed: async (sessionId) => {
      const existing = sessions.get(sessionId);
      if (existing) {
        await existing.server.close();
        // The client + its cookie cache become unreachable here and get GC'd.
        sessions.delete(sessionId);
      }
    },
    onsessioninitialized: (sessionId) => {
      if (holder.current) {
        sessions.set(sessionId, holder.current);
      }
    },
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  const client = new DietlyClient();
  const server = buildServer(client);
  await server.connect(transport);

  holder.current = { client, server, transport };
  return holder.current;
};

const resolveBinding = async (
  request: Request,
  parsedBody: unknown
): Promise<SessionBinding | Response> => {
  const sessionId = request.headers.get("mcp-session-id");
  if (sessionId !== null && sessionId !== "") {
    const existing = sessions.get(sessionId);
    if (existing) {
      return existing;
    }
  }
  if (request.method === "POST" && isInitializeRequest(parsedBody)) {
    const binding = await createSessionBinding();
    return binding;
  }
  return Response.json(
    {
      error: {
        code: -32_000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
      jsonrpc: "2.0",
    },
    { status: 400 }
  );
};

const handleRequest = async (request: Request): Promise<Response> => {
  let parsedBody: unknown;
  if (request.method === "POST") {
    try {
      parsedBody = await request.json();
    } catch {
      parsedBody = undefined;
    }
  }

  const bindingOrResponse = await resolveBinding(request, parsedBody);
  if (bindingOrResponse instanceof Response) {
    return bindingOrResponse;
  }

  try {
    return await bindingOrResponse.transport.handleRequest(request, {
      parsedBody,
    });
  } catch (error) {
    console.error("[mcp] request failed", error);
    return Response.json(
      {
        error: { code: -32_603, message: "Internal server error" },
        id: null,
        jsonrpc: "2.0",
      },
      { status: 500 }
    );
  }
};

export const GET = async (request: Request) => {
  const response = await handleRequest(request);
  return response;
};

export const POST = async (request: Request) => {
  const response = await handleRequest(request);
  return response;
};

export const DELETE = async (request: Request) => {
  const response = await handleRequest(request);
  return response;
};
