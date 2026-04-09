'use client';

// Vertical scrollable news feed for the dashboard sidebar.
//
// Sources from /api/news (FMP /stable/news/{general,stock,crypto,forex}-latest
// via lib/news.ts, cached server-side at 5-minute TTL on the FMP Starter
// plan). Polls every 2 minutes for fresh data.
//
// 4 category tabs: All / Stocks / Crypto / Forex. The "All" tab merges
// general + stock + crypto + forex sorted by publishedDate descending.
//
// Manual refresh button: rate-limited to one click per 60 seconds per
// browser. With Starter's 300/min rate limit, this is mostly belt-and-
// suspenders for very impatient clicking.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Newspaper, RefreshCw } from 'lucide-react';

interface NewsArticle {
  id: string;
  title: string;
  publishedAt: string;
  preview: string;
  tickers: string[];
  imageUrl: string | null;
  link: string;
  publisher: string | null;
  site: string | null;
  category: 'general' | 'stock' | 'crypto' | 'forex';
}

interface NewsApiResponse {
  articles: NewsArticle[];
  fetchedAt: string | null;
  category: string;
}

type TabKey = 'all' | 'stock' | 'crypto' | 'forex';

const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MANUAL_REFRESH_COOLDOWN_MS = 60 * 1000; // 60 seconds

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'stock', label: 'Stocks' },
  { key: 'crypto', label: 'Crypto' },
  { key: 'forex', label: 'Forex' },
];

export default function NewsPanel() {
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [articlesByTab, setArticlesByTab] = useState<Record<TabKey, NewsArticle[]>>({
    all: [],
    stock: [],
    crypto: [],
    forex: [],
  });
  const [loadingTab, setLoadingTab] = useState<TabKey | null>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<Record<TabKey, string | null>>({
    all: null,
    stock: null,
    crypto: null,
    forex: null,
  });
  const [refreshCooldownUntil, setRefreshCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const cancelRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadTab = useCallback(async (tab: TabKey) => {
    try {
      const res = await fetch(`/api/news?category=${tab}`);
      if (!res.ok) return;
      const data = (await res.json()) as NewsApiResponse;
      if (cancelRef.current) return;
      setArticlesByTab((prev) => ({ ...prev, [tab]: data.articles ?? [] }));
      setLastFetchedAt((prev) => ({ ...prev, [tab]: data.fetchedAt }));
    } catch {
      // News is decorative — silent fail keeps the sidebar healthy
    }
  }, []);

  // Initial load + polling for the active tab
  useEffect(() => {
    cancelRef.current = false;
    setLoadingTab(activeTab);
    loadTab(activeTab).finally(() => {
      if (!cancelRef.current) setLoadingTab(null);
    });
    const id = setInterval(() => loadTab(activeTab), POLL_INTERVAL_MS);
    return () => {
      cancelRef.current = true;
      clearInterval(id);
    };
  }, [activeTab, loadTab]);

  // Tick the relative-time clock every 30s so "2m ago" updates
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  // Reset scroll to top when switching tabs
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [activeTab]);

  async function manualRefresh() {
    if (refreshing) return;
    if (Date.now() < refreshCooldownUntil) return;
    setRefreshing(true);
    try {
      await loadTab(activeTab);
      setRefreshCooldownUntil(Date.now() + MANUAL_REFRESH_COOLDOWN_MS);
    } finally {
      setRefreshing(false);
    }
  }

  const cooldownActive = now < refreshCooldownUntil;
  const articles = articlesByTab[activeTab];
  const fetchedAt = lastFetchedAt[activeTab];
  const isLoading = loadingTab === activeTab && articles.length === 0;

  return (
    <section className="flex min-h-[400px] flex-1 flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
      <header className="flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Newspaper className="h-4 w-4 text-green-500" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Market News
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {fetchedAt && (
            <span className="text-[10px] text-zinc-600" title={`Cache updated ${fetchedAt}`}>
              {formatRelative(new Date(fetchedAt).getTime(), now)}
            </span>
          )}
          <button
            type="button"
            onClick={manualRefresh}
            disabled={refreshing || cooldownActive}
            title={
              cooldownActive
                ? 'Refresh available again in a moment'
                : 'Refresh news'
            }
            aria-label="Refresh news"
            className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* Category tabs */}
      <div className="flex border-b border-zinc-800/60" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 border-b-2 px-2 py-2 text-[11px] font-semibold uppercase tracking-wide transition ${
              activeTab === tab.key
                ? 'border-green-500 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {isLoading ? (
          <p className="px-4 py-6 text-sm text-zinc-500">Loading news…</p>
        ) : articles.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No articles right now.</p>
        ) : (
          <ul className="divide-y divide-zinc-800/60">
            {articles.map((article) => (
              <ArticleCard key={`${article.category}-${article.id}`} article={article} now={now} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ArticleCard({ article, now }: { article: NewsArticle; now: number }) {
  const publishedMs = useMemo(
    () => new Date(article.publishedAt).getTime(),
    [article.publishedAt],
  );

  return (
    <li>
      <a
        href={article.link}
        target="_blank"
        rel="noopener noreferrer"
        className="block px-4 py-3 transition hover:bg-zinc-900/40"
      >
        <div className="flex gap-3">
          {article.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={article.imageUrl}
              alt=""
              loading="lazy"
              className="h-14 w-14 shrink-0 rounded-md border border-zinc-800/60 object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-zinc-500">
              <span className="font-mono">{formatRelative(publishedMs, now)}</span>
              {article.publisher && (
                <>
                  <span className="text-zinc-700">•</span>
                  <span className="truncate text-zinc-400">{article.publisher}</span>
                </>
              )}
              {article.tickers.length > 0 && (
                <>
                  <span className="text-zinc-700">•</span>
                  <span className="flex items-center gap-1">
                    {article.tickers.slice(0, 3).map((t) => (
                      <span
                        key={t}
                        className="rounded bg-zinc-900 px-1 py-px font-mono text-[9px] font-semibold text-green-400"
                      >
                        {t}
                      </span>
                    ))}
                    {article.tickers.length > 3 && (
                      <span className="text-zinc-600">+{article.tickers.length - 3}</span>
                    )}
                  </span>
                </>
              )}
            </div>
            <h3 className="line-clamp-2 text-sm font-semibold text-zinc-200">
              {article.title}
            </h3>
            {article.preview && (
              <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{article.preview}</p>
            )}
            <div className="mt-1 flex items-center gap-1 text-[10px] text-zinc-600">
              <ExternalLink className="h-2.5 w-2.5" />
              Read full article
            </div>
          </div>
        </div>
      </a>
    </li>
  );
}

function formatRelative(timestampMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(timestampMs).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}
