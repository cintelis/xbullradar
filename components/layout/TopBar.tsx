import Image from 'next/image';
import UserMenu from './UserMenu';

interface TopBarProps {
  userEmail?: string;
}

export default function TopBar({ userEmail }: TopBarProps) {
  return (
    <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="flex items-center gap-3">
        <Image
          src="/assets/xbull-logo.png"
          alt="xBullRadar"
          width={1024}
          height={1024}
          priority
          sizes="40px"
          className="h-9 w-9"
        />
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

        {userEmail && <UserMenu email={userEmail} />}
      </div>
    </header>
  );
}
