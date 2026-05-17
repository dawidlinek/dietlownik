"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

type Channel = "prefer" | "avoid";

interface ChipProps {
  readonly channel: Channel;
  readonly label: string;
  readonly onRemove: () => void;
}

const Chip = ({ channel, label, onRemove }: Readonly<ChipProps>) => {
  const isPrefer = channel === "prefer";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full pl-3 pr-1.5 py-0.5 text-[13px] leading-none tnum",
        isPrefer
          ? "bg-[var(--color-olive-tint)] text-[var(--color-olive)]"
          : "bg-[var(--color-clay-tint)] text-[var(--color-clay)]"
      )}
    >
      <span>{label}</span>
      <button
        aria-label={`Usuń ${label}`}
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
};

interface AddChipInputProps {
  readonly channel: Channel;
  readonly onAdd: (value: string) => void;
}

const AddChipInput = ({ channel, onAdd }: Readonly<AddChipInputProps>) => {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed) {
      onAdd(trimmed);
    }
    setValue("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-3 py-0.5 text-[12px] leading-none",
          "text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-oat)]",
          "transition-colors"
        )}
        onClick={() => {
          setOpen(true);
        }}
        type="button"
      >
        <span aria-hidden>+</span> dodaj
      </button>
    );
  }

  const isPrefer = channel === "prefer";
  return (
    <input
      aria-label={isPrefer ? "Dodaj preferencję" : "Dodaj rzecz do unikania"}
      className={cn(
        "rounded-full px-3 py-0.5 text-[13px] leading-[1.4] tnum w-[140px]",
        "bg-white border focus:outline-none",
        isPrefer
          ? "border-[var(--color-olive)] text-[var(--color-olive)] placeholder:text-[var(--color-olive)]/50"
          : "border-[var(--color-clay)] text-[var(--color-clay)] placeholder:text-[var(--color-clay)]/50"
      )}
      onBlur={commit}
      onChange={
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.ChangeEvent has DOM refs (target/currentTarget) that cannot be deeply readonly
        (e) => {
          setValue(e.target.value);
        }
      }
      onKeyDown={
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.KeyboardEvent has DOM refs that cannot be deeply readonly
        (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setValue("");
            setOpen(false);
          }
        }
      }
      placeholder={isPrefer ? "np. kurczak" : "np. pomidor"}
      ref={inputRef}
      value={value}
    />
  );
};

interface ChannelRowProps {
  readonly channel: Channel;
  readonly label: string;
  readonly values: readonly string[];
  readonly onAdd: (value: string) => void;
  readonly onRemove: (value: string) => void;
}

const ChannelRow = ({
  channel,
  label,
  onAdd,
  onRemove,
  values,
}: Readonly<ChannelRowProps>) => (
  <div className="flex flex-wrap items-center gap-2">
    <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] w-[58px] shrink-0">
      {label}
    </span>
    {values.length === 0 && (
      <span className="text-[12px] italic text-[var(--color-ink-3)]/70">
        brak
      </span>
    )}
    {values.map((v) => (
      <Chip
        channel={channel}
        key={v}
        label={v}
        onRemove={() => {
          onRemove(v);
        }}
      />
    ))}
    <AddChipInput channel={channel} onAdd={onAdd} />
  </div>
);

export interface PreferenceFilterProps {
  readonly initialPrefer: readonly string[];
  readonly initialAvoid: readonly string[];
}

type Setter = React.Dispatch<React.SetStateAction<readonly string[]>>;

const addTo = (setter: Setter) => (value: string) => {
  setter((prev) =>
    prev.includes(value.toLowerCase()) ? prev : [...prev, value.toLowerCase()]
  );
};

const removeFrom = (setter: Setter) => (value: string) => {
  setter((prev) => prev.filter((x) => x !== value));
};

export const PreferenceFilter = ({
  initialAvoid,
  initialPrefer,
}: Readonly<PreferenceFilterProps>) => {
  const [prefer, setPrefer] = React.useState<readonly string[]>(initialPrefer);
  const [avoid, setAvoid] = React.useState<readonly string[]>(initialAvoid);

  return (
    <div className="flex flex-col gap-2.5">
      <ChannelRow
        channel="prefer"
        label="prefer"
        onAdd={addTo(setPrefer)}
        onRemove={removeFrom(setPrefer)}
        values={prefer}
      />
      <ChannelRow
        channel="avoid"
        label="avoid"
        onAdd={addTo(setAvoid)}
        onRemove={removeFrom(setAvoid)}
        values={avoid}
      />
    </div>
  );
};
