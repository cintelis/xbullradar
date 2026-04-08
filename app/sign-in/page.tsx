import { redirect } from 'next/navigation';
import Image from 'next/image';
import SignInForm from '@/components/auth/SignInForm';
import { getCurrentUser } from '@/lib/auth';
import bullradarImage from '@/public/assets/bullradar.png';

interface SignInPageProps {
  searchParams: Promise<{ error?: string }>;
}

/**
 * Sign-in page. Server component — checks for an existing session first
 * and redirects to the dashboard if already authenticated. Otherwise
 * renders the magic-link form with the brand bull image above it.
 *
 * Background is #142838 — a slightly lighter version of #0F1C27 so the
 * dark bull stands out instead of disappearing into the page. The image
 * uses mix-blend-mode: lighten so its pure-black backdrop blends into
 * the page background, making the bull and cyan radar appear to float
 * without a visible rectangular frame.
 */
export default async function SignInPage({ searchParams }: SignInPageProps) {
  const user = await getCurrentUser();
  if (user) {
    redirect('/');
  }

  const params = await searchParams;
  const initialError = params.error ?? null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#142838] p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Image
            src={bullradarImage}
            alt="xBullRadar — bull on a sentiment radar"
            priority
            placeholder="blur"
            className="mx-auto mb-4 w-full max-w-[260px] mix-blend-lighten"
            sizes="(max-width: 640px) 220px, 260px"
          />
          <h1 className="text-2xl font-semibold text-zinc-100">xBullRadar</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Real-time X sentiment · Powered by Grok
          </p>
        </div>

        <div className="rounded-2xl border border-zinc-700/60 bg-zinc-900/40 p-6 backdrop-blur">
          <SignInForm initialError={initialError} />
        </div>

        <p className="text-center text-xs text-zinc-500">
          Limited trial · Invite only
        </p>
      </div>
    </div>
  );
}
