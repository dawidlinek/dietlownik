import type { AnyToolDefinition } from "@/mcp/types";

import { find_diets } from "./find-diets";
import { get_context } from "./get-context";
import { get_offer } from "./get-offer";
import { login } from "./login";
import { plan } from "./plan";
import { quote } from "./quote";
import { send_to_basket } from "./send-to-basket";

// Order is the flow: context → plan → drill in / browse → price → basket.
export const ALL_TOOLS = [
  get_context,
  plan,
  get_offer,
  find_diets,
  quote,
  login,
  send_to_basket,
] as const satisfies readonly AnyToolDefinition[];
