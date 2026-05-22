"use client";

import * as React from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  cateringInitials,
  cateringPlaceholderColor,
  hasRenderableLogo,
  isLogoFailed,
  markLogoFailed,
} from "@/lib/catering-initials";
import { cn } from "@/lib/utils";

export interface CateringChoice {
  readonly company_id: string;
  readonly name: string;
  readonly logo_url: string | null;
}

/** 24px placeholder circle stamped with the catering's initials. The
 *  background is a soft hashed tint derived from the name — same name
 *  always renders the same color, so a given catering looks visually
 *  consistent across the picker list and the scatter marker. */
const LogoPlaceholder = ({ name }: Readonly<{ name: string }>) => {
  const { bg, fg } = cateringPlaceholderColor(name);
  return (
    <span
      aria-hidden
      className={cn(
        "w-6 h-6 rounded-full shrink-0 flex items-center justify-center",
        "text-[9px] font-medium tracking-[0.04em]"
      )}
      style={{ backgroundColor: bg, color: fg }}
    >
      {cateringInitials(name)}
    </span>
  );
};

/** Picks between the catering's <img> logo and the initials placeholder.
 *  When the URL is malformed or has previously failed to load, render the
 *  placeholder straight away; when the URL looks plausible we try the
 *  image and demote it to a placeholder on `onError`. */
const LogoOrPlaceholder = ({
  logoUrl,
  name,
}: Readonly<{ logoUrl: string | null; name: string }>) => {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const tryImage = hasRenderableLogo(logoUrl) && !isLogoFailed(logoUrl);
  if (!tryImage) {
    return <LogoPlaceholder name={name} />;
  }
  return (
    // oxlint-disable-next-line @next/next/no-img-element -- ml-assets.com isn't whitelisted in next.config and these are external logos
    <img
      alt=""
      className="w-6 h-6 rounded-full object-contain bg-white shrink-0"
      onError={() => {
        markLogoFailed(logoUrl);
        forceUpdate();
      }}
      src={logoUrl}
    />
  );
};

interface ExcludeChipProps {
  readonly name: string;
  readonly onRemove: () => void;
}

const ExcludeChip = ({ name, onRemove }: Readonly<ExcludeChipProps>) => (
  <span
    className={cn(
      "inline-flex items-center gap-1.5 rounded-full pl-3 pr-1.5 py-0.5 text-[13px] leading-none tnum",
      "bg-[var(--color-bone)] text-[var(--color-ink-2)]"
    )}
  >
    <span>{name}</span>
    <button
      aria-label={`Przestań wykluczać ${name}`}
      className={cn(
        "inline-flex items-center justify-center w-4 h-4 rounded-full",
        "text-[10px] leading-none opacity-60 hover:opacity-100",
        "hover:bg-[color-mix(in_oklch,currentColor_18%,transparent)]",
        "transition-opacity"
      )}
      onClick={onRemove}
      type="button"
    >
      ×
    </button>
  </span>
);

const folded = (s: string): string =>
  s
    .toLocaleLowerCase("pl-PL")
    .normalize("NFD")
    // oxlint-disable-next-line regexp/no-misleading-unicode-character -- diacritic strip via combining-marks block
    .replaceAll(/[̀-ͯ]/gu, "");

interface PickerProps {
  readonly available: readonly CateringChoice[];
  readonly excludedIds: readonly string[];
  readonly onToggle: (companyId: string) => void;
}

const Picker = ({
  available,
  excludedIds,
  onToggle,
}: Readonly<PickerProps>) => {
  const [query, setQuery] = React.useState("");
  const excludedSet = React.useMemo(() => new Set(excludedIds), [excludedIds]);
  const visible = React.useMemo(() => {
    const q = folded(query.trim());
    if (q === "") {
      return available;
    }
    return available.filter((c) => folded(c.name).includes(q));
  }, [available, query]);

  return (
    <div className="flex flex-col">
      <div className="px-2.5 pt-2 pb-1.5 border-b border-[var(--color-bone)]">
        <input
          aria-label="Szukaj cateringu"
          autoFocus
          className={cn(
            "w-full px-2 py-1 text-[13px] rounded-md bg-white border",
            "border-[var(--color-bone)] focus:outline-none",
            "focus:border-[var(--color-ink-3)] placeholder:text-[var(--color-ink-3)]/60"
          )}
          // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.ChangeEvent has DOM refs (target/currentTarget) that cannot be deeply readonly
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          placeholder="szukaj…"
          value={query}
        />
      </div>
      <div className="max-h-[280px] overflow-y-auto py-1">
        {visible.length === 0 ? (
          <div className="px-3 py-3 text-[12px] italic text-[var(--color-ink-3)]/70">
            nic nie znaleziono
          </div>
        ) : (
          visible.map((c) => {
            const isExcluded = excludedSet.has(c.company_id);
            return (
              <button
                aria-pressed={isExcluded}
                className={cn(
                  "w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left",
                  "text-[13px] text-[var(--color-ink-2)]",
                  "hover:bg-[var(--color-oat)] transition-colors"
                )}
                key={c.company_id}
                onClick={() => {
                  onToggle(c.company_id);
                }}
                type="button"
              >
                <span
                  className={cn(
                    "inline-flex items-center justify-center w-4 h-4 rounded-sm border shrink-0",
                    isExcluded
                      ? "bg-[var(--color-ink-2)] border-[var(--color-ink-2)] text-white"
                      : "bg-white border-[var(--color-bone)]"
                  )}
                >
                  {isExcluded && (
                    <span aria-hidden className="text-[10px] leading-none">
                      ✓
                    </span>
                  )}
                </span>
                <LogoOrPlaceholder logoUrl={c.logo_url} name={c.name} />

                <span className="flex-1 truncate">{c.name}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

export interface ExcludeFilterProps {
  readonly availableCaterings: readonly CateringChoice[];
  readonly excludedIds: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
}

export const ExcludeFilter = ({
  availableCaterings,
  excludedIds,
  onChange,
}: Readonly<ExcludeFilterProps>) => {
  const [open, setOpen] = React.useState(false);
  const lookup = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const c of availableCaterings) {
      m.set(c.company_id, c.name);
    }
    return m;
  }, [availableCaterings]);

  const handleToggle = (companyId: string): void => {
    if (excludedIds.includes(companyId)) {
      onChange(excludedIds.filter((x) => x !== companyId));
    } else {
      onChange([...excludedIds, companyId]);
    }
  };

  return (
    // min-h matches the chip height so this row's vertical rhythm matches the
    // sibling PreferenceFilter rows above (lubię / unikam).
    <div className="flex min-h-[26px] flex-wrap items-center gap-2">
      <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] w-[58px] shrink-0">
        wyklucz
      </span>
      {excludedIds.length === 0 && (
        <span className="text-[12px] italic text-[var(--color-ink-3)]/70">
          brak
        </span>
      )}
      {excludedIds.map((id) => (
        <ExcludeChip
          key={id}
          name={lookup.get(id) ?? id}
          onRemove={() => {
            onChange(excludedIds.filter((x) => x !== id));
          }}
        />
      ))}
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <button
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-3 py-0.5 text-[12px] leading-none",
              "text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-oat)]",
              "transition-colors"
            )}
            type="button"
          >
            <span aria-hidden>+</span> dodaj
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[320px] p-0">
          <Picker
            available={availableCaterings}
            excludedIds={excludedIds}
            onToggle={handleToggle}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
};
