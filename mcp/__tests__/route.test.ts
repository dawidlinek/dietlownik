import { afterEach, describe, expect, it, vi } from "vitest";

import { DELETE, POST } from "@/app/api/mcp/route";

const jsonRpc = (id: number, method: string, params: unknown = {}) => ({
  id,
  jsonrpc: "2.0",
  method,
  params,
});

const readSseJson = async (
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Response is a built-in fetch class; we only call .text() (consumes the body once, by design)
  res: Response
): Promise<{ id?: number; result?: unknown; error?: unknown }> => {
  // Streamable-HTTP wraps single responses as a one-line SSE `data:` event.
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  if (dataLine === undefined) {
    throw new Error(`no SSE data line in:\n${text}`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-return -- JSON.parse returns any; the function's return type narrows it for callers
  return JSON.parse(dataLine.slice("data:".length).trim());
};

const mkInit = () =>
  new Request("http://localhost/api/mcp", {
    body: JSON.stringify(
      jsonRpc(1, "initialize", {
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.1" },
        protocolVersion: "2025-06-18",
      })
    ),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    method: "POST",
  });

const mkRpc = (sessionId: string, payload: unknown) =>
  new Request("http://localhost/api/mcp", {
    body: JSON.stringify(payload),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": sessionId,
    },
    method: "POST",
  });

describe("MCP route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initialize → tools/list → tools/call (search_caterings)", async () => {
    // Stub the postgres client so search_caterings doesn't hit a real DB.
    const dbModule = await import("@/scraper/db");
    vi.spyOn(dbModule, "q").mockResolvedValue({
      command: "SELECT",
      fields: [],
      oid: 0,
      rowCount: 0,
      rows: [],
    });

    // 1. Initialize
    const initRes = await POST(mkInit());
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    if (sessionId === null) {
      throw new Error("mcp-session-id header missing after initialize");
    }

    // 2. notifications/initialized (transport requires it before subsequent rpcs)
    const notifRes = await POST(
      mkRpc(sessionId, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })
    );
    expect(notifRes.status).toBeLessThan(300);

    // 3. tools/list
    const listRes = await POST(mkRpc(sessionId, jsonRpc(2, "tools/list")));
    const listJson = await readSseJson(listRes);
    expect(listJson.error).toBeUndefined();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only narrowing of the JSON-RPC result envelope to the expected MCP tools/list shape
    const result = listJson.result as {
      readonly tools: readonly { readonly name: string }[];
    };
    const names = result.tools.map((t) => t.name).toSorted();
    expect(names).toEqual([
      "get_meal_options",
      "get_profile",
      "login",
      "place_order",
      "search_caterings",
    ]);

    // 4. tools/call search_caterings — exercises full dispatch
    const callRes = await POST(
      mkRpc(
        sessionId,
        jsonRpc(3, "tools/call", {
          arguments: { city_id: 986_283 },
          name: "search_caterings",
        })
      )
    );
    const callJson = await readSseJson(callRes);
    expect(callJson.error).toBeUndefined();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only narrowing of the JSON-RPC result envelope to the expected MCP tools/call shape
    const callResult = callJson.result as {
      isError?: boolean;
      structuredContent?: { caterings: unknown[]; total: number };
    };
    expect(callResult.isError).toBeUndefined();
    expect(callResult.structuredContent).toEqual({ caterings: [], total: 0 });

    // 5. Tear down so the session map doesn't leak across tests
    await DELETE(mkRpc(sessionId, {}));
  });

  it("returns -32000 when no session id is provided on a non-init POST", async () => {
    const res = await POST(
      new Request("http://localhost/api/mcp", {
        body: JSON.stringify(jsonRpc(99, "tools/list")),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        method: "POST",
      })
    );
    expect(res.status).toBe(400);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only narrowing of the JSON error envelope to the expected JSON-RPC shape
    const body = (await res.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32_000);
  });
});
