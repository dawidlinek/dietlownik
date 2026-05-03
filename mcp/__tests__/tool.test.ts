import { describe, expect, it } from "vitest";
import { z } from "zod";

import { HttpError } from "@/scraper/api";

import type { DietlyClient } from "../client";
import { callTool, defineTool, toMcpTool } from "../tool";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test stub: tools under test never touch the client; we only need the type slot
const fakeClient = {} as DietlyClient;

describe("callTool", () => {
  it("returns ok result with structuredContent for plain object", async () => {
    const tool = defineTool({
      description: "test",
      execute: async () => {
        await Promise.resolve();
        return { greeting: "hi" };
      },
      inputSchema: z.object({}),
      name: "test_obj",
      outputSchema: z.object({ greeting: z.string() }),
    });
    const res = await callTool(tool, {}, { client: fakeClient });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({ greeting: "hi" });
    expect(res.content[0]).toMatchObject({
      text: '{"greeting":"hi"}',
      type: "text",
    });
  });

  it("omits structuredContent for array results (spec compliance)", async () => {
    const tool = defineTool({
      description: "test",
      execute: async () => {
        await Promise.resolve();
        return [1, 2, 3];
      },
      inputSchema: z.object({}),
      name: "test_arr",
    });
    const res = await callTool(tool, {}, { client: fakeClient });
    expect(res.structuredContent).toBeUndefined();
    expect(res.content[0]).toMatchObject({ text: "[1,2,3]" });
  });

  it("converts HttpError to structured error with recovery hint", async () => {
    const tool = defineTool({
      description: "test",
      execute: () => {
        throw new HttpError("GET", "/api/profile", 401, "Unauthorized");
      },
      inputSchema: z.object({}),
      name: "test_401",
    });
    const res = await callTool(tool, {}, { client: fakeClient });
    expect(res.isError).toBe(true);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test asserts content shape; CallToolResult content is a discriminated union we narrow to the text variant
    const { text } = res.content[0] as { text: string };
    expect(text).toContain("401");
    expect(text).toContain("call `login` again");
  });

  it("flags Cloudflare 403 with retry hint", async () => {
    const tool = defineTool({
      description: "test",
      execute: () => {
        throw new HttpError("GET", "/x", 403, "<html>Just a moment...</html>");
      },
      inputSchema: z.object({}),
      name: "test_cf",
    });
    const res = await callTool(tool, {}, { client: fakeClient });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test asserts content shape; narrow to text variant
    expect((res.content[0] as { text: string }).text).toContain("Cloudflare");
  });

  it("returns ZodError as structured error with field paths", async () => {
    const tool = defineTool({
      description: "test",
      execute: async ({ n }) => {
        await Promise.resolve();
        return { doubled: n * 2 };
      },
      inputSchema: z.object({ n: z.number().int().positive() }),
      name: "test_zod",
    });
    const res = await callTool(tool, { n: -5 }, { client: fakeClient });
    expect(res.isError).toBe(true);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test asserts content shape; narrow to text variant
    expect((res.content[0] as { text: string }).text).toContain("n:");
  });

  it("validates output against outputSchema and reports mismatch", async () => {
    const tool = defineTool({
      description: "test",
      execute: async () => {
        await Promise.resolve();
        // oxlint-disable-next-line typescript/no-explicit-any, typescript/no-unsafe-type-assertion, typescript/no-unsafe-return -- intentional shape mismatch to exercise output validation
        return { wrong_field: "oops" } as any;
      },
      inputSchema: z.object({}),
      name: "test_out",
      outputSchema: z.object({ ok: z.boolean() }),
    });
    const res = await callTool(tool, {}, { client: fakeClient });
    expect(res.isError).toBe(true);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test asserts content shape; narrow to text variant
    expect((res.content[0] as { text: string }).text).toContain(
      "invalid output"
    );
  });

  it("passes through raw CallToolResult (elicitation/multi-block path)", async () => {
    const tool = defineTool({
      description: "test",
      execute: async () => {
        await Promise.resolve();
        return {
          content: [{ text: "raw", type: "text" as const }],
          isError: false,
        };
      },
      inputSchema: z.object({}),
      name: "test_raw",
    });
    const res = await callTool(tool, {}, { client: fakeClient });
    expect(res.content[0]).toMatchObject({ text: "raw" });
    expect(res.structuredContent).toBeUndefined();
  });
});

describe("toMcpTool", () => {
  it("projects to MCP wire shape with JSON Schema input/output", () => {
    const tool = defineTool({
      annotations: { readOnlyHint: true },
      description: "say hi",
      execute: async ({ name }) => {
        await Promise.resolve();
        return { greeting: `hi ${name}` };
      },
      inputSchema: z.object({ name: z.string() }),
      name: "greet",
      outputSchema: z.object({ greeting: z.string() }),
    });
    const wire = toMcpTool(tool);
    expect(wire.name).toBe("greet");
    expect(wire.description).toBe("say hi");
    expect(wire.annotations).toEqual({ readOnlyHint: true });
    expect(wire.inputSchema.type).toBe("object");
    expect(wire.outputSchema?.type).toBe("object");
  });
});
