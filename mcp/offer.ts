// Opaque `offer_id` encoding so the agent never has to thread internal
// dietly IDs (company_id, diet_calories_id, tier_id, tier_diet_option_id).
//
// Format: `v1:<company>:<diet_calories_id>[:<tier_diet_option_id>]`
//   - Non-menu-config diets omit the trailing tier_diet_option_id.
//   - Stable + stateless: encode/decode are pure functions, no server state.
//   - Versioned so we can change the encoding without breaking deployed
//     clients that round-trip an old id.

export interface OfferParts {
  readonly company_id: string;
  readonly diet_calories_id: number;
  readonly is_menu_configuration: boolean;
  /** Set iff the diet is menu-configuration. */
  readonly tier_diet_option_id?: string;
}

const VERSION = "v1";

export const encodeOfferId = (parts: OfferParts): string => {
  const base = `${VERSION}:${parts.company_id}:${parts.diet_calories_id}`;
  if (parts.is_menu_configuration && parts.tier_diet_option_id !== undefined) {
    return `${base}:${parts.tier_diet_option_id}`;
  }
  return base;
};

export class OfferIdError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OfferIdError";
  }
}

export const parseOfferId = (id: string): OfferParts => {
  const parts = id.split(":");
  if (parts.length < 3 || parts[0] !== VERSION) {
    throw new OfferIdError(
      `Invalid offer_id "${id}" — expected "v1:<company>:<diet_calories_id>[:<tier_diet_option_id>]". Re-run find_diets to get a fresh offer_id.`
    );
  }
  const [, company_id, dietCaloriesIdStr, tier_diet_option_id] = parts;
  const diet_calories_id = Number(dietCaloriesIdStr);
  if (
    !company_id ||
    !Number.isInteger(diet_calories_id) ||
    diet_calories_id <= 0
  ) {
    throw new OfferIdError(
      `Malformed offer_id "${id}" (bad company or diet_calories_id). Re-run find_diets.`
    );
  }
  return tier_diet_option_id !== undefined && tier_diet_option_id !== ""
    ? {
        company_id,
        diet_calories_id,
        is_menu_configuration: true,
        tier_diet_option_id,
      }
    : {
        company_id,
        diet_calories_id,
        is_menu_configuration: false,
      };
};
