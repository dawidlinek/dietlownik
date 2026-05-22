import type { AnyToolDefinition } from "@/mcp/types";

import { find_diets } from "./find-diets";
import { get_menu } from "./get-menu";
import { login } from "./login";
import { place_order } from "./place-order";
import { plan_week } from "./plan-week";
import { quote_order } from "./quote-order";
import { rank_day } from "./rank-day";

export const ALL_TOOLS = [
  find_diets,
  rank_day,
  plan_week,
  get_menu,
  quote_order,
  place_order,
  login,
] as const satisfies readonly AnyToolDefinition[];
