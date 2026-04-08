import { Activity, LogOut } from 'lucide-react';

interface TopBarProps {
  userEmail?: string;
}

export default function TopBar({ userEmail }: TopBarProps) {
  return (
    <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-green-600">
          <Activity className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-semibold leading-tight">xBullRadar</h1>
          <p className="text-xs text-zinc-500">Real-time X sentiment · Powered by Grok</p>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <span className="hidden items-center gap-1.5 text-xs text-zinc-500 md:flex">
          <span className="h-2 w-2 rounded-full bg-green-500" />
          Live
        </span>

        {userEmail && (
          <>
            <span
              className="hidden max-w-[220px] truncate text-xs text-zinc-500 md:inline"
              title={userEmail}
            >
              {userEmail}
            </span>
            {/* Sign-out is a POST so it can't be triggered by an <a href> or
                browser prefetch. Native form submit avoids needing JS for the
                hot path of "sign me out." */}
            <form action="/api/auth/signout" method="POST">
              <button
                type="submit"
                title="Sign out"
                aria-label="Sign out"
                className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </form>
          </>
        )}
      </div>
    </header>
  );
}
