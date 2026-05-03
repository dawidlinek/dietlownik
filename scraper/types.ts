// ── Discovery / search ────────────────────────────────────────────────────────

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
  diets?: unknown[];
  moreCitiesAvailable: boolean;
  moreCompaniesAvailable: boolean;
}

export interface ActivePromotionInfo {
  promoText: string | null;
  promoDeadline: string | null; // YYYY-MM-DD
  code: string | null;
  discountPercents: number | null;
  separate?: boolean | null;
}

/** awarded-and-top entry — describes a company in a city. */
export interface CompanySearchItem {
  /** companyId slug */
  name: string;
  fullName: string;
  imageUrl?: string | null;
  badgeUrl?: string | null;
  rate?: number | null; // 0..5
  positiveMealsReviewPercent?: number | null; // 0..100
  awarded?: boolean;
  numberOfRates?: number | null;
  orderPossibleOn?: string | null;
  orderPossibleTo?: string | null;
  possibleCalories?: number[] | null;
  dietNames?: string[] | null;
  numberOfDiets?: number | null;
  inviteCodeDiscountPercent?: number | null;
  shortDescription?: string | null;
  params?: Record<string, boolean> | null;
  galleryFullSize?: number | null;
  priceCategory?: string | null;
  activePromotionInfo?: ActivePromotionInfo | null;
  galleryImages?: unknown[] | null;
  /** Set client-side; equal to `name`. */
  companyId?: string;
  [key: string]: unknown;
}

export interface AwardedAndTopResponse {
  city?: unknown;
  currentPage: number;
  totalElements: number;
  totalPages: number;
  histogramResponses?: unknown;
  searchData: CompanySearchItem[];
  similarCityNames?: unknown;
}

// ── Catalog (/constant) ───────────────────────────────────────────────────────

export interface DietCaloriesItem {
  dietCaloriesId: number;
  calories: number;
}

export interface DietOption {
  dietOptionId: number;
  tierDietOptionId?: string; // present for menu-config diets only
  name: string;
  dietOptionTag: string | null;
  dietCalories: DietCaloriesItem[];
  defaultOption: boolean;
}

export interface Tier {
  tierId: number;
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  minPrice: string | number; // "67.00 zł" string in practice
  mealsNumber: number;
  defaultOptionChange: boolean;
  tag: string | null;
  dietOptions: DietOption[];
}

export interface Discount {
  discount: number;
  minimumDays: number;
  discountType: string; // PERCENTAGE | FIXED
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
  /** Populated on fixed (non-menu-config) diets; empty on menu-config. */
  dietOptions: DietOption[];
  /** Empty on fixed diets; populated on menu-config. */
  dietTiers: Tier[];
}

export interface CompanyHeader {
  name: string;
  logoUrl: string | null;
  mainImageUrl?: string | null;
  badgeUrl?: string | null;
  favourite?: boolean;
  /** 0..100 — this is the "company rating" on mobile. */
  rateValue: number | null;
  feedbackValue: number | null;
  feedbackNumber: number | null;
  rate?: number | null; // 0..5 duplicate
  awarded?: boolean;
  recentlyAdded?: boolean;
  dietlyDelivery?: boolean;
  activePromotionInfo: ActivePromotionInfo | null;
  deliveryInfo?: { date: string | null; text: string | null } | null;
}

export interface CompanyParams {
  hasDietWithMenuConfiguration?: boolean;
  hasDietWithMenuConfigurationWithTiers?: boolean;
  dietitianConsultation?: boolean;
  deliveryOnSaturday: boolean;
  deliveryOnSunday: boolean;
  loyaltyProgramEnabled?: boolean;
  ecologicalPackaging?: boolean;
  [key: string]: unknown;
}

export interface MenuSettings {
  menuEnabled: boolean;
  menuDaysAhead: number;
}

export interface ConstantResponse {
  companyDiets: Diet[];
  companyHeader: CompanyHeader;
  companyParams: CompanyParams;
  companySideOrders?: unknown[];
  contactDetails?: unknown;
  deliveryCities?: unknown[];
  formSettings?: unknown;
  images?: unknown[];
  menuSettings: MenuSettings;
  programs?: unknown[];
}

// ── /city/{cityId} ────────────────────────────────────────────────────────────

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
  sanitizedName?: string;
  county?: string;
  municipality?: string;
  province?: string;
  sectorId?: number;
  deliveryFee: number | null;
  deliveryTime?: {
    deliveryTimeId: number;
    timeFrom: string;
    timeTo: string;
  }[];
}

export interface DietPriceInfo {
  dietId: number;
  discountPrice: string | null;
  defaultPrice: string | null;
  dietCaloriesIds: number[];
  dietPriceInCompanyPromotion: boolean;
}

export interface CityResponse {
  dietPriceInfo: DietPriceInfo[];
  companyPriceCategory: string | null;
  companySettings: CompanySettings;
  awarded?: boolean;
  citySearchResult: CitySearchResult;
  lowestPrice: LowestPrice;
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
  totalLowest30DaysCostWithoutDiscounts?: number | null;
  totalDeliveryCost: number | null;
  totalOrderLengthDiscount: number | null;
  totalPromoCodeDiscount: number | null;
  totalPromoCodeDiscountInfo?: string | null;
  totalDeliveriesOnDateDiscount: number | null;
  totalLoyaltyPointsDiscount?: number | null;
  totalPickupPointDiscount?: number | null;
  totalOneTimeSideOrdersCost?: number | null;
  totalAwardedLoyaltyProgramPoints?: number | null;
  totalAwardedGlobalLoyaltyProgramPoints?: number | null;
}

export interface PriceItem {
  itemId?: string;
  perDayDietCost: number | null;
  perDayDietWithDiscountsCost: number | null;
  totalItemDeliveryCost?: number | null;
  totalDietWithDiscountsAndSideOrdersCost?: number | null;
  totalDietWithSideOrdersCost?: number | null;
  totalDietWithoutSideOrdersCost?: number | null;
  totalSideOrdersCost?: number | null;
  totalCutleryCost?: number | null;
  totalSideOrdersWithoutCutleryCost?: number | null;
  totalMealsChosenCost?: number | null;
}

export interface PriceResponse {
  cart: PriceCart;
  items: PriceItem[];
}

// ── Diet tags ─────────────────────────────────────────────────────────────────

export interface DietTag {
  dietTagInfoId?: number;
  dietTagId: string;
  name: string | null;
  imageUrl: string | null;
  urlName?: string | null;
  main?: boolean;
  priority?: number;
  calories?: number[];
  dietTagBulletPoints?: string[];
  dietDescriptions?: { title: string; description: string }[];
  [key: string]: unknown;
}

// ── /menu/{dietCaloriesId}/.../date/{date} ────────────────────────────────────

export interface MealDetails {
  name: string;
  imageUrl?: string | null;
  calories?: string | null; // "300.45 kcal / 1257 kJ"
  protein?: string | null; // "18.87g"
  carbohydrate?: string | null;
  fat?: string | null;
  saturatedFattyAcids?: string | null;
  sugar?: string | null;
  salt?: string | null;
  dietaryFiber?: string | null;
  thermo?: string | null;
  allergens?: string | null; // pretty string
  allergensWithExcluded?: {
    dietaryExclusionId: number;
    companyAllergenName: string;
    dietlyAllergenName: string;
    excluded: boolean;
  }[];
  ingredients?: { name: string; major: boolean; exclusion: unknown[] }[];
}

export interface MealOption {
  dietCaloriesMealId: number;
  name: string;
  label: string | null;
  info: string | null;
  thermo: string | null;
  reviewsNumber: number | null;
  reviewsScore: number | null;
  details: MealDetails;
}

export interface MealSlot {
  name: string; // "Śniadanie" / "Obiad" / etc.
  baseDietCaloriesMealId: number;
  options: MealOption[];
}

export interface MenuResponse {
  date: string;
  calories: number;
  meals: MealSlot[];
}

// ── /api/open/mobile/banners ─────────────────────────────────────────────────

export interface Banner {
  name: string;
  code: string;
  url: string | null;
  validFrom: string | null; // ISO 8601 with offset
  validTo: string | null;
  deepLink: string | null;
  target: string | null; // DASHBOARD | SAVED_MEALS | COMPANIES
  priority: number | null;
  type: string | null; // CAMPAIGN | STANDALONE
}

// ── /api/open/content-management/recommended-diets ───────────────────────────

export interface RecommendedDiet {
  companyData: {
    companyId: string;
    companyName: string;
    description?: string | null;
    logoUrl?: string | null;
    awarded?: boolean;
  };
  dietDetails: {
    dietId: number;
    dietProgram: string | null;
    dietName: string | null;
    dietImage: string | null;
    tierId: number | null;
    dietOptionId: number | null;
    tierDietOptionId: string | null;
    menuConfiguration: boolean;
  };
  feedbackMetrics?: {
    avgScore: number | null;
    feedbackValue: number | null;
    feedbackNumber: number | null;
  };
  pricingData?: { minDietPrice: number | null; priceCategory: string | null };
  activePromotion?: ActivePromotionInfo | null;
  deliveryInfo?: { text: string | null; date: string | null };
}

// ── Internal DB row types ─────────────────────────────────────────────────────

export interface PriceLeaf {
  diet_calories_id: number;
  diet_id: number;
  tier_id: number | null;
  tier_diet_option_id: string | null;
  is_menu_configuration: boolean;
  delivery_on_saturday: boolean;
  delivery_on_sunday: boolean;
}
