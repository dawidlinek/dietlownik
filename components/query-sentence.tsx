"use client";

import * as React from "react";

import { DateRangePicker } from "@/components/date-range-picker";
import { LogoOrPlaceholder } from "@/components/exclude-filter";
import type { CateringChoice } from "@/components/exclude-filter";
import { CityPicker, useUrlSetter } from "@/components/header";
import type { CityOption } from "@/components/header";
import { KcalRangeControls } from "@/components/kcal-range-filter";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  foldKeyword,
  KEYWORD_EXAMPLES,
  matchStaticVocab,
} from "@/lib/keyword-vocab";
import type { KeywordKind, KeywordSuggestion } from "@/lib/keyword-vocab";
import { cn } from "@/lib/utils";

// The home page's filters, written as one Polish sentence:
//
//   Dieta 1500–2000 kcal we Wrocławiu, na czw 24 – pon 28 wrz.
//   Lubię [dużo białka] [kurczak] [Sam Wybór] +, unikam [psiankowate] +.
//
// Every underlined value opens its picker. Lubię/unikam take keywords and
// caterings alike: a catering in "lubię" is pinned (always loaded into the
// day's alternatives), one in "unikam" is excluded from the ranking.

type Channel = "prefer" | "avoid";

/** The four list-valued URL params the sentence edits. */
export interface FilterLists {
  readonly prefer: readonly string[];
  readonly avoid: readonly string[];
  readonly pin: readonly string[];
  readonly exclude: readonly string[];
}

// ── Grammar ────────────────────────────────────────────────────────────────

/** Locative for the cities people actually order in. Anything else falls
 *  back to "w miejscowości X", which is correct for any place name. */
const CITY_LOCATIVE: Readonly<Record<string, readonly [string, string]>> = {
  Białystok: ["w", "Białymstoku"],
  "Bielsko-Biała": ["w", "Bielsku-Białej"],
  Bydgoszcz: ["w", "Bydgoszczy"],
  Częstochowa: ["w", "Częstochowie"],
  Gdańsk: ["w", "Gdańsku"],
  Gdynia: ["w", "Gdyni"],
  Gliwice: ["w", "Gliwicach"],
  "Gorzów Wielkopolski": ["w", "Gorzowie Wielkopolskim"],
  Katowice: ["w", "Katowicach"],
  Kielce: ["w", "Kielcach"],
  Kraków: ["w", "Krakowie"],
  Lublin: ["w", "Lublinie"],
  Olsztyn: ["w", "Olsztynie"],
  Opole: ["w", "Opolu"],
  Poznań: ["w", "Poznaniu"],
  Radom: ["w", "Radomiu"],
  Rzeszów: ["w", "Rzeszowie"],
  Sopot: ["w", "Sopocie"],
  Szczecin: ["w", "Szczecinie"],
  Toruń: ["w", "Toruniu"],
  Warszawa: ["w", "Warszawie"],
  Wrocław: ["we", "Wrocławiu"],
  Zabrze: ["w", "Zabrzu"],
  "Zielona Góra": ["w", "Zielonej Górze"],
  Łódź: ["w", "Łodzi"],
};

const cityPhrase = (name: string): readonly [string, string] =>
  CITY_LOCATIVE[name] ?? ["w miejscowości", name];

const WEEKDAYS = ["nd", "pon", "wt", "śr", "czw", "pt", "sob"] as const;
const monthFmt = new Intl.DateTimeFormat("pl-PL", { month: "short" });

interface DayParts {
  readonly weekday: string;
  readonly day: number;
  readonly month: string;
}

const dayParts = (iso: string): DayParts => {
  const d = new Date(`${iso}T00:00:00`);
  return {
    day: d.getDate(),
    month: monthFmt.format(d),
    weekday: WEEKDAYS[d.getDay()],
  };
};

/** "czw 24 – pon 28 wrz" for a contiguous run of available days,
 *  "3 wybrane dni, 24–28 wrz" when the selection has gaps. */
export const summarizeDates = (
  selected: readonly string[],
  available: readonly string[]
): string => {
  if (selected.length === 0) {
    return "żadne dni";
  }
  const first = dayParts(selected[0]);
  const last = dayParts(selected.at(-1) ?? selected[0]);
  if (selected.length === 1) {
    return `${first.weekday} ${first.day} ${first.month}`;
  }
  const i0 = available.indexOf(selected[0]);
  const contiguous =
    i0 !== -1 && selected.every((d, i) => available[i0 + i] === d);
  const sameMonth = first.month === last.month;
  if (contiguous) {
    const head = sameMonth
      ? `${first.weekday} ${first.day}`
      : `${first.weekday} ${first.day} ${first.month}`;
    return `${head} – ${last.weekday} ${last.day} ${last.month}`;
  }
  const span = sameMonth
    ? `${first.day}–${last.day} ${last.month}`
    : `${first.day} ${first.month} – ${last.day} ${last.month}`;
  return `${selected.length} wybrane dni, ${span}`;
};

// ── Pieces ─────────────────────────────────────────────────────────────────

const tokenClass = cn(
  "font-medium px-0.5 border-b-2 border-dashed border-[var(--color-amber)]",
  "hover:text-[var(--color-amber-deep)] transition-colors cursor-pointer",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-amber)]"
);

const chipClass = (channel: Channel): string =>
  cn(
    "inline-flex items-center gap-1.5 rounded-full py-1 pr-1.5 align-middle",
    "font-body text-[15px] leading-[1.2] tnum",
    channel === "prefer"
      ? "bg-[var(--color-olive-tint)] text-[var(--color-olive)]"
      : "bg-[var(--color-clay-tint)] text-[var(--color-clay)]"
  );

// Glyph characters (+ × −) sit on the text baseline and drift off-centre in
// round buttons; stroked SVGs centre exactly.
const Glyph = ({
  className,
  d,
}: Readonly<{ className?: string; d: string }>) => (
  <svg
    aria-hidden
    className={cn("shrink-0", className)}
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeWidth={1.75}
    viewBox="0 0 16 16"
  >
    <path d={d} />
  </svg>
);
const PLUS = "M8 3v10M3 8h10";
const MINUS = "M3 8h10";
const CROSS = "M4.5 4.5l7 7M11.5 4.5l-7 7";

const RemoveButton = ({
  label,
  onRemove,
}: Readonly<{ label: string; onRemove: () => void }>) => (
  <button
    aria-label={`Usuń ${label}`}
    className={cn(
      "inline-flex items-center justify-center w-5 h-5 rounded-full",
      "opacity-60 hover:opacity-100",
      "hover:bg-[color-mix(in_oklch,currentColor_18%,transparent)]"
    )}
    onClick={onRemove}
    type="button"
  >
    <Glyph className="w-2.5 h-2.5" d={CROSS} />
  </button>
);

const KeywordChip = ({
  channel,
  label,
  onRemove,
}: Readonly<{ channel: Channel; label: string; onRemove: () => void }>) => (
  <span className={cn(chipClass(channel), "pl-3")}>
    <span>{label}</span>
    <RemoveButton label={label} onRemove={onRemove} />
  </span>
);

const CateringChip = ({
  catering,
  channel,
  onRemove,
}: Readonly<{
  catering: CateringChoice;
  channel: Channel;
  onRemove: () => void;
}>) => (
  <span
    className={cn(chipClass(channel), "pl-1")}
    title={
      channel === "prefer"
        ? "zawsze wczytywany do alternatyw"
        : "pominięty w rankingu"
    }
  >
    <LogoOrPlaceholder logoUrl={catering.logo_url} name={catering.name} />
    <span>{catering.name}</span>
    <RemoveButton label={catering.name} onRemove={onRemove} />
  </span>
);

// ── Add popover: keyword or catering ───────────────────────────────────────

interface AddPopoverProps {
  readonly channel: Channel;
  readonly empty: boolean;
  readonly caterings: readonly CateringChoice[];
  readonly lists: FilterLists;
  /** company_id → number of plan days it currently covers. */
  readonly planDays: ReadonlyMap<string, number>;
  readonly onAddKeyword: (keyword: string) => void;
  readonly onPickCatering: (companyId: string) => void;
}

const MAX_CATERINGS_SHOWN = 40;

const daysWord = (n: number): string => (n === 1 ? "dzień" : "dni");

const cateringMeta = (
  channel: Channel,
  id: string,
  lists: FilterLists,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ReadonlyMap already conveys read-only intent
  planDays: ReadonlyMap<string, number>
): Readonly<{ text: string; tone: string }> | null => {
  const own = channel === "prefer" ? lists.pin : lists.exclude;
  const other = channel === "prefer" ? lists.exclude : lists.pin;
  if (own.includes(id)) {
    return { text: "dodany — usuń", tone: "text-[var(--color-ink-3)]" };
  }
  if (other.includes(id)) {
    return {
      text: `w ${channel === "prefer" ? "unikam" : "lubię"} — przeniesie`,
      tone:
        channel === "prefer"
          ? "text-[var(--color-clay)]"
          : "text-[var(--color-olive)]",
    };
  }
  const n = planDays.get(id);
  if (n !== undefined && n > 0) {
    return {
      text: `w planie · ${n} ${daysWord(n)}`,
      tone: "text-[var(--color-ink-3)]",
    };
  }
  return null;
};

const KEYWORD_DEBOUNCE_MS = 180;

/** Static vocabulary matches instantly, then `/api/keywords` (allergens,
 *  macros, categories + ingredient names from the menus) once the user
 *  pauses typing. */
const useKeywordSuggestions = (query: string): readonly KeywordSuggestion[] => {
  const [remote, setRemote] = React.useState<
    Readonly<{ q: string; items: readonly KeywordSuggestion[] }>
  >({ items: [], q: "" });
  React.useEffect(() => {
    const q = query.trim();
    if (q === "") {
      return () => {
        // nothing to fetch
      };
    }
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/keywords?q=${encodeURIComponent(q)}`, {
            signal: ctrl.signal,
          });
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape set by /api/keywords
          const json = (await res.json()) as {
            suggestions?: readonly KeywordSuggestion[];
          };
          setRemote({ items: json.suggestions ?? [], q });
        } catch {
          // aborted by the next keystroke, or the route is down — the
          // static matches below still cover allergens and macros
        }
      })();
    }, KEYWORD_DEBOUNCE_MS);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [query]);

  return React.useMemo(() => {
    const q = query.trim();
    if (q === "") {
      return [];
    }
    const out = [...matchStaticVocab(q)];
    if (remote.q === q) {
      const seen = new Set(out.map((s) => s.label));
      for (const s of remote.items) {
        if (!seen.has(s.label)) {
          seen.add(s.label);
          out.push(s);
        }
      }
    }
    return out;
  }, [query, remote]);
};

const keywordMeta = (
  channel: Channel,
  label: string,
  lists: FilterLists,
  kind: KeywordKind | null
): Readonly<{ text: string; tone: string }> | null => {
  const own = channel === "prefer" ? lists.prefer : lists.avoid;
  const other = channel === "prefer" ? lists.avoid : lists.prefer;
  if (own.includes(label)) {
    return { text: "dodane", tone: "text-[var(--color-ink-3)]" };
  }
  if (other.includes(label)) {
    return {
      text: `w ${channel === "prefer" ? "unikam" : "lubię"} — przeniesie`,
      tone:
        channel === "prefer"
          ? "text-[var(--color-clay)]"
          : "text-[var(--color-olive)]",
    };
  }
  if (kind === null) {
    return { text: "dopasuj w menu", tone: "text-[var(--color-ink-3)]" };
  }
  return {
    text: kind,
    tone: "text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]",
  };
};

const KeywordItem = ({
  channel,
  kind,
  label,
  lists,
  onSelect,
  quoted = false,
}: Readonly<{
  channel: Channel;
  kind: KeywordKind | null;
  label: string;
  lists: FilterLists;
  onSelect: () => void;
  quoted?: boolean;
}>) => {
  const meta = keywordMeta(channel, label, lists, kind);
  return (
    <CommandItem className="gap-2.5" onSelect={onSelect} value={`kw:${label}`}>
      <span
        className={cn(
          "w-6 flex justify-center",
          channel === "prefer"
            ? "text-[var(--color-olive)]"
            : "text-[var(--color-clay)]"
        )}
      >
        <Glyph className="w-3 h-3" d={channel === "prefer" ? PLUS : MINUS} />
      </span>
      <span className="flex-1 truncate">{quoted ? `„${label}”` : label}</span>
      {meta !== null && (
        <span className={cn("text-[11px] shrink-0", meta.tone)}>
          {meta.text}
        </span>
      )}
    </CommandItem>
  );
};

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- props carry a ReadonlyMap which already conveys read-only intent
const AddPopover = ({
  caterings,
  channel,
  empty,
  lists,
  onAddKeyword,
  onPickCatering,
  planDays,
}: Readonly<AddPopoverProps>) => {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const trimmed = query.trim();
  const suggestions = useKeywordSuggestions(query);

  // Caterings with context — already in a list, or in the current plan —
  // float to the top; the rest keep their alphabetical order.
  const matches = React.useMemo(() => {
    const q = foldKeyword(trimmed);
    const hits =
      q === ""
        ? caterings
        : caterings.filter((c) => foldKeyword(c.name).includes(q));
    const known = (id: string): number =>
      lists.pin.includes(id) || lists.exclude.includes(id) || planDays.has(id)
        ? 0
        : 1;
    return hits.toSorted((a, b) => known(a.company_id) - known(b.company_id));
  }, [caterings, lists, planDays, trimmed]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const add = (kw: string) => {
    onAddKeyword(kw);
    close();
  };

  const isPrefer = channel === "prefer";
  const label = isPrefer ? "lubię" : "unikam";
  // The typed text is always addable as-is — unless a suggestion spells it
  // exactly, in which case that (tagged) row stands in for it.
  const typedIsSuggested = suggestions.some(
    (s) => foldKeyword(s.label) === foldKeyword(trimmed)
  );

  return (
    <Popover
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setQuery("");
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <button
          aria-label={`Dodaj do ${label}`}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 h-7 rounded-full align-middle",
            "font-body leading-none border border-dashed transition-colors",
            empty ? "px-3" : "w-7",
            isPrefer
              ? "border-[var(--color-olive)] text-[var(--color-olive)] data-[state=open]:bg-[var(--color-olive-tint)]"
              : "border-[var(--color-clay)] text-[var(--color-clay)] data-[state=open]:bg-[var(--color-clay-tint)]"
          )}
          type="button"
        >
          <Glyph className="w-3 h-3" d={PLUS} />
          {empty && <span className="text-[13px]">dodaj</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[380px] p-0">
        <Command loop shouldFilter={false}>
          <CommandInput
            onValueChange={setQuery}
            placeholder={
              isPrefer
                ? "np. dużo białka, łosoś, ryby, Maczfit…"
                : "np. gluten, psiankowate, cebula, Maczfit…"
            }
            value={query}
          />
          <CommandList className="max-h-[360px]">
            {trimmed === "" ? (
              <CommandGroup heading="przykłady">
                <p className="px-2 pb-1.5 text-[11px] leading-[1.45] text-[var(--color-ink-3)]">
                  Składnik, alergen, kategoria albo makro — albo nazwa
                  cateringu.
                </p>
                {KEYWORD_EXAMPLES[channel].map((ex) => (
                  <KeywordItem
                    channel={channel}
                    key={ex.label}
                    kind={ex.kind}
                    label={ex.label}
                    lists={lists}
                    onSelect={() => {
                      add(ex.label);
                    }}
                  />
                ))}
              </CommandGroup>
            ) : (
              <CommandGroup heading="słowa kluczowe">
                {!typedIsSuggested && (
                  <KeywordItem
                    channel={channel}
                    kind={null}
                    label={trimmed}
                    lists={lists}
                    onSelect={() => {
                      add(trimmed);
                    }}
                    quoted
                  />
                )}
                {suggestions.map((sug) => (
                  <KeywordItem
                    channel={channel}
                    key={sug.label}
                    kind={sug.kind}
                    label={sug.label}
                    lists={lists}
                    onSelect={() => {
                      add(sug.label);
                    }}
                  />
                ))}
              </CommandGroup>
            )}
            {matches.length > 0 && (
              <CommandGroup heading={`cateringi · ${matches.length}`}>
                {matches.slice(0, MAX_CATERINGS_SHOWN).map((c) => {
                  const meta = cateringMeta(
                    channel,
                    c.company_id,
                    lists,
                    planDays
                  );
                  return (
                    <CommandItem
                      className="gap-2.5"
                      key={c.company_id}
                      onSelect={() => {
                        onPickCatering(c.company_id);
                        close();
                      }}
                      value={`c:${c.company_id}`}
                    >
                      <LogoOrPlaceholder logoUrl={c.logo_url} name={c.name} />
                      <span className="flex-1 truncate">{c.name}</span>
                      {meta !== null && (
                        <span className={cn("text-[11px] shrink-0", meta.tone)}>
                          {meta.text}
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
                {matches.length > MAX_CATERINGS_SHOWN && (
                  <div className="px-2 py-1.5 text-[12px] text-[var(--color-ink-3)]">
                    i {matches.length - MAX_CATERINGS_SHOWN} więcej — zawęź
                    wyszukiwanie
                  </div>
                )}
              </CommandGroup>
            )}
          </CommandList>
          <p className="border-t border-[var(--color-bone)] px-3 py-2 text-[11px] leading-[1.45] text-[var(--color-ink-3)]">
            Catering w <span className="text-[var(--color-olive)]">lubię</span>{" "}
            zawsze trafia do alternatyw dnia, w{" "}
            <span className="text-[var(--color-clay)]">unikam</span> znika z
            rankingu.
          </p>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

// ── Suggestions ─────────────────────────────────────────────────────────────

/** Keywords that route to a real channel (macro, allergen, category). */
const SUGGEST_PREFER = [
  "dużo białka",
  "dużo błonnika",
  "mało cukru",
  "mało tłuszczu",
  "ryby",
] as const;
const SUGGEST_AVOID = [
  "nabiał",
  "gluten",
  "strączkowe",
  "owoce morza",
  "psiankowate",
] as const;
const SUGGESTIONS_PER_CHANNEL = 3;

// ── Sentence ───────────────────────────────────────────────────────────────

export interface QuerySentenceProps {
  readonly cities: readonly CityOption[];
  readonly cityId: number;
  readonly cityName: string;
  readonly kcalMin: number;
  readonly kcalMax: number;
  readonly dataMin: number;
  readonly dataMax: number;
  readonly presets: readonly number[];
  readonly availableDates: readonly string[];
  readonly selectedDates: readonly string[];
  readonly onDatesChange: (next: readonly string[]) => void;
  readonly caterings: readonly CateringChoice[];
  readonly lists: FilterLists;
  /** Writes any subset of the four lists in one URL update — moving a
   *  catering from "unikam" to "lubię" touches two params at once. */
  readonly onListsChange: (patch: Partial<FilterLists>) => void;
  readonly planDays: ReadonlyMap<string, number>;
}

const without = (xs: readonly string[], x: string): readonly string[] =>
  xs.filter((v) => v !== x);

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- props carry a ReadonlyMap which already conveys read-only intent
export const QuerySentence = ({
  availableDates,
  caterings,
  cities,
  cityId,
  cityName,
  dataMax,
  dataMin,
  kcalMax,
  kcalMin,
  lists,
  onDatesChange,
  onListsChange,
  planDays,
  presets,
  selectedDates,
}: Readonly<QuerySentenceProps>) => {
  const setUrl = useUrlSetter();
  const [cityOpen, setCityOpen] = React.useState(false);

  const byId = React.useMemo(
    () => new Map(caterings.map((c) => [c.company_id, c])),
    [caterings]
  );

  const addKeyword = (channel: Channel, raw: string) => {
    const kw = raw.toLocaleLowerCase("pl-PL");
    const own = channel === "prefer" ? lists.prefer : lists.avoid;
    if (own.includes(kw)) {
      return;
    }
    onListsChange(
      channel === "prefer"
        ? { avoid: without(lists.avoid, kw), prefer: [...lists.prefer, kw] }
        : { avoid: [...lists.avoid, kw], prefer: without(lists.prefer, kw) }
    );
  };

  const pickCatering = (channel: Channel, id: string) => {
    const own = channel === "prefer" ? lists.pin : lists.exclude;
    if (own.includes(id)) {
      onListsChange(
        channel === "prefer"
          ? { pin: without(lists.pin, id) }
          : { exclude: without(lists.exclude, id) }
      );
      return;
    }
    onListsChange(
      channel === "prefer"
        ? { exclude: without(lists.exclude, id), pin: [...lists.pin, id] }
        : { exclude: [...lists.exclude, id], pin: without(lists.pin, id) }
    );
  };

  const [prep, place] = cityPhrase(cityName);
  const kcalLabel =
    kcalMin === kcalMax ? `${kcalMin} kcal` : `${kcalMin}–${kcalMax} kcal`;

  /** `trailing` (the comma or full stop after the list) rides in the same
   *  no-wrap span as the last chip and the "+", so neither the button nor
   *  the punctuation can wrap onto a line of its own. */
  const channelChips = (channel: Channel, trailing: string) => {
    const keywords = channel === "prefer" ? lists.prefer : lists.avoid;
    const ids = channel === "prefer" ? lists.pin : lists.exclude;
    const chips = [
      ...keywords.map((k) => (
        <KeywordChip
          channel={channel}
          key={`kw:${k}`}
          label={k}
          onRemove={() => {
            onListsChange(
              channel === "prefer"
                ? { prefer: without(lists.prefer, k) }
                : { avoid: without(lists.avoid, k) }
            );
          }}
        />
      )),
      ...ids.flatMap((id) => {
        const c = byId.get(id);
        if (c === undefined) {
          return [];
        }
        return [
          <CateringChip
            catering={c}
            channel={channel}
            key={`c:${id}`}
            onRemove={() => {
              pickCatering(channel, id);
            }}
          />,
        ];
      }),
    ];
    return (
      <>
        {/* oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- JSX elements cannot be deeply readonly */}
        {chips.slice(0, -1).map((chip) => (
          <React.Fragment key={chip.key}>{chip} </React.Fragment>
        ))}
        <span className="whitespace-nowrap">
          {chips.at(-1)}
          {chips.length > 0 && " "}
          <AddPopover
            caterings={caterings}
            channel={channel}
            empty={chips.length === 0}
            lists={lists}
            onAddKeyword={(kw) => {
              addKeyword(channel, kw);
            }}
            onPickCatering={(id) => {
              pickCatering(channel, id);
            }}
            planDays={planDays}
          />
          {trailing}
        </span>
      </>
    );
  };

  const taken = new Set([...lists.prefer, ...lists.avoid]);
  const suggestPrefer = SUGGEST_PREFER.filter((s) => !taken.has(s)).slice(
    0,
    SUGGESTIONS_PER_CHANNEL
  );
  const suggestAvoid = SUGGEST_AVOID.filter((s) => !taken.has(s)).slice(
    0,
    SUGGESTIONS_PER_CHANNEL
  );

  return (
    <div className="flex flex-col gap-5 min-w-0">
      <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-3)]">
        czego szukam
      </span>
      <p className="m-0 font-display text-[22px] sm:text-[26px] lg:text-[30px] leading-[1.6] text-[var(--color-ink)] text-pretty">
        Dieta{"\u00A0"}
        <Popover>
          <PopoverTrigger asChild>
            <button className={cn(tokenClass, "tnum")} type="button">
              {kcalLabel}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-3">
            <KcalRangeControls
              activeMax={kcalMax}
              activeMin={kcalMin}
              className="flex flex-col gap-3"
              dataMax={dataMax}
              dataMin={dataMin}
              presets={presets}
            />
          </PopoverContent>
        </Popover>{" "}
        {prep}
        {"\u00A0"}
        <Popover onOpenChange={setCityOpen} open={cityOpen}>
          <PopoverTrigger asChild>
            <button className={tokenClass} type="button">
              {place}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-0">
            <CityPicker
              activeId={cityId}
              cities={cities}
              onPick={() => {
                setCityOpen(false);
              }}
              onSelect={(id) => {
                setUrl({ city: id });
              }}
            />
          </PopoverContent>
        </Popover>
        , na{"\u00A0"}
        <DateRangePicker
          availableDates={availableDates}
          onChange={onDatesChange}
          selectedDates={selectedDates}
          trigger={
            <button className={cn(tokenClass, "tnum")} type="button">
              {summarizeDates(selectedDates, availableDates)}
            </button>
          }
        />
        . Lubię {channelChips("prefer", ",")} unikam{" "}
        {channelChips("avoid", ".")}
      </p>
      {(suggestPrefer.length > 0 || suggestAvoid.length > 0) && (
        <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5">
          <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-3)]">
            często
          </span>
          {suggestPrefer.map((s) => (
            <button
              className="text-[13px] text-[var(--color-olive)] hover:underline underline-offset-2"
              key={`p:${s}`}
              onClick={() => {
                addKeyword("prefer", s);
              }}
              type="button"
            >
              + {s}
            </button>
          ))}
          {suggestAvoid.map((s) => (
            <button
              className="text-[13px] text-[var(--color-clay)] hover:underline underline-offset-2"
              key={`a:${s}`}
              onClick={() => {
                addKeyword("avoid", s);
              }}
              type="button"
            >
              − {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
