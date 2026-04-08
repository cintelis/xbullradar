'use client';

import { useState, type FormEvent } from 'react';
import { Mail, ArrowRight, CheckCircle2 } from 'lucide-react';

interface SignInFormProps {
  initialError?: string | null;
}

const ERROR_MESSAGES: Record<string, string> = {
  TOKEN_INVALID: 'Sign-in link is invalid or has expired. Request a new one below.',
  TOKEN_MISSING: 'Sign-in link is missing. Request a new one below.',
  NOT_ALLOWLISTED: 'This email is not approved for the trial.',
  INVALID_EMAIL: 'Please enter a valid email address.',
};

export default function SignInForm({ initialError }: SignInFormProps) {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(
    initialError ? ERROR_MESSAGES[initialError] ?? 'Something went wrong. Please try again.' : null,
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch('/api/auth/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data?.error || 'Could not send sign-in email. Please try again.');
        return;
      }
      setSent(true);
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
          <CheckCircle2 className="h-6 w-6 text-green-500" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Check your email</h2>
          <p className="mt-2 text-sm text-zinc-400">
            We sent a sign-in link to <span className="text-zinc-200">{email.trim()}</span>.
            <br />
            The link expires in 15 minutes.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setSent(false);
            setEmail('');
          }}
          className="text-xs text-zinc-500 underline-offset-4 hover:text-zinc-300 hover:underline"
        >
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && (
        <div className="rounded-md border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      <label className="block">
        <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          Email address
        </span>
        <div className="relative">
          <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            disabled={submitting}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2.5 pl-10 pr-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
          />
        </div>
      </label>

      <button
        type="submit"
        disabled={submitting || !email.trim()}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Sending…' : 'Send sign-in link'}
        {!submitting && <ArrowRight className="h-4 w-4" />}
      </button>

      <p className="text-center text-xs text-zinc-600">
        We'll email you a one-time link. No password required.
      </p>
    </form>
  );
}
