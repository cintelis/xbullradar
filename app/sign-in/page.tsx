import { redirect } from 'next/navigation';
import Image from 'next/image';
import SignInForm from '@/components/auth/SignInForm';
import { getCurrentUser } from '@/lib/auth';

interface SignInPageProps {
  searchParams: Promise<{ error?: string }>;
}

/**
 * Sign-in page. Server component — checks for an existing session first
 * and redirects to the dashboard if already authenticated. Otherwise
 * renders the magic-link form with the brand bull image above it.
 *
 * The bull image (public/assets/bullradar.png) has a transparent
 * background, so it sits on the page naturally without needing a blend
 * mode. Referenced by URL string (not static import) because files in
 * public/ aren't eligible for Next.js static-import processing. Native
 * source dims are 909x819; next/image resizes per-request based on the
 * `sizes` hint.
 */
export default async function SignInPage({ searchParams }: SignInPageProps) {
  const user = await getCurrentUser();
  if (user) {
    redirect('/');
  }

  const params = await searchParams;
  const initialError = params.error ?? null;

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-zinc-950 p-6"
      style={{ backgroundImage: 'url(/assets/login-pattern.svg)', backgroundSize: '200px 200px' }}
    >
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Image
            src="/assets/bullradar.png"
            alt="xBullRadar — bull on a sentiment radar"
            width={909}
            height={819}
            priority
            className="mx-auto mb-4 w-full max-w-[320px]"
            sizes="(max-width: 640px) 280px, 320px"
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
          AI Market Radar · Tokenized RWAs
        </p>
      </div>
    </div>
  );
}
