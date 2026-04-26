"use client";

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

export interface CityOption {
  city_id: number;
  name: string;
}

export interface HeaderProps {
  cities: CityOption[];
  activeCityId: number;
  activeCityName: string;
}

function useUrlSetter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return React.useCallback(
    (patch: Record<string, string | number | undefined>) => {
      const sp = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) sp.delete(k);
        else sp.set(k, String(v));
      }
      router.push(`${pathname}?${sp.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );
}

function PickerButton({
  label,
  value,
  children,
  contentClassName,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
  contentClassName?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "group inline-flex items-center gap-2 px-2 py-1 text-[14px] text-[var(--color-ink)] hover:bg-[var(--color-oat)] rounded-sm transition-colors"
          )}
        >
          <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
            {label}
          </span>
          <span className="font-medium tnum">{value}</span>
          <span
            aria-hidden
            className="text-[var(--color-ink-3)] text-[12px] leading-none"
          >
            ↓
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className={cn("w-64 p-0", contentClassName)}
      >
        {React.cloneElement(children as React.ReactElement<{ onPick?: () => void }>, {
          onPick: () => setOpen(false),
        })}
      </PopoverContent>
    </Popover>
  );
}

export function Header({
  cities,
  activeCityId,
  activeCityName,
}: HeaderProps) {
  const setUrl = useUrlSetter();

  return (
    <header className="border-b border-[var(--color-bone)] bg-[var(--color-cream)]">
      <div className="px-5 sm:px-8 lg:px-14 h-16 flex items-center justify-between">
        <a href="/" className="inline-flex items-center select-none">
          <span className="font-display text-[18px] leading-none text-[var(--color-ink)] relative tracking-tight">
            <span className="relative">
              <span className="relative">die</span>
              <span
                aria-hidden
                className="absolute left-0 right-0 -bottom-[6px] h-[4px] bg-[var(--color-amber)]"
                style={{ width: "1.65em" }}
              />
            </span>
            <span>tlownik</span>
          </span>
        </a>

        <div className="flex items-center gap-1">
          <PickerButton label="Miasto" value={activeCityName || "Wrocław"}>
            <CityPicker
              cities={cities}
              activeId={activeCityId}
              onSelect={(id) => setUrl({ city: id })}
            />
          </PickerButton>
        </div>
      </div>
    </header>
  );
}

function CityPicker({
  cities,
  activeId,
  onSelect,
  onPick,
}: {
  cities: CityOption[];
  activeId: number;
  onSelect: (id: number) => void;
  onPick?: () => void;
}) {
  return (
    <Command>
      <CommandInput placeholder="Szukaj miasta..." />
      <CommandList>
        <CommandEmpty>Brak miast.</CommandEmpty>
        <CommandGroup heading="Miasta">
          {cities.map((c) => (
            <CommandItem
              key={c.city_id}
              value={c.name}
              onSelect={() => {
                onSelect(c.city_id);
                onPick?.();
              }}
              className="justify-between"
            >
              <span>{c.name}</span>
              {c.city_id === activeId && (
                <span className="text-[var(--color-amber)] text-[12px]">●</span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

