"use client";

import * as React from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { MealOption, Pick } from "@/lib/match-types";
import { cn } from "@/lib/utils";

const formatScore = (v: number): string => {
  if (Math.abs(v) < 0.05) {
    return "0,0";
  }
  const sign = v > 0 ? "+" : "−";
  return `${sign}${Math.abs(v).toFixed(1).replace(".", ",")}`;
};

const scoreColor = (v: number): string => {
  if (v > 0.05) {
    return "text-[var(--color-olive)]";
  }
  if (v < -0.05) {
    return "text-[var(--color-clay)]";
  }
  return "text-[var(--color-ink-3)]";
};

const formatInt = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 });

// ── Sub-blocks ──────────────────────────────────────────────────────────────

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.ReactNode union recursively includes mutable Iterable<ReactNode>; cannot be made deeply readonly
const SectionLabel = ({
  children,
}: Readonly<{ children: React.ReactNode }>) => (
  <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] mb-1">
    {children}
  </div>
);

const AllergenChip = ({ name }: Readonly<{ name: string }>) => (
  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] bg-[var(--color-clay-tint)] text-[var(--color-clay)]">
    {name}
  </span>
);

const MacroCell = ({
  label,
  unit,
  value,
}: Readonly<{ label: string; value: number; unit: string }>) => (
  <div className="flex items-baseline justify-between gap-2 py-0.5">
    <span className="text-[11px] text-[var(--color-ink-3)]">{label}</span>
    <span className="tnum text-[12px] text-[var(--color-ink)]">
      {formatInt.format(value)}
      <span className="text-[var(--color-ink-3)] ml-0.5">{unit}</span>
    </span>
  </div>
);

const DishMeta = ({ option }: Readonly<{ option: MealOption }>) => {
  const hasIngredients =
    option.ingredients_raw !== "" && option.ingredients_raw !== "—";
  return (
    <div className="flex flex-col gap-3 px-2.5 py-2">
      {/* Macros — always shown first, always a constant-size 2×3 grid. Putting
          it at the top means the macro cells (the bit the user actually wants
          to compare on hover) don't jump around when ingredients or allergens
          change between previewed options. */}
      <div>
        <SectionLabel>wartości odżywcze</SectionLabel>
        <div className="grid grid-cols-2 gap-x-4">
          <MacroCell label="kcal" unit="" value={option.kcal} />
          <MacroCell label="białko" unit="g" value={option.protein_g} />
          <MacroCell label="tłuszcz" unit="g" value={option.fat_g} />
          <MacroCell label="węgle" unit="g" value={option.carbs_g} />
          <MacroCell label="błonnik" unit="g" value={option.fiber_g} />
          <MacroCell label="cukry" unit="g" value={option.sugar_g} />
        </div>
      </div>

      {/* Ingredients — full list, no clamp. */}
      {hasIngredients && (
        <div>
          <SectionLabel>składniki</SectionLabel>
          <div className="text-[12px] text-[var(--color-ink-2)] leading-snug">
            {option.ingredients_raw}
          </div>
        </div>
      )}

      {/* Allergens */}
      {option.allergens.length > 0 && (
        <div>
          <SectionLabel>alergeny</SectionLabel>
          <div className="flex flex-wrap gap-1">
            {option.allergens.map((a) => (
              <AllergenChip key={a} name={a} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ── Alternates (only when onSwap is provided) ───────────────────────────────

interface AlternateRowProps {
  readonly option: MealOption;
  readonly previewed: boolean;
  readonly onPick: () => void;
  readonly onPreview: () => void;
  readonly onPreviewEnd: () => void;
}

const AlternateRow = ({
  onPick,
  onPreview,
  onPreviewEnd,
  option,
  previewed,
}: Readonly<AlternateRowProps>) => (
  <button
    className={cn(
      "w-full text-left px-2.5 py-1.5 rounded-sm",
      "transition-colors flex items-baseline justify-between gap-2",
      previewed ? "bg-[var(--color-amber-tint)]" : "hover:bg-[var(--color-oat)]"
    )}
    onBlur={onPreviewEnd}
    onClick={onPick}
    onFocus={onPreview}
    onMouseEnter={onPreview}
    onMouseLeave={onPreviewEnd}
    type="button"
  >
    <span className="text-[12px] text-[var(--color-ink)] leading-snug">
      {option.meal_name}
    </span>
    <span
      className={cn("tnum text-[11px] shrink-0", scoreColor(option.meal_score))}
    >
      {formatScore(option.meal_score)}
    </span>
  </button>
);

// ── Top-level ───────────────────────────────────────────────────────────────

export interface DishDetailsPopoverProps {
  readonly pick: Pick;
  /** When provided, the popover offers a swap section for menu-config slots. */
  readonly onSwap?: (option: MealOption) => void;
}

export const DishDetailsPopover = ({
  onSwap,
  pick,
}: Readonly<DishDetailsPopoverProps>) => {
  const [open, setOpen] = React.useState(false);
  const [previewName, setPreviewName] = React.useState<string | null>(null);
  const alternates = pick.alternates ?? [];
  const currentAsOption: MealOption = {
    allergens: pick.allergens,
    carbs_g: pick.carbs_g,
    fat_g: pick.fat_g,
    fiber_g: pick.fiber_g,
    hits: pick.hits,
    ingredients_raw: pick.ingredients_raw,
    is_default: pick.is_default,
    kcal: pick.kcal,
    meal_name: pick.meal_name,
    meal_score: pick.meal_score,
    protein_g: pick.protein_g,
    review_score: pick.review_score,
    sugar_g: pick.sugar_g,
  };
  const others = alternates.filter(
    (o) => o.meal_name !== currentAsOption.meal_name
  );
  const showSwap = onSwap !== undefined && others.length > 0;

  // The option currently driving the header + DishMeta — preview wins over the
  // committed pick so users can scan macros before clicking.
  const previewed = others.find((o) => o.meal_name === previewName);
  const displayed = previewed ?? currentAsOption;

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setPreviewName(null);
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-baseline gap-1 text-left",
            "border-b border-dashed border-[var(--color-bone)]",
            "hover:border-[var(--color-amber)] hover:text-[var(--color-ink)]",
            "transition-colors"
          )}
          type="button"
        >
          <span>{pick.meal_name}</span>
          <span
            aria-hidden
            className="text-[9px] text-[var(--color-ink-3)] leading-none"
          >
            ▾
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] p-0">
        {/* Header — pinned to the current pick so the trigger of the popover
            never moves on hover-preview. */}
        <div className="px-3 pt-2.5 pb-2 border-b border-[var(--color-bone)]">
          <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
            {pick.slot_name}
            {pick.is_default && (
              <span className="ml-2 text-[var(--color-ink-3)]">· default</span>
            )}
          </div>
          <div className="font-display text-[15px] leading-snug text-[var(--color-ink)] mt-0.5 line-clamp-2">
            {pick.meal_name}
          </div>
        </div>

        {/* Swap section directly under the header — keeps the hover targets
            at a fixed offset from the popover's top anchor, so DishMeta below
            can grow/shrink with the previewed option without shifting these
            rows under the cursor. */}
        {showSwap && (
          <div className="border-b border-[var(--color-bone)] px-1.5 py-2">
            <div className="px-1 mb-1 text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
              inne opcje na ten slot · {others.length} · kliknij aby wybrać
            </div>
            <div className="flex flex-col">
              {others.map((o) => (
                <AlternateRow
                  key={o.meal_name}
                  onPick={() => {
                    onSwap?.(o);
                    setPreviewName(null);
                    setOpen(false);
                  }}
                  onPreview={() => {
                    setPreviewName(o.meal_name);
                  }}
                  onPreviewEnd={() => {
                    setPreviewName((cur) => (cur === o.meal_name ? null : cur));
                  }}
                  option={o}
                  previewed={previewName === o.meal_name}
                />
              ))}
            </div>
          </div>
        )}

        {/* Body — shows the previewed option (or current pick). */}
        <DishMeta option={displayed} />
      </PopoverContent>
    </Popover>
  );
};
