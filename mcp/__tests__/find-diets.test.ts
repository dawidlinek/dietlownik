import { describe, expect, it, vi } from "vitest";

// Mirrors lib/__tests__ pattern: stub `server-only` in case any transitive
// import asserts it. mcp/* doesn't currently import it but lib/embeddings.ts
// (pulled in via lib/queries → preference-router) historically did.
vi.mock("server-only", () => ({}));

describe("find_diets regression snapshot", () => {
  // No DB or network — pure JSON-Schema projection. Timeout is generous
  // because the full vitest run pays a one-time cold-import cost (≈100s on
  // Windows) before any test executes; the test itself runs in ~1s.
  vi.setConfig({ testTimeout: 60_000 });

  it("exposes a stable MCP-wire contract (name + schema shape)", async () => {
    // Captures the wire-level shape (name, description, input/output JSON
    // Schema) so accidental drift in find-diets.ts shows up as a snapshot
    // diff. Live output is covered by call-tool-roundtrip.test.ts.
    const { find_diets } = await import("../tools/find-diets");
    const { toMcpTool } = await import("../tool");

    const wire = toMcpTool(find_diets);
    expect({
      annotations: wire.annotations,
      description: wire.description,
      inputSchema: wire.inputSchema,
      name: wire.name,
      outputSchema: wire.outputSchema,
    }).toMatchSnapshot();
  });
});
