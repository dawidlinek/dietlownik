import { KcalRangeFilter } from "@/components/kcal-range-filter";
import { PreferenceFilter } from "@/components/preference-filter";

export interface MatchFilterStripProps {
  readonly dataMin: number;
  readonly dataMax: number;
  readonly presets: readonly number[];
  readonly activeMin: number;
  readonly activeMax: number;
  readonly dayOptions: readonly number[];
  readonly activeDays: number;
  readonly initialPrefer: readonly string[];
  readonly initialAvoid: readonly string[];
}

export const MatchFilterStrip = ({
  activeDays,
  activeMax,
  activeMin,
  dataMax,
  dataMin,
  dayOptions,
  initialAvoid,
  initialPrefer,
  presets,
}: Readonly<MatchFilterStripProps>) => (
  <div>
    <KcalRangeFilter
      activeDays={activeDays}
      activeMax={activeMax}
      activeMin={activeMin}
      dataMax={dataMax}
      dataMin={dataMin}
      dayOptions={dayOptions}
      presets={presets}
    />
    <div className="px-5 sm:px-8 lg:px-14 py-4 border-b border-[var(--color-bone)]">
      <PreferenceFilter
        initialAvoid={initialAvoid}
        initialPrefer={initialPrefer}
      />
    </div>
  </div>
);
