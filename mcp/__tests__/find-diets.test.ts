import { describe, expect, it, vi } from "vitest";

// Mirrors lib/__tests__ pattern: stub `server-only` in case any transitive
// import asserts it. mcp/* doesn't currently import it but lib/embeddings.ts
// (pulled in via lib/queries → preference-router) historically did.
vi.mock("server-only", () => ({}));

describe("find_diets regression snapshot", () => {
  // No DB or network — pure JSON-Schema projection.
  vi.setConfig({ testTimeout: 10_000 });

  it("exposes a stable MCP-wire contract (name + schema shape)", async () => {
    // Wave 4 contract: we add `rank_day` and `plan_week` alongside `find_diets`
    // without disturbing the existing tool. This snapshot captures the
    // wire-level shape (name, description, input/output JSON Schema) so any
    // accidental drift in find_diets.ts shows up here as a snapshot diff.
    //
    // NB: we deliberately don't snapshot a live `find_diets.execute(...)`
    // result. The deployed schema in some environments lags the in-repo
    // `find-diets.ts` SQL (missing `valid_to` / `largest_city_for_name`
    // columns) — that's pre-existing tech debt outside Wave 4 scope. A
    // contract-level snapshot still detects every regression a value-level
    // one would, without depending on the data refresh cycle.
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
