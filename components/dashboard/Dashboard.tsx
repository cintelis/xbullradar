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
import CopilotChat from '@/components/copilot/CopilotChat';
import { useMediaQuery } from '@/hooks/useMediaQuery';

interface DashboardProps {
  userEmail: string;
}

const CHAT_HIDDEN_KEY = 'xbr:chatHidden';

export default function Dashboard({ userEmail }: DashboardProps) {
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [mobileTab, setMobileTab] = useState<MobileTab>('dashboard');
  const [chatHidden, setChatHidden] = useState(false);
  const [chatHydrated, setChatHydrated] = useState(false);

  // Hydrate chat-hidden preference from localStorage on mount.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CHAT_HIDDEN_KEY);
      if (stored === 'true') setChatHidden(true);
    } catch {
      // ignore
    }
    setChatHydrated(true);
  }, []);

  // Persist on change (post-hydration so we don't blow away the stored
  // value with the initial false state).
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

      <div className="flex flex-1 overflow-hidden">
        {/* Main content */}
        <main className="flex-1 overflow-auto p-4 lg:p-6">
          {isDesktop ? (
            // Desktop: stack all three full-width so the new signal columns
            // (Sent / Tech / Fund / Combined) have horizontal room to breathe.
            // ExchangeClockCard lives in the right sidebar, not here.
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
              {mobileTab === 'chat' && (
                <div className="h-[calc(100vh-8.5rem)] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
                  <CopilotChat />
                </div>
              )}
            </div>
          )}
        </main>

        {/* Right sidebar — desktop only. Holds the ExchangeClockCard at the
            top and the CopilotChat below. Sidebar always rendered with a
            fixed width even when chat is hidden so the clock card stays
            anchored; the freed area below it currently shows a "show chat"
            placeholder and will host a news panel in a follow-up commit. */}
        {isDesktop && (
          <aside className="hidden w-[380px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-4 lg:flex">
            <ExchangeClockCard />
            {chatHidden ? (
              <ChatHiddenPlaceholder onShow={() => setChatHidden(false)} />
            ) : (
              <div className="flex min-h-[400px] flex-1 overflow-hidden rounded-2xl border border-zinc-800">
                <CopilotChat onHide={() => setChatHidden(true)} />
              </div>
            )}
          </aside>
        )}
      </div>

      {/* Mobile bottom nav */}
      {!isDesktop && <BottomNav active={mobileTab} onChange={setMobileTab} />}
    </div>
  );
}

/**
 * Placeholder shown in the right sidebar when the user has hidden the
 * chat panel. Currently a simple "show chat" button; in the next commit
 * this will be replaced by a financial news feed (FMP /stable/fmp-articles)
 * so the freed space is filled with useful content instead of empty UI.
 */
function ChatHiddenPlaceholder({ onShow }: { onShow: () => void }) {
  return (
    <div className="flex min-h-[400px] flex-1 flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-zinc-800 bg-zinc-950 p-8 text-center">
      <MessageSquare className="h-8 w-8 text-zinc-700" />
      <div>
        <p className="text-sm font-medium text-zinc-300">Chat is hidden</p>
        <p className="mt-1 text-xs text-zinc-500">
          A news feed will live here in a future update.
        </p>
      </div>
      <button
        type="button"
        onClick={onShow}
        className="rounded-md bg-green-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-green-500"
      >
        Show chat
      </button>
    </div>
  );
}
