import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { HttpError } from "@/scraper/api";

import type { AnyToolDefinition, ToolContext, ToolDefinition } from "./types";

/**
 * Identity function for tool definitions. Exists purely for inference: it
 * lets callers write `defineTool({ ... })` and get full type-safety on
 * `execute`'s args + return without manually typing the generics.
 */
export const defineTool = <
  TName extends string,
  TInput extends z.ZodType,
  TOutput extends z.ZodType | undefined = undefined,
>(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ToolDefinition embeds Zod class instances (inputSchema/outputSchema) with mutable internals; this identity helper only forwards the literal through for inference
  def: ToolDefinition<TName, TInput, TOutput>
): ToolDefinition<TName, TInput, TOutput> => def;

const isCallToolResult = (value: unknown): value is CallToolResult =>
  value !== null &&
  typeof value === "object" &&
  "content" in value &&
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by `"content" in value`
  Array.isArray((value as { content: unknown }).content);

const errorResult = (message: string): CallToolResult => ({
  content: [{ text: message, type: "text" }],
  isError: true,
});

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- z.ZodError is a Zod class instance with mutable members; we only read .issues
const formatZodIssues = (error: z.ZodError): string =>
  error.issues
    .map(
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- z.core.$ZodIssue is a Zod-internal union with non-readonly path arrays; read-only access is enforced by usage, not the type
      (i) =>
        `${i.path.length === 0 ? "<root>" : i.path.join(".")}: ${i.message}`
    )
    .join("; ");

/**
 * Domain-specific recovery hints for HttpError responses from the dietly API.
 * Ported verbatim from the legacy `app/api/mcp/route.ts:recoveryHint()` so
 * tool callers continue to see the same actionable next-step messages.
 */
const recoveryHint = (status: number, body: string): string => {
  if (status === 401) {
    return "Session likely expired — call `login` again with the same email.";
  }
  if (
    status === 403 &&
    /Just a moment|cf-browser-verification|__cf_chl_/i.test(body)
  ) {
    return "Cloudflare rate-limited the request. Retry in 5–30s.";
  }
  if (status === 404) {
    return "ID not found. Re-resolve via `search_caterings` or `get_meal_options`.";
  }
  if (status === 400) {
    return "Bad request — check that all IDs come from `search_caterings`/`get_meal_options` (not invented).";
  }
  return "";
};

const toErrorResult = (err: unknown): CallToolResult => {
  if (err instanceof HttpError) {
    const hint = recoveryHint(err.status, err.bodySnippet);
    return errorResult(
      `${err.method} ${err.path} → ${err.status}: ${err.bodySnippet.slice(0, 300)}${hint ? `\n${hint}` : ""}`
    );
  }
  if (err instanceof z.ZodError) {
    return errorResult(`Invalid arguments: ${formatZodIssues(err)}`);
  }
  return errorResult(err instanceof Error ? err.message : String(err));
};

/**
 * Validate args against the tool's input schema, run `execute`, then wrap the
 * result into an MCP `CallToolResult`. Tools that need elicitation /
 * multi-block content return a raw `CallToolResult` (detected via the
 * `content` field) and skip the `outputSchema` validation path entirely.
 *
 * Errors are funnelled through `toErrorResult` so `HttpError` from the
 * scraper API gets a recovery hint and `ZodError` gets a path-prefixed
 * issue list.
 */
export const callTool = async (
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- AnyToolDefinition embeds Zod class instances (inputSchema/outputSchema) with mutable internals; dispatcher only reads from `tool`
  tool: AnyToolDefinition,
  args: unknown,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- SDK contract: ctx.extra/ctx.server expose mutable SDK members; we forward ctx untouched
  ctx: ToolContext
): Promise<CallToolResult> => {
  const parsed = tool.inputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${formatZodIssues(parsed.error)}`);
  }
  let result: unknown;
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `Readonly<unknown>` is structurally `unknown`; the cast satisfies TS without changing runtime behavior
    result = await tool.execute(parsed.data as Readonly<unknown>, ctx);
  } catch (error) {
    return toErrorResult(error);
  }
  if (isCallToolResult(result)) {
    return result;
  }
  if (tool.outputSchema !== undefined) {
    const validated = tool.outputSchema.safeParse(result);
    if (!validated.success) {
      return errorResult(
        `Tool ${tool.name} returned invalid output: ${formatZodIssues(validated.error)}`
      );
    }
    // structuredContent must be a non-array object per spec — arrays /
    // primitives go in the JSON text payload only.
    const { data } = validated;
    const structured =
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by the object/!array guard above
          (data as Record<string, unknown>)
        : undefined;
    return {
      content: [{ text: JSON.stringify(data), type: "text" }],
      ...(structured === undefined ? {} : { structuredContent: structured }),
    };
  }
  // No outputSchema: emit JSON text and attach structuredContent only when
  // the result is a plain object (same guard as the legacy `ok()` helper).
  const structured =
    result !== null && typeof result === "object" && !Array.isArray(result)
      ? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by the object/!array guard above
        (result as Record<string, unknown>)
      : undefined;
  return {
    content: [
      {
        text: typeof result === "string" ? result : JSON.stringify(result),
        type: "text",
      },
    ],
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
};

/**
 * Project the internal tool definition into the wire shape the MCP SDK's
 * ListTools handler returns. JSON Schemas come from Zod 4's built-in
 * `toJSONSchema`. `unrepresentable: "any"` keeps schemas with refinements
 * from throwing — the runtime Zod check still enforces them.
 */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- AnyToolDefinition embeds Zod class instances; projector only reads from `tool`
export const toMcpTool = (tool: AnyToolDefinition): McpTool => ({
  ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
  description: tool.description,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- toJSONSchema returns a JSON Schema; the SDK's `inputSchema` shape is structurally compatible
  inputSchema: z.toJSONSchema(tool.inputSchema, {
    unrepresentable: "any",
  }) as McpTool["inputSchema"],
  name: tool.name,
  ...(tool.outputSchema === undefined
    ? {}
    : {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- same rationale as inputSchema above
        outputSchema: z.toJSONSchema(tool.outputSchema, {
          unrepresentable: "any",
        }) as NonNullable<McpTool["outputSchema"]>,
      }),
});
