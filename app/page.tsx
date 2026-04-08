import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import Dashboard from '@/components/dashboard/Dashboard';

/**
 * Dashboard page (server component). Checks for an authenticated session
 * and redirects to /sign-in if missing. Otherwise renders the interactive
 * Dashboard client component with the current user's email passed in.
 *
 * Auth check happens at request time, before any HTML is generated, so
 * unauthenticated visitors never see the dashboard shell.
 */
export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/sign-in');
  }

  return <Dashboard userEmail={user.email} />;
}
