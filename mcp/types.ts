// oxlint-disable-next-line typescript/no-deprecated -- Server is the low-level API; we own dispatch
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

// `DietlyClient` is owned by ./client; we only import the type here so
// `ToolContext` can reference it. Consumers must import DietlyClient
// from `@/mcp/client` directly — single canonical location.
import type { DietlyClient } from "./client";

/**
 * Hints clients can show to users about a tool's behavior. All optional —
 * absent annotations are not the same as `false`.
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations
 */
export interface ToolAnnotations {
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  readOnlyHint?: boolean;
  title?: string;
}

/**
 * Recursive readonly. Used to type `execute(input, ctx)` so tools cannot
 * mutate the parsed Zod payload (which would corrupt the dispatcher's
 * caller-side data).
 */
export type DeepReadonly<T> = T extends (...args: readonly never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends Map<infer K, infer V>
      ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
      : T extends Set<infer U>
        ? ReadonlySet<DeepReadonly<U>>
        : T extends object
          ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
          : T;

/**
 * Per-call context passed into every tool's `execute`.
 *
 * - `extra` is the SDK's `RequestHandlerExtra` — has `signal`, `sessionId`, etc.
 * - `server` is the low-level MCP Server — needed by tools that call
 *   `elicitInput()` or `getClientCapabilities()` (`place_order`).
 *
 * Both are optional so a non-elicitation tool (or a unit test) doesn't have
 * to plumb them.
 */
export interface ToolContext {
  readonly client: DietlyClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the SDK's own generic defaults
  readonly extra?: RequestHandlerExtra<any, any>;
  // oxlint-disable-next-line typescript/no-deprecated -- intentional low-level API
  readonly server?: Server;
}

/**
 * Tool definition. `execute` may return:
 *  - a value matching `outputSchema` (or any value when omitted) — the
 *    dispatcher wraps it into `structuredContent` plus a JSON text fallback;
 *  - a raw `CallToolResult` when `content` is present — returned verbatim so
 *    the tool can emit confirmation prompts / multi-block payloads (e.g.
 *    `place_order`'s elicitation flow).
 */
export interface ToolDefinition<
  TName extends string,
  TInput extends z.ZodType,
  TOutput extends z.ZodType | undefined,
> {
  annotations?: ToolAnnotations;
  description: string;
  execute: (
    input: DeepReadonly<z.infer<TInput>>,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- SDK contract: RequestHandlerExtra (in `ctx.extra`) and the deprecated low-level Server (in `ctx.server`) ship with mutable members; tools never mutate ctx, so this is safe in practice
    ctx: ToolContext
  ) => Promise<
    (TOutput extends z.ZodType ? z.infer<TOutput> : unknown) | CallToolResult
  >;
  inputSchema: TInput;
  name: TName;
  outputSchema?: TOutput;
}

export type AnyToolDefinition = ToolDefinition<
  string,
  z.ZodType,
  z.ZodType | undefined
>;

// Re-export Server type for convenience in server.ts consumers.
// oxlint-disable-next-line typescript/no-deprecated -- intentional low-level API
export type { Server };
