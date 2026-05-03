import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

/**
 * Strategy: extend ultracite's strict preset, then turn OFF cosmetic rules
 * that don't fit this codebase. Real-correctness rules (eqeqeq, no-deprecated,
 * no-floating-promises, use-unknown-in-catch-callback-variable,
 * strict-void-return, no-unnecessary-type-conversion) stay ON and are fixed
 * in source.
 */
export default defineConfig({
  extends: [core],
  ignorePatterns: [
    ".agents/",
    ".claude/",
    ".next/",
    ".wrangler/",
    ".playwright-cli/",
    "db/migrate.js",
    "db/migrate_v*.js",
  ],
  options: {
    typeAware: true,
    typeCheck: true,
  },
  rules: {
    // ── eqeqeq with `== null` allowed (idiomatic null+undefined check) ──
    eqeqeq: ["error", "always", { null: "ignore" }],

    // ── Cosmetic / preference — disabled ──────────────────────────────
    "func-style": "off", // function declarations are fine; arrow vs decl is style
    "no-inline-comments": "off", // we use them productively
    "no-plusplus": "off", // i++ is idiomatic
    "no-eq-null": "off", // overlaps with eqeqeq (kept on)
    "no-negated-condition": "off", // sometimes negated reads better
    "no-promise-executor-return": "off", // false positives in our small adapters
    "prefer-destructuring": "off", // not always clearer
    "no-empty-function": "off",
    "consistent-type-imports": "off", // we mix; both work
    "promise/prefer-await-to-then": "off", // some chains are clearer with .then/.catch
    "promise/prefer-await-to-callbacks": "off", // ditto for node-style callbacks at edges
    "promise/avoid-new": "off", // new Promise() is sometimes the right tool
    "unicorn/filename-case": "off", // mcp/tools/* uses snake_case to match MCP tool names

    // ── TS strictness we don't want enforced project-wide ─────────────
    "typescript/strict-boolean-expressions": "off", // 80+ false-positive-flavoured hits
    "typescript/no-unsafe-type-assertion": "off", // SDK interop needs `as Foo`
    "typescript/no-non-null-assertion": "off", // we use `!` after schema-level guards
    "typescript/parameter-properties": "off", // TS shorthand is fine

    // ── Lint-stage `require-await` is too aggressive for our async wrappers ──
    "require-await": "off",

    // ── Hoisting style — TS already catches the dangerous cases ───────
    "no-use-before-define": "off",

    // ── Stylistic / preference (long tail) ────────────────────────────
    "sort-keys": "off", // we keep intentional grouping (config files etc.)
    complexity: "off", // scrapers have legitimately complex parsers
    "max-classes-per-file": "off",
    "no-nested-ternary": "off",
    "no-shadow": "off", // outer/inner same-name is occasionally clearer
    "class-methods-use-this": "off", // private helpers without this are fine
    "unicorn/prefer-module": "off", // __dirname via path.resolve in node configs
    "unicorn/no-array-reduce": "off",
    "unicorn/prefer-ternary": "off",
    "unicorn/no-nested-ternary": "off",
    "unicorn/no-await-expression-member": "off",
    "unicorn/no-immediate-mutation": "off",
    "unicorn/no-lonely-if": "off",
    "promise/param-names": "off", // (r), (resolve) both fine for short scopes
    "import/no-named-as-default-member": "off", // pg's CJS interop shape

    // ── TS strictness deferred (real value but not the priority pass) ──
    "typescript/no-unsafe-return": "off",
    "typescript/no-unsafe-argument": "off",
    "typescript/no-unsafe-assignment": "off",
    "typescript/promise-function-async": "off",
  },
});
