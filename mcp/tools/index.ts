import type { AnyToolDefinition } from "@/mcp/types";

import { get_meal_options } from "./get_meal_options";
import { get_profile } from "./get_profile";
import { login } from "./login";
import { place_order } from "./place_order";
import { search_caterings } from "./search_caterings";

export const ALL_TOOLS = [
  get_meal_options,
  get_profile,
  login,
  place_order,
  search_caterings,
] as const satisfies readonly AnyToolDefinition[];
