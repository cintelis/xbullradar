'use client';

// Vertical scrollable news feed for the dashboard sidebar.
//
// Replaces the placeholder that used to live in the chat-hidden state.
// Articles come from /api/news (FMP /stable/fmp-articles, cached
// server-side at 20-minute TTL). Polls every 10 minutes for fresh data.
//
// Manual refresh button: rate-limited to one click per 5 minutes per
// browser via local state to prevent quota burn from impatient clicking.

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
}

interface NewsApiResponse {
  articles: NewsArticle[];
  fetchedAt: string | null;
}

const POLL_INTERVAL_MS = 10 * 60 * 1000;     // 10 minutes
const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export default function NewsPanel() {
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const [refreshCooldownUntil, setRefreshCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const cancelRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/news');
      if (!res.ok) return;
      const data = (await res.json()) as NewsApiResponse;
      if (cancelRef.current) return;
      setArticles(data.articles ?? []);
      setLastFetchedAt(data.fetchedAt);
    } catch {
      // News is decorative — silent fail keeps the sidebar healthy
    }
  }, []);

  // Initial load + polling
  useEffect(() => {
    cancelRef.current = false;
    setLoading(true);
    load().finally(() => {
      if (!cancelRef.current) setLoading(false);
    });
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelRef.current = true;
      clearInterval(id);
    };
  }, [load]);

  // Tick the relative-time clock every 30s so "2m ago" updates as
  // articles age, without needing to refetch.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  async function manualRefresh() {
    if (refreshing) return;
    if (Date.now() < refreshCooldownUntil) return;
    setRefreshing(true);
    try {
      await load();
      setRefreshCooldownUntil(Date.now() + MANUAL_REFRESH_COOLDOWN_MS);
    } finally {
      setRefreshing(false);
    }
  }

  const cooldownActive = now < refreshCooldownUntil;

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
          {lastFetchedAt && (
            <span className="text-[10px] text-zinc-600" title={`Cache updated ${lastFetchedAt}`}>
              {formatRelative(new Date(lastFetchedAt).getTime(), now)}
            </span>
          )}
          <button
            type="button"
            onClick={manualRefresh}
            disabled={refreshing || cooldownActive}
            title={
              cooldownActive
                ? 'Refresh available again in a few minutes'
                : 'Refresh news'
            }
            aria-label="Refresh news"
            className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {loading && articles.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">Loading news…</p>
        ) : articles.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No articles right now.</p>
        ) : (
          <ul className="divide-y divide-zinc-800/60">
            {articles.map((article) => (
              <ArticleCard key={article.id} article={article} now={now} />
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
                // Hide broken images instead of showing the alt text frame
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2 text-[10px] text-zinc-500">
              <span className="font-mono">
                {formatRelative(publishedMs, now)}
              </span>
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
            <h3 className="line-clamp-2 text-sm font-semibold text-zinc-200 group-hover:text-zinc-100">
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
