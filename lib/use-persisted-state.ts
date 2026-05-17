import * as React from "react";

/**
 * `useState` that also reads from and writes to `localStorage`. SSR-safe — the
 * initial render returns `defaultValue` and the hook hydrates from storage on
 * first effect run.
 *
 * Failures (storage disabled, JSON parse errors) are swallowed silently so the
 * hook never crashes the app — at worst the user loses persistence.
 */
export const usePersistedState = <T>(
  key: string,
  defaultValue: T
): [T, React.Dispatch<React.SetStateAction<T>>] => {
  const [value, setValue] = React.useState<T>(defaultValue);
  const hydratedRef = React.useRef(false);

  // Hydrate from storage on mount.
  React.useEffect(() => {
    if (hydratedRef.current) {
      return;
    }
    hydratedRef.current = true;
    try {
      const stored = globalThis.localStorage?.getItem(key);
      if (stored !== null && stored !== undefined) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic persisted state intentionally trusts the storage payload shape; callers own the schema
        const parsed = JSON.parse(stored) as T;
        setValue(parsed);
      }
    } catch {
      // ignore — keep defaultValue
    }
  }, [key]);

  // Persist on change (but skip the initial render before hydration so we
  // don't overwrite the stored value with the default).
  React.useEffect(() => {
    if (!hydratedRef.current) {
      return;
    }
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
  }, [key, value]);

  return [value, setValue];
};
