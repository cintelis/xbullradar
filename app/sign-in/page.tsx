import { redirect } from 'next/navigation';
import { Activity } from 'lucide-react';
import SignInForm from '@/components/auth/SignInForm';
import { getCurrentUser } from '@/lib/auth';

interface SignInPageProps {
  searchParams: Promise<{ error?: string }>;
}

/**
 * Sign-in page. Server component — checks for an existing session first
 * and redirects to the dashboard if already authenticated. Otherwise
 * renders the magic-link form.
 */
export default async function SignInPage({ searchParams }: SignInPageProps) {
  const user = await getCurrentUser();
  if (user) {
    redirect('/');
  }

  const params = await searchParams;
  const initialError = params.error ?? null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-green-600">
            <Activity className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-2xl font-semibold text-zinc-100">xBullRadar</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Real-time X sentiment · Powered by Grok
          </p>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
          <SignInForm initialError={initialError} />
        </div>

        <p className="text-center text-xs text-zinc-600">
          Limited trial · Invite only
        </p>
      </div>
    </div>
  );
}
