import { getHtml } from '../api.js';
import type { City, CompanySearchItem } from '../types.js';

interface SearchData {
  currentPage: number;
  totalPages: number;
  totalElements: number;
  searchData: CompanySearchItem[];
}

interface NextDataQueries {
  [key: string]: { status: string; data: SearchData };
}

function extractSearchData(html: string): SearchData | null {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/);
  if (!m) throw new Error('__NEXT_DATA__ not found');
  const nd = JSON.parse(m[1]) as { props: { pageProps: { initialState?: { dietlyApi?: { queries?: NextDataQueries } } } } };
  const queries = nd.props.pageProps?.initialState?.dietlyApi?.queries ?? {};
  const key = Object.keys(queries).find(k => k.startsWith('getApiSearchFull'));
  return key ? (queries[key].data ?? null) : null;
}

export async function listCompanies(city: City): Promise<CompanySearchItem[]> {
  console.log(`[companies] fetching page 1 for ${city.name}...`);
  const html1 = await getHtml(`/catering-dietetyczny/${city.sanitizedName}`);
  const page1 = extractSearchData(html1);
  if (!page1) throw new Error('getApiSearchFull not found in __NEXT_DATA__');

  const totalPages = page1.totalPages ?? 1;
  console.log(`[companies] ${page1.totalElements} total, ${totalPages} pages`);

  const all = [...(page1.searchData ?? [])];

  for (let p = 2; p <= totalPages; p++) {
    console.log(`[companies] fetching page ${p}/${totalPages}...`);
    const html = await getHtml(`/catering-dietetyczny/${city.sanitizedName}?page=${p}`);
    const data = extractSearchData(html);
    if (data?.searchData) all.push(...data.searchData);
  }

  // "name" is the companyId slug (e.g. "robinfood")
  const companies = all.map(c => ({ ...c, companyId: c.name }));
  console.log(`[companies] ✓ ${companies.length} companies collected`);
  return companies;
}
