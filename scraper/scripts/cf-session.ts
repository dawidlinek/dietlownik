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

import { writeCfSession } from '../cf-shared.js';

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
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === '\\' && i + 1 < input.length && (input[i + 1] === quote || input[i + 1] === '\\')) {
        cur += input[i + 1];
        i++;
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
    if (ch === '\\' && input[i + 1] === '\n') {
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function parseCurl(input: string): ParsedCurl {
  const tokens = tokenize(input);
  const headers: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-H' || t === '--header') {
      const v = tokens[++i];
      if (!v) continue;
      const idx = v.indexOf(':');
      if (idx < 0) continue;
      const name = v.slice(0, idx).trim().toLowerCase();
      headers[name] = v.slice(idx + 1).trim();
    } else if (t === '-A' || t === '--user-agent') {
      const v = tokens[++i];
      if (v) headers['user-agent'] = v;
    } else if (t === '-b' || t === '--cookie') {
      const v = tokens[++i];
      if (v) headers['cookie'] = v;
    }
  }
  return { cookie: headers['cookie'], userAgent: headers['user-agent'], headers };
}

function parseFlags(argv: string[]): { cookie?: string; ua?: string; help: boolean } {
  const out: { cookie?: string; ua?: string; help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cookie') out.cookie = argv[++i];
    else if (a === '--ua' || a === '--user-agent') out.ua = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

const HELP = `Usage:
  pbpaste | bun scraper/scripts/cf-session.ts
  bun scraper/scripts/cf-session.ts < curl.txt
  bun scraper/scripts/cf-session.ts --cookie '...' --ua '...'

Writes ./.cf-session.json (gitignored). The scraper reads it on startup.`;

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return;
  }

  let cookie = flags.cookie;
  let userAgent = flags.ua;

  if (!cookie || !userAgent) {
    const stdin = await readStdin();
    if (stdin.trim()) {
      const parsed = parseCurl(stdin);
      cookie ??= parsed.cookie;
      userAgent ??= parsed.userAgent;
    }
  }

  if (!cookie && !userAgent) {
    console.error('cf-session: no cookie or user-agent found.\n');
    console.error(HELP);
    process.exit(1);
  }
  if (!cookie) {
    console.error('cf-session: cookie missing — `cf_clearance` is required to bypass the challenge.');
    process.exit(1);
  }
  if (!userAgent) {
    console.error('cf-session: user-agent missing — cf_clearance is bound to UA, send the same one your browser used.');
    process.exit(1);
  }

  if (!/cf_clearance=/.test(cookie)) {
    console.error('cf-session: warning — cookie has no `cf_clearance`. CF will likely still challenge.');
  }

  const path = writeCfSession({ cookie, userAgent });
  const cookieNames = cookie.split(';').map(s => s.split('=')[0].trim()).filter(Boolean);
  console.log(`wrote ${path}`);
  console.log(`  cookies: ${cookieNames.join(', ')}`);
  console.log(`  user-agent: ${userAgent}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
