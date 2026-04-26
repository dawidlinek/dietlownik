import { setTimeout as sleep } from 'timers/promises';

const BASE = 'https://dietly.pl';
const DELAY_MS = 400;

interface FetchOptions extends RequestInit {
  companyId?: string;
  headers?: Record<string, string>;
}

async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  await sleep(DELAY_MS);
  const { companyId, headers = {}, ...rest } = options;
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      accept: 'application/json',
      'accept-language': 'pl',
      ...(companyId ? { 'company-id': companyId } : {}),
      ...headers,
    },
    ...rest,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${options.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export function get<T>(path: string, options: FetchOptions = {}): Promise<T> {
  return apiFetch<T>(path, options);
}

export function post<T>(path: string, body: unknown, options: FetchOptions = {}): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(body),
    ...options,
  });
}

export async function getHtml(path: string): Promise<string> {
  await sleep(DELAY_MS);
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'pl' },
  });
  if (!res.ok) throw new Error(`GET HTML ${path} → ${res.status}`);
  return res.text();
}

export function parsePrice(val: string | number | null | undefined): number | null {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  const n = parseFloat(String(val).replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

export function futureWeekdays(count: number, { includeSaturday = false } = {}): string[] {
  const dates: string[] = [];
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (dates.length < count) {
    const day = d.getDay();
    if (day !== 0 && (includeSaturday || day !== 6)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    d.setDate(d.getDate() + 1);
  }
  return dates;
}
