'use client';

// Extracted from app/page.tsx in Commit 3 so the page itself can be a
// server component that gates access via getCurrentUser(). This component
// is the actual interactive dashboard layout — TopBar + grid + chat panel
// + mobile bottom nav. Stateful (mobile tab) so it stays a client component.

import { useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import TopBar from '@/components/layout/TopBar';
import BottomNav, { type MobileTab } from '@/components/layout/BottomNav';
import SentimentRadar from '@/components/dashboard/SentimentRadar';
import TrendingStocks from '@/components/dashboard/TrendingStocks';
import PortfolioView from '@/components/dashboard/PortfolioView';
import MarketStrip from '@/components/dashboard/MarketStrip';
import ExchangeClockCard from '@/components/dashboard/ExchangeClockCard';
import NewsPanel from '@/components/dashboard/NewsPanel';
import CopilotChat from '@/components/copilot/CopilotChat';
import { useMediaQuery } from '@/hooks/useMediaQuery';

interface DashboardProps {
  userEmail: string;
}

const CHAT_HIDDEN_KEY = 'xbr:chatHidden';

export default function Dashboard({ userEmail }: DashboardProps) {
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [mobileTab, setMobileTab] = useState<MobileTab>('dashboard');
  // Default to hidden — chat is a tool you summon, not a permanent fixture.
  // The right sidebar's lower section shows news instead by default. Existing
  // users with a stored preference get their choice respected on hydration.
  const [chatHidden, setChatHidden] = useState(true);
  const [chatHydrated, setChatHydrated] = useState(false);

  // Hydrate chat-hidden preference from localStorage on mount.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CHAT_HIDDEN_KEY);
      if (stored === 'false') setChatHidden(false);
      // Any other value (including missing) keeps the default `true`.
    } catch {
      // ignore
    }
    setChatHydrated(true);
  }, []);

  // Persist on change (post-hydration so we don't blow away the stored
  // value with the initial state).
  useEffect(() => {
    if (!chatHydrated) return;
    try {
      localStorage.setItem(CHAT_HIDDEN_KEY, String(chatHidden));
    } catch {
      // ignore
    }
  }, [chatHidden, chatHydrated]);

  return (
    <div className="flex h-screen flex-col">
      <TopBar userEmail={userEmail} />
      <MarketStrip />

      <div className="relative flex flex-1 overflow-hidden">
        {/* Main content */}
        <main className="flex-1 overflow-auto p-4 lg:p-6">
          {isDesktop ? (
            // Desktop: stack all three full-width so the new signal columns
            // (Sent / Tech / Fund / Combined) have horizontal room to breathe.
            <div className="mx-auto max-w-6xl space-y-6">
              <SentimentRadar />
              <TrendingStocks />
              <PortfolioView />
            </div>
          ) : (
            // Mobile: tab-switched. ExchangeClockCard goes at the top of the
            // dashboard tab since there's no right-sidebar concept on mobile.
            <div className="mx-auto max-w-2xl">
              {mobileTab === 'dashboard' && (
                <div className="space-y-4">
                  <ExchangeClockCard />
                  <SentimentRadar />
                  <TrendingStocks />
                </div>
              )}
              {mobileTab === 'portfolio' && <PortfolioView />}
              {mobileTab === 'news' && <NewsPanel />}
              {mobileTab === 'chat' && (
                <div className="h-[calc(100dvh-8.5rem)] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
                  <CopilotChat />
                </div>
              )}
            </div>
          )}
        </main>

        {/* Right sidebar — desktop only. Top: ExchangeClockCard.
            Bottom: NewsPanel (default) OR CopilotChat (when user has summoned). */}
        {isDesktop && (
          <aside className="hidden w-[380px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-4 lg:flex">
            <ExchangeClockCard />
            {chatHidden ? (
              <NewsPanel />
            ) : (
              <div className="flex min-h-[400px] flex-1 overflow-hidden rounded-2xl border border-zinc-800">
                <CopilotChat onHide={() => setChatHidden(true)} />
              </div>
            )}
          </aside>
        )}

        {/* Floating "Ask AI" button — desktop only, only when chat is hidden.
            Standard SaaS chat widget pattern (Intercom, Drift, ChatGPT widget).
            Provides a single discoverable entry point for new users without
            cluttering the layout. */}
        {isDesktop && chatHidden && (
          <button
            type="button"
            onClick={() => setChatHidden(false)}
            title="Ask the xBullRadar AI assistant"
            aria-label="Open chat"
            className="absolute bottom-6 right-[404px] z-30 flex h-12 w-12 items-center justify-center rounded-full bg-green-600 text-white shadow-lg shadow-green-900/40 transition hover:scale-105 hover:bg-green-500 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 focus:ring-offset-zinc-950"
          >
            <MessageSquare className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Mobile bottom nav */}
      {!isDesktop && <BottomNav active={mobileTab} onChange={setMobileTab} />}
    </div>
  );
}
