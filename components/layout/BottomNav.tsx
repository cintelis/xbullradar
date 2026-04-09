'use client';

import { LayoutDashboard, MessageSquare, Newspaper, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';

export type MobileTab = 'dashboard' | 'portfolio' | 'news' | 'chat';

interface BottomNavProps {
  active: MobileTab;
  onChange: (tab: MobileTab) => void;
}

const TABS: Array<{ id: MobileTab; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: 'Radar', icon: LayoutDashboard },
  { id: 'portfolio', label: 'Portfolio', icon: Wallet },
  { id: 'news', label: 'News', icon: Newspaper },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
];

export default function BottomNav({ active, onChange }: BottomNavProps) {
  return (
    <nav className="flex items-center justify-around border-t border-zinc-800 bg-zinc-950 lg:hidden">
      {TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={cn(
            'flex flex-1 flex-col items-center gap-1 py-3 text-xs',
            active === id ? 'text-green-400' : 'text-zinc-500',
          )}
        >
          <Icon className="h-5 w-5" />
          {label}
        </button>
      ))}
    </nav>
  );
}
