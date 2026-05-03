// Refresh the Cloudflare session used by `scraper/api.ts`.
//
// Usage (recommended): solve the CF challenge in your browser, then in
// DevTools → Network → right-click any request to aplikacja.dietly.pl →
// "Copy as cURL", and pipe it into this script:
//
//   pbpaste | bun scraper/scripts/cf-session.ts
//   # or:  bun scraper/scripts/cf-session.ts < curl.txt
//
// Direct override (skip the parser):
//
//   bun scraper/scripts/cf-session.ts --cookie 'cf_clearance=...; __cf_bm=...' \
//     --ua 'Mozilla/5.0 ...'
//
// The session lands at `.cf-session.json` (gitignored). The scraper picks it
// up automatically. `cf_clearance` is bound to {IP, User-Agent} — if your
// public IP changes, refresh the session.

import { writeCfSession } from "../cf-shared";

interface ParsedCurl {
  cookie?: string;
  userAgent?: string;
  headers: Record<string, string>;
}

/**
 * Tokenize a shell-ish cURL command. Quote-aware (handles `'...'` and
 * `"..."`), folds `\\\n` line continuations, and otherwise splits on
 * whitespace. Not a full POSIX parser — just enough for "Copy as cURL".
 */
export const tokenize = (input: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote !== null) {
      if (
        ch === "\\" &&
        i + 1 < input.length &&
        (input[i + 1] === quote || input[i + 1] === "\\")
      ) {
        cur += input[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && input[i + 1] === "\n") {
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur !== "") {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur !== "") {
    out.push(cur);
  }
  return out;
};

export const parseCurl = (input: string): ParsedCurl => {
  const tokens = tokenize(input);
  const headers: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === "-H" || t === "--header") {
      i += 1;
      const v = tokens[i];
      if (v === undefined || v === "") {
        continue;
      }
      const idx = v.indexOf(":");
      if (idx === -1) {
        continue;
      }
      const name = v.slice(0, idx).trim().toLowerCase();
      headers[name] = v.slice(idx + 1).trim();
    } else if (t === "-A" || t === "--user-agent") {
      i += 1;
      const v = tokens[i];
      if (v !== undefined && v !== "") {
        headers["user-agent"] = v;
      }
    } else if (t === "-b" || t === "--cookie") {
      i += 1;
      const v = tokens[i];
      if (v !== undefined && v !== "") {
        headers.cookie = v;
      }
    }
  }
  return {
    cookie: headers.cookie,
    headers,
    userAgent: headers["user-agent"],
  };
};

const parseFlags = (
  argv: readonly string[]
): {
  cookie?: string;
  ua?: string;
  help: boolean;
} => {
  const out: { cookie?: string; ua?: string; help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--cookie") {
      i += 1;
      out.cookie = argv[i];
    } else if (a === "--ua" || a === "--user-agent") {
      i += 1;
      out.ua = argv[i];
    } else if (a === "-h" || a === "--help") {
      out.help = true;
    }
  }
  return out;
};

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) {
    // oxlint-disable-next-line typescript/no-unsafe-argument -- Buffer.from accepts Uint8Array | string | Buffer; iterator yields Uint8Array
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks).toString("utf-8");
};

const HELP = `Usage:
  pbpaste | bun scraper/scripts/cf-session.ts
  bun scraper/scripts/cf-session.ts < curl.txt
  bun scraper/scripts/cf-session.ts --cookie '...' --ua '...'

Writes ./.cf-session.json (gitignored). The scraper reads it on startup.`;

const main = async (): Promise<void> => {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return;
  }

  let { cookie } = flags;
  let userAgent = flags.ua;

  const cookieMissing = cookie === undefined || cookie === "";
  const uaMissing = userAgent === undefined || userAgent === "";
  if (cookieMissing || uaMissing) {
    const stdin = await readStdin();
    if (stdin.trim() !== "") {
      const parsed = parseCurl(stdin);
      cookie ??= parsed.cookie;
      userAgent ??= parsed.userAgent;
    }
  }

  if (cookie === undefined || cookie === "") {
    if (userAgent === undefined || userAgent === "") {
      console.error("cf-session: no cookie or user-agent found.\n");
      console.error(HELP);
      process.exit(1);
    }
    console.error(
      "cf-session: cookie missing — `cf_clearance` is required to bypass the challenge."
    );
    process.exit(1);
  }
  if (userAgent === undefined || userAgent === "") {
    console.error(
      "cf-session: user-agent missing — cf_clearance is bound to UA, send the same one your browser used."
    );
    process.exit(1);
  }

  if (!cookie.includes("cf_clearance=")) {
    console.error(
      "cf-session: warning — cookie has no `cf_clearance`. CF will likely still challenge."
    );
  }

  const path = writeCfSession({ cookie, userAgent });
  const cookieNames = cookie
    .split(";")
    .map((s) => s.split("=")[0].trim())
    .filter((s) => s !== "");
  console.log(`wrote ${path}`);
  console.log(`  cookies: ${cookieNames.join(", ")}`);
  console.log(`  user-agent: ${userAgent}`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- top-level entry point
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
