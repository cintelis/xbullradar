import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, LogOut, Mail, Calendar, Clock, ListChecks } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth';
import { store } from '@/lib/store';

export const metadata = {
  title: 'Profile · xBullRadar',
};

/**
 * Profile page. Server component, gated by auth (redirects to /sign-in if
 * not signed in). Shows the four bits of info we actually have about a
 * user — email, created-at, last-login, watchlist size — plus a prominent
 * sign-out button.
 *
 * No settings, preferences, danger-zone, etc. Those are deferred until
 * there's something concrete to put in them.
 */
export default async function ProfilePage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/sign-in');
  }

  const watchlist = await store.getWatchlist(user.id);

  return (
    <div className="min-h-screen bg-zinc-950 p-4 lg:p-8">
      <div className="mx-auto max-w-2xl">
        <Link
          href="/"
          className="mb-6 inline-flex items-center gap-2 text-sm text-zinc-500 transition hover:text-zinc-300"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </Link>

        <header className="mb-8">
          <h1 className="text-2xl font-semibold text-zinc-100">Profile</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Your xBullRadar account.
          </p>
        </header>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
          <dl className="space-y-5">
            <ProfileField icon={<Mail className="h-4 w-4" />} label="Email">
              <span className="font-mono text-zinc-100">{user.email}</span>
            </ProfileField>

            <ProfileField icon={<Calendar className="h-4 w-4" />} label="Member since">
              {formatAbsoluteDate(user.createdAt)}
            </ProfileField>

            <ProfileField icon={<Clock className="h-4 w-4" />} label="Last sign-in">
              {formatRelativeOrAbsolute(user.lastLoginAt)}
            </ProfileField>

            <ProfileField
              icon={<ListChecks className="h-4 w-4" />}
              label="Watchlist"
            >
              {watchlist.length === 0 ? (
                <span className="text-zinc-500">No tickers yet</span>
              ) : (
                <span>
                  {watchlist.length} {watchlist.length === 1 ? 'ticker' : 'tickers'}
                  <span className="ml-2 text-zinc-600">
                    {watchlist.slice(0, 5).join(', ')}
                    {watchlist.length > 5 && ` +${watchlist.length - 5} more`}
                  </span>
                </span>
              )}
            </ProfileField>
          </dl>
        </section>

        <section className="mt-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Account
          </h2>
          <form action="/api/auth/signout" method="POST">
            <button
              type="submit"
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm font-semibold text-red-400 transition hover:border-red-800 hover:bg-red-950/50 hover:text-red-300"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </form>
        </section>

        <p className="mt-8 text-center text-xs text-zinc-600">
          Limited trial · Invite only
        </p>
      </div>
    </div>
  );
}

function ProfileField({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 text-zinc-600">{icon}</div>
      <div className="min-w-0 flex-1">
        <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
        <dd className="mt-0.5 text-sm text-zinc-300">{children}</dd>
      </div>
    </div>
  );
}

function formatAbsoluteDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatRelativeOrAbsolute(iso: string): string {
  try {
    const date = new Date(iso);
    const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diffSec < 60) return 'Just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hr ago`;
    if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)} days ago`;
    return formatAbsoluteDate(iso);
  } catch {
    return iso;
  }
}
