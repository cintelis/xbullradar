'use client';

// Avatar + dropdown menu in the top-right of the dashboard. Replaces the
// inline email + sign-out icon that lived in TopBar through Commit 6.
//
// Click the avatar → dropdown opens with "Signed in as ...", a Profile link,
// and a sign-out button. Click outside or press Escape to close.

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { LogOut, User as UserIcon } from 'lucide-react';

interface UserMenuProps {
  email: string;
}

// Picked to look good on the dark zinc background. Order matters — we hash
// the email to one of these consistently so a given user always sees the
// same color.
const AVATAR_COLORS = [
  'bg-green-600',
  'bg-blue-600',
  'bg-purple-600',
  'bg-pink-600',
  'bg-orange-600',
  'bg-cyan-600',
  'bg-indigo-600',
  'bg-rose-600',
];

function hashStringToIndex(input: string, modulo: number): number {
  // djb2 — fast, deterministic, good enough for color bucketing.
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % modulo;
}

export default function UserMenu({ email }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const initial = (email[0] ?? '?').toUpperCase();
  const colorClass = AVATAR_COLORS[hashStringToIndex(email, AVATAR_COLORS.length)];

  // Close on click-outside.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={email}
        className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold text-white transition hover:opacity-90 ${colorClass}`}
      >
        {initial}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl shadow-black/40"
        >
          <div className="border-b border-zinc-800 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-zinc-500">
              Signed in as
            </p>
            <p
              className="mt-0.5 truncate text-sm font-medium text-zinc-100"
              title={email}
            >
              {email}
            </p>
          </div>

          <div className="py-1">
            <Link
              href="/profile"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 px-4 py-2 text-sm text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-100"
            >
              <UserIcon className="h-4 w-4 text-zinc-500" />
              Profile
            </Link>

            <form action="/api/auth/signout" method="POST" className="block">
              <button
                type="submit"
                role="menuitem"
                className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-100"
              >
                <LogOut className="h-4 w-4 text-zinc-500" />
                Sign out
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
