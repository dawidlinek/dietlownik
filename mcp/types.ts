// oxlint-disable-next-line typescript/no-deprecated -- Server is the low-level API; we own dispatch
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import type { DietlyClient } from "./client";

export type { DietlyClient };

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
  client: DietlyClient;
  extra?: import("@modelcontextprotocol/sdk/shared/protocol.js").RequestHandlerExtra<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the SDK's own generic defaults
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the SDK's own generic defaults
    any
  >;
  // oxlint-disable-next-line typescript/no-deprecated -- intentional low-level API
  server?: Server;
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
    input: z.infer<TInput>,
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
