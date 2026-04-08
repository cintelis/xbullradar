'use client';

// Extracted from app/page.tsx in Commit 3 so the page itself can be a
// server component that gates access via getCurrentUser(). This component
// is the actual interactive dashboard layout — TopBar + grid + chat panel
// + mobile bottom nav. Stateful (mobile tab) so it stays a client component.

import { useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import BottomNav, { type MobileTab } from '@/components/layout/BottomNav';
import SentimentRadar from '@/components/dashboard/SentimentRadar';
import TrendingStocks from '@/components/dashboard/TrendingStocks';
import CopilotChat from '@/components/copilot/CopilotChat';
import { useMediaQuery } from '@/hooks/useMediaQuery';

interface DashboardProps {
  userEmail: string;
}

export default function Dashboard({ userEmail }: DashboardProps) {
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [mobileTab, setMobileTab] = useState<MobileTab>('dashboard');

  return (
    <div className="flex h-screen flex-col">
      <TopBar userEmail={userEmail} />

      <div className="flex flex-1 overflow-hidden">
        {/* Main content */}
        <main className="flex-1 overflow-auto p-4 lg:p-6">
          {isDesktop ? (
            // Desktop: full grid always
            // PortfolioOverview hidden until a real holdings input UI ships (Phase 2).
            <div className="mx-auto grid max-w-6xl gap-6">
              <SentimentRadar />
              <TrendingStocks />
            </div>
          ) : (
            // Mobile: tab-switched
            <div className="mx-auto max-w-2xl">
              {mobileTab === 'dashboard' && (
                <div className="space-y-4">
                  <SentimentRadar />
                  <TrendingStocks />
                </div>
              )}
              {mobileTab === 'chat' && (
                <div className="h-[calc(100vh-8.5rem)] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
                  <CopilotChat />
                </div>
              )}
            </div>
          )}
        </main>

        {/* Right-side chat panel — desktop only */}
        {isDesktop && (
          <aside className="hidden w-[380px] border-l border-zinc-800 bg-zinc-950 lg:flex lg:flex-col">
            <CopilotChat />
          </aside>
        )}
      </div>

      {/* Mobile bottom nav */}
      {!isDesktop && <BottomNav active={mobileTab} onChange={setMobileTab} />}
    </div>
  );
}
