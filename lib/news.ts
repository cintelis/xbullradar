// Financial news fetcher for the dashboard NewsPanel.
//
// Source: FMP /stable/news/{general,stock,crypto,forex}-latest endpoints,
// available on FMP Stocks Starter ($14/mo) and higher. These return real
// news articles from real publishers (Reuters, Bloomberg, MarketWatch,
// etc.) — much better than the FMP-curated /stable/fmp-articles endpoint
// we used on the free tier.
//
// Four parallel streams, cached separately. The "all" view merges all four
// and sorts by publishedDate descending.
//
// Cache budget on Starter:
//   - 5-min TTL per category × 4 categories = ~1152 fetches/day max
//   - Rate limit: 300/min on Starter — 1152/day = ~0.8/min average
//   - Comfortably under the limit even with all 4 caches refreshing at
//     their fastest possible cadence

import { Redis } from '@upstash/redis';
import { getUpstashConfig } from './store-upstash';

const FMP_API_BASE = 'https://financialmodelingprep.com/stable';
const CACHE_KEY_PREFIX = 'xbr:news:v2:';
const CACHE_TTL_SECONDS = 5 * 60; // 5 minutes — Starter rate limit headroom lets us be aggressive
const ARTICLES_PER_FETCH = 25;
const PREVIEW_MAX_LENGTH = 220;

export type NewsCategory = 'all' | 'general' | 'stock' | 'crypto' | 'forex';

export const NEWS_CATEGORIES = ['general', 'stock', 'crypto', 'forex'] as const;
type SingleCategory = (typeof NEWS_CATEGORIES)[number];

const FMP_ENDPOINT_BY_CATEGORY: Record<SingleCategory, string> = {
  general: 'news/general-latest',
  stock: 'news/stock-latest',
  crypto: 'news/crypto-latest',
  forex: 'news/forex-latest',
};

export interface NewsArticle {
  id: string;
  title: string;
  publishedAt: string;
  preview: string;
  /** Single-element array on these endpoints (one symbol per article) */
  tickers: string[];
  imageUrl: string | null;
  link: string;
  publisher: string | null;
  site: string | null;
  category: SingleCategory;
}

export interface CachedNews {
  articles: NewsArticle[];
  fetchedAt: string;
  category: NewsCategory;
}

// ─── FMP client ─────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error('FMP_API_KEY is not set in env');
  return key;
}

interface FMPNewsRaw {
  symbol?: string;
  publishedDate?: string;
  publisher?: string;
  title?: string;
  image?: string;
  site?: string;
  text?: string;
  url?: string;
}

function isFMPErrorBody(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return 'Error Message' in body || 'error' in body;
}

function truncate(s: string, max: number): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max).trimEnd() + '…';
}

/**
 * Parse FMP date strings to ISO. The new endpoints return strings like
 * "2026-04-09 14:23:00" without a timezone — assume UTC.
 */
function fmpDateToIso(date: string | undefined): string {
  if (!date) return new Date().toISOString();
  const cleaned = date.trim().replace(' ', 'T');
  const withTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(cleaned) ? cleaned : `${cleaned}Z`;
  const parsed = new Date(withTz);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function deriveId(url: string | undefined, fallbackTitle: string): string {
  if (url) {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      const last = segments[segments.length - 1];
      if (last) return last;
      return parsed.hostname + parsed.pathname.replace(/\W+/g, '-').slice(0, 64);
    } catch {
      // fall through
    }
  }
  return fallbackTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 64);
}

/**
 * Fetch one news category from FMP. Returns an array of articles or
 * an empty array if the response is empty/errored. Throws only on
 * network failure or unparseable JSON.
 */
async function fetchCategoryRaw(category: SingleCategory): Promise<NewsArticle[]> {
  const apiKey = encodeURIComponent(getApiKey());
  const endpoint = FMP_ENDPOINT_BY_CATEGORY[category];
  const url = `${FMP_API_BASE}/${endpoint}?limit=${ARTICLES_PER_FETCH}&apikey=${apiKey}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!res.ok) {
    console.warn(`[news] ${category} returned ${res.status}`);
    return [];
  }

  const json = (await res.json()) as unknown;
  if (isFMPErrorBody(json)) {
    const errMsg = (json as { ['Error Message']?: string })?.['Error Message'];
    console.warn(`[news] ${category} error: ${errMsg ?? 'unknown'}`);
    return [];
  }
  if (!Array.isArray(json)) return [];

  const out: NewsArticle[] = [];
  for (const raw of json as FMPNewsRaw[]) {
    if (!raw.title || !raw.url) continue;
    const symbol = raw.symbol?.trim().toUpperCase() ?? '';
    out.push({
      id: deriveId(raw.url, raw.title),
      title: raw.title.trim(),
      publishedAt: fmpDateToIso(raw.publishedDate),
      preview: truncate(raw.text ?? '', PREVIEW_MAX_LENGTH),
      tickers: symbol ? [symbol] : [],
      imageUrl: raw.image && raw.image.startsWith('http') ? raw.image : null,
      link: raw.url,
      publisher: raw.publisher?.trim() || null,
      site: raw.site?.trim() || null,
      category,
    });
  }

  return out;
}

// ─── Cache layer ────────────────────────────────────────────────────────────

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const config = getUpstashConfig();
  if (!config) return null;
  _redis = new Redis({ url: config.url, token: config.token });
  return _redis;
}

function parseCachedArticles(raw: unknown): NewsArticle[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw as NewsArticle[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as NewsArticle[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

const inFlightByCategory = new Map<SingleCategory, Promise<NewsArticle[]>>();

/**
 * Get articles for a single category. Always served from Upstash cache
 * when available; refreshes from FMP on cache miss with a 5-minute TTL.
 * Includes in-process memoization so parallel reads in the same Lambda
 * invocation share the same fetch.
 */
async function getCategoryArticles(category: SingleCategory): Promise<NewsArticle[]> {
  const existing = inFlightByCategory.get(category);
  if (existing) return existing;

  const promise = (async () => {
    const redis = getRedis();
    const cacheKey = `${CACHE_KEY_PREFIX}${category}`;

    if (redis) {
      const cached = await redis.get<NewsArticle[] | string>(cacheKey);
      const parsed = parseCachedArticles(cached);
      if (parsed) return parsed;
    }

    const fresh = await fetchCategoryRaw(category);
    if (redis && fresh.length > 0) {
      await redis.set(cacheKey, JSON.stringify(fresh), { ex: CACHE_TTL_SECONDS });
    }
    return fresh;
  })();

  inFlightByCategory.set(category, promise);
  promise.finally(() => {
    setTimeout(() => {
      inFlightByCategory.delete(category);
    }, 1000);
  });

  return promise;
}

/**
 * Public API. Returns the news feed for the requested category.
 *
 * For 'all', merges all four streams and sorts by publishedAt descending.
 * Cold-cache cost for 'all' is ~4 parallel FMP calls; once warm it's
 * 4 parallel Upstash reads (~10ms total).
 *
 * For a single category, it's 1 FMP call cold or 1 Upstash read warm.
 */
export async function getNews(category: NewsCategory = 'all'): Promise<CachedNews> {
  if (category === 'all') {
    const allArticles = await Promise.all(
      NEWS_CATEGORIES.map((c) => getCategoryArticles(c)),
    );
    // Merge + sort newest-first
    const merged = allArticles
      .flat()
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    return {
      articles: merged,
      fetchedAt: new Date().toISOString(),
      category: 'all',
    };
  }

  const articles = await getCategoryArticles(category);
  return {
    articles,
    fetchedAt: new Date().toISOString(),
    category,
  };
}

/**
 * Force-refresh ALL news category caches. Called by the daily cron so
 * morning users get warm data across every tab without paying the
 * cold-cache cost themselves.
 */
export async function refreshNews(): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await Promise.all(
      NEWS_CATEGORIES.map((c) => redis.del(`${CACHE_KEY_PREFIX}${c}`)),
    );
  }
  inFlightByCategory.clear();
  // Re-warm all categories sequentially so we don't slam FMP with 4
  // parallel cold fetches. The cron is rare enough that sequential is fine.
  for (const c of NEWS_CATEGORIES) {
    try {
      await getCategoryArticles(c);
    } catch (err) {
      console.warn(`[news] cron warm-up failed for ${c}:`, err);
    }
  }
}
