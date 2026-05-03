import type { AnyToolDefinition } from "@/mcp/types";

import { find_diets } from "./find-diets";
import { get_menu } from "./get-menu";
import { login } from "./login";
import { place_order } from "./place-order";
import { quote_order } from "./quote-order";

export const ALL_TOOLS = [
  find_diets,
  get_menu,
  login,
  place_order,
  quote_order,
] as const satisfies readonly AnyToolDefinition[];
