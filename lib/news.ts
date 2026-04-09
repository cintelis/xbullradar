// Financial news fetcher for the dashboard NewsPanel.
//
// Source: FMP /stable/fmp-articles — the only news endpoint available
// on the FMP free Stocks Basic tier. Returns FMP's own AI-curated
// articles with title, body (HTML), image, ticker tags, and a link to
// the full article.
//
// The other free-tier candidates (general-news, stock-news, crypto-news,
// news/general, news/stock) all return empty arrays or are gated to
// premium subscriptions on the new /stable API. fmp-articles is the
// only working option for now.
//
// Caching: 20-minute TTL in Upstash, shared across all users. With the
// daily cron also warming the cache once per day, total FMP calls/day
// for news is ~72-73, leaving comfortable headroom under the 250/day
// free-tier limit alongside fundamentals (~50/day) and markets
// (~10-44/day).

import { Redis } from '@upstash/redis';
import { getUpstashConfig } from './store-upstash';

const FMP_API_BASE = 'https://financialmodelingprep.com/stable';
const CACHE_KEY = 'xbr:news:v1';
const CACHE_TTL_SECONDS = 20 * 60; // 20 minutes
const ARTICLES_PER_FETCH = 20;
const PREVIEW_MAX_LENGTH = 220;

export interface NewsArticle {
  /** Stable identifier — derived from the article's link URL. */
  id: string;
  title: string;
  /** ISO timestamp of publication. */
  publishedAt: string;
  /** Plain-text preview (HTML stripped, capped at 220 chars). */
  preview: string;
  /** Cleaned ticker symbols (no exchange prefix), e.g. ['BETR', 'NVDA']. */
  tickers: string[];
  /** Direct image URL — null if FMP didn't provide one or it looks broken. */
  imageUrl: string | null;
  /** Full article URL for "read more" click-through. */
  link: string;
}

export interface CachedNews {
  articles: NewsArticle[];
  fetchedAt: string;
}

// ─── FMP client ─────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error('FMP_API_KEY is not set in env');
  return key;
}

interface FMPArticleRaw {
  title?: string;
  date?: string;
  content?: string;
  tickers?: string;
  image?: string;
  link?: string;
}

function isFMPErrorBody(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return 'Error Message' in body || 'error' in body;
}

/**
 * Strip HTML tags + collapse whitespace + truncate. Used for the article
 * preview shown beneath the title in each card.
 */
function htmlToPreview(html: string): string {
  // Decode common HTML entities the FMP content uses
  const decoded = html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Strip tags
  const stripped = decoded.replace(/<[^>]+>/g, ' ');

  // Collapse whitespace
  const collapsed = stripped.replace(/\s+/g, ' ').trim();

  if (collapsed.length <= PREVIEW_MAX_LENGTH) return collapsed;
  return collapsed.slice(0, PREVIEW_MAX_LENGTH).trimEnd() + '…';
}

/**
 * Parse "NASDAQ:BETR, NYSE:NVDA" → ['BETR', 'NVDA']. Strips the exchange
 * prefix since the dashboard cares about the ticker symbol, not the venue.
 * Dedupes and uppercases.
 */
function parseTickers(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const symbol = part.trim().split(':').pop()?.trim().toUpperCase();
    if (!symbol) continue;
    if (!/^[A-Z.]{1,10}$/.test(symbol)) continue;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
  }
  return out;
}

/**
 * FMP date format is "YYYY-MM-DD HH:mm:ss" without a timezone — assume UTC.
 * Returns an ISO string suitable for new Date() on the client.
 */
function fmpDateToIso(date: string | undefined): string {
  if (!date) return new Date().toISOString();
  const cleaned = date.trim().replace(' ', 'T');
  // If no timezone marker, treat as UTC
  const withTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(cleaned) ? cleaned : `${cleaned}Z`;
  const parsed = new Date(withTz);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function deriveId(link: string | undefined, fallbackTitle: string): string {
  if (link) {
    // Use the last path segment, or hash the full URL if there's no path
    const segments = link.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) return last;
  }
  // Fallback: slugified title
  return fallbackTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 64);
}

async function fetchArticlesRaw(): Promise<NewsArticle[]> {
  const apiKey = encodeURIComponent(getApiKey());
  const url = `${FMP_API_BASE}/fmp-articles?limit=${ARTICLES_PER_FETCH}&apikey=${apiKey}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`FMP /stable/fmp-articles returned ${res.status}`);
  }

  const json = (await res.json()) as unknown;
  if (isFMPErrorBody(json)) {
    const errMsg = (json as { ['Error Message']?: string })?.['Error Message'];
    throw new Error(`FMP news error: ${errMsg ?? 'unknown'}`);
  }
  if (!Array.isArray(json)) return [];

  const out: NewsArticle[] = [];
  for (const raw of json as FMPArticleRaw[]) {
    if (!raw.title || !raw.link) continue;
    out.push({
      id: deriveId(raw.link, raw.title),
      title: raw.title.replace(/&amp;/g, '&').trim(),
      publishedAt: fmpDateToIso(raw.date),
      preview: htmlToPreview(raw.content ?? ''),
      tickers: parseTickers(raw.tickers),
      imageUrl: raw.image && raw.image.startsWith('http') ? raw.image : null,
      link: raw.link,
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

function parseCached(raw: unknown): CachedNews | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as CachedNews;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as CachedNews;
    } catch {
      return null;
    }
  }
  return null;
}

let inFlight: Promise<CachedNews> | null = null;

/**
 * Get the latest financial news. Always served from Upstash cache when
 * available; refreshes from FMP on cache miss with a 20-minute TTL.
 * One shared cache across all users keeps total FMP usage at ~72/day.
 */
export async function getNews(): Promise<CachedNews> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const redis = getRedis();
    if (redis) {
      const cached = await redis.get<CachedNews | string>(CACHE_KEY);
      const parsed = parseCached(cached);
      if (parsed) return parsed;
    }

    const articles = await fetchArticlesRaw();
    const fresh: CachedNews = {
      articles,
      fetchedAt: new Date().toISOString(),
    };

    if (redis) {
      await redis.set(CACHE_KEY, JSON.stringify(fresh), { ex: CACHE_TTL_SECONDS });
    }
    return fresh;
  })();

  inFlight.finally(() => {
    setTimeout(() => {
      inFlight = null;
    }, 1000);
  });

  return inFlight;
}

/**
 * Force-refresh the news cache. Called by the daily cron so morning
 * users get warm data.
 */
export async function refreshNews(): Promise<CachedNews> {
  const redis = getRedis();
  if (redis) await redis.del(CACHE_KEY);
  inFlight = null;
  return getNews();
}
