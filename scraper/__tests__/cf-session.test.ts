import { describe, it, expect } from "vitest";

import { tokenize, parseCurl } from "../scripts/cf-session.js";

describe("tokenize", () => {
  it("splits on whitespace, preserves single-quoted strings as one token", () => {
    expect(tokenize(`curl 'https://example.com/x' -H 'a: b'`)).toEqual([
      "curl",
      "https://example.com/x",
      "-H",
      "a: b",
    ]);
  });

  it("preserves double-quoted strings, including embedded single quotes", () => {
    expect(tokenize(`curl "https://x" -H "u-a: it's me"`)).toEqual([
      "curl",
      "https://x",
      "-H",
      "u-a: it's me",
    ]);
  });

  it("folds backslash-newline line continuations", () => {
    const input = `curl 'https://x' \\\n  -H 'a: 1' \\\n  -H 'b: 2'`;
    expect(tokenize(input)).toEqual([
      "curl",
      "https://x",
      "-H",
      "a: 1",
      "-H",
      "b: 2",
    ]);
  });

  it("keeps semicolons inside cookie values intact", () => {
    expect(tokenize(`-H 'cookie: a=1; b=2; cf_clearance=zzz'`)).toEqual([
      "-H",
      "cookie: a=1; b=2; cf_clearance=zzz",
    ]);
  });
});

describe("parseCurl", () => {
  it('extracts cookie + user-agent from a Chrome "Copy as cURL" snippet', () => {
    const input = `curl 'https://aplikacja.dietly.pl/api/mobile/open/cities' \\
  -H 'accept: application/json' \\
  -H 'accept-language: pl-PL,pl;q=0.9' \\
  -H 'cookie: __cf_bm=abc; cf_clearance=long-token; _ga=GA1.1' \\
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' \\
  --compressed`;
    const out = parseCurl(input);
    expect(out.cookie).toBe("__cf_bm=abc; cf_clearance=long-token; _ga=GA1.1");
    expect(out.userAgent).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    );
  });

  it("lowercases header names and is case-insensitive on Cookie/User-Agent", () => {
    const input = `curl https://x -H "Cookie: cf_clearance=t" -H "User-Agent: UA/1.0"`;
    const out = parseCurl(input);
    expect(out.cookie).toBe("cf_clearance=t");
    expect(out.userAgent).toBe("UA/1.0");
  });

  it("honors -A and -b shortcuts", () => {
    const input = `curl https://x -A 'Custom UA' -b 'cf_clearance=z'`;
    const out = parseCurl(input);
    expect(out.userAgent).toBe("Custom UA");
    expect(out.cookie).toBe("cf_clearance=z");
  });

  it("returns no cookie/UA when neither is present", () => {
    const out = parseCurl(`curl https://x -H 'accept: */*'`);
    expect(out.cookie).toBeUndefined();
    expect(out.userAgent).toBeUndefined();
    expect(out.headers.accept).toBe("*/*");
  });
});
