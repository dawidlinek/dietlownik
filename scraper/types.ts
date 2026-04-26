// ── API response shapes ───────────────────────────────────────────────────────

export interface City {
  cityId: number;
  name: string;
  sanitizedName: string;
  countyName: string;
  municipalityName: string;
  provinceName: string;
  cityStatus: boolean;
  numberOfCompanies: number;
  largestCityForName: boolean;
}

export interface TopSearchResponse {
  cities: City[];
  companies: CompanySearchItem[];
  moreCitiesAvailable: boolean;
  moreCompaniesAvailable: boolean;
}

export interface CompanySearchItem {
  name: string;       // slug / companyId
  fullName: string;
  companyId?: string; // mapped from name
  [key: string]: unknown;
}

// ── Catalog (/constant) ───────────────────────────────────────────────────────

export interface DietCaloriesItem {
  dietCaloriesId: number;
  calories: number;
}

export interface DietOption {
  dietOptionId: number;
  tierDietOptionId: string;
  name: string;
  dietOptionTag: string | null;
  dietCalories: DietCaloriesItem[];
  defaultOption: boolean;
}

export interface Tier {
  tierId: number;
  name: string;
  minPrice: string | number; // "67.00 zł" or number
  mealsNumber: number;
  defaultOptionChange: boolean;
  tag: string | null;
  dietOptions: DietOption[];
}

export interface Discount {
  discount: number;
  minimumDays: number;
  discountType: string;
}

export interface Diet {
  dietId: number;
  name: string;
  description: string | null;
  imageUrl: string | null;
  awarded: boolean;
  avgScore: number | null;
  feedbackValue: number | null;
  feedbackNumber: number | null;
  dietTag: string | null;
  isMenuConfiguration: boolean;
  dietMealCount: number | null;
  discounts: Discount[];
  dietTiers: Tier[];
}

export interface CompanyHeader {
  name: string;
  logoUrl: string | null;
  avgScore: number | null;
  feedbackValue: number | null;
  feedbackNumber: number | null;
  awarded: boolean;
}

export interface CompanyParams {
  deliveryOnSaturday: boolean;
  deliveryOnSunday: boolean;
}

export interface MenuSettings {
  menuEnabled: boolean;
  menuDaysAhead: number;
}

export interface ConstantResponse {
  companyDiets: Diet[];
  companyHeader: CompanyHeader;
  companyParams: CompanyParams;
  menuSettings: MenuSettings;
}

// ── City endpoint (/city/:cityId) ─────────────────────────────────────────────

export interface CompanySettings {
  ordersEnabled: boolean;
  deliveryEnabled: boolean;
}

export interface LowestPrice {
  standard: string | null;
  menuConfiguration: string | null;
}

export interface CitySearchResult {
  cityId: number;
  name: string;
  deliveryFee: number | null;
}

export interface DietPriceInfo {
  dietId: number;
  discountPrice: string;
  defaultPrice: string;
  dietCaloriesIds: number[];
  dietPriceInCompanyPromotion: boolean;
}

export interface CityResponse {
  companyPriceCategory: string | null;
  companySettings: CompanySettings;
  lowestPrice: LowestPrice;
  citySearchResult: CitySearchResult;
  dietPriceInfo: DietPriceInfo[];
}

// ── calculate-price ───────────────────────────────────────────────────────────

export interface PriceRequestBody {
  promoCodes: string[];
  deliveryDates: string[];
  dietCaloriesId: number;
  testOrder: boolean;
  cityId: number;
  tierDietOptionId?: string;
}

export interface PriceCart {
  totalCostToPay: number | null;
  totalCostWithoutDiscounts: number | null;
  totalDeliveryCost: number | null;
  totalOrderLengthDiscount: number | null;
  totalPromoCodeDiscount: number | null;
  totalDeliveriesOnDateDiscount: number | null;
}

export interface PriceItem {
  perDayDietCost: number | null;
  perDayDietWithDiscountsCost: number | null;
}

export interface PriceResponse {
  cart: PriceCart;
  items: PriceItem[];
}

// ── Diet tags ─────────────────────────────────────────────────────────────────

export interface DietTag {
  dietTagId: string;
  name: string | null;
  imageUrl: string | null;
  [key: string]: unknown;
}

// ── Campaign ──────────────────────────────────────────────────────────────────

export interface Campaign {
  code: string;
  title: string | null;
  startsAt?: string | null;
  startDate?: string | null;
  endsAt?: string | null;
  endDate?: string | null;
  discountPercent?: number | null;
  discount?: number | null;
  bannerImageUrl?: string | null;
  imageUrl?: string | null;
}

// ── Internal DB row types ─────────────────────────────────────────────────────

export interface PriceLeaf {
  diet_calories_id: number;
  diet_id: number;
  tier_id: number;
  tier_diet_option_id: string | null;
  is_menu_configuration: boolean;
  delivery_on_saturday: boolean;
}
