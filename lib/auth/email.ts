// Email send for xBullRadar auth flows.
//
// Calls the 365soft email worker (Cloudflare Worker → Microsoft Graph) at
// https://email.365softlabs.com/api/send. The worker is gated by Cloudflare
// Access; we authenticate with a service token via CF-Access-Client-Id and
// CF-Access-Client-Secret headers.
//
// Pattern ported from C:\code\ads-optimiser-landing\functions\api\send.js
// and C:\code\adsoptimiser-tiktok\src\worker\src\services\email.ts.

const DEFAULT_EMAIL_API_URL = 'https://email.365softlabs.com/api/send';
// admin@xbullradar.com is a real mailbox in the M365 tenant the email worker
// authenticates to; the app principal has Mail.Send permission for it.
// Override via EMAIL_FROM env var if you ever need a different sender.
const DEFAULT_EMAIL_FROM = 'admin@xbullradar.com';

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

class EmailServiceError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
    this.name = 'EmailServiceError';
  }
}

function resolveEmailApiUrl(): string {
  return (process.env.EMAIL_API_URL || DEFAULT_EMAIL_API_URL).trim();
}

function resolveEmailFrom(): string {
  return (process.env.EMAIL_FROM || DEFAULT_EMAIL_FROM).trim();
}

/**
 * Low-level email send. Throws EmailServiceError on any failure so callers
 * can decide whether to retry, log, or surface to the user.
 */
export async function sendEmail({ to, subject, html }: SendEmailInput): Promise<void> {
  const apiUrl = resolveEmailApiUrl();
  const clientId = (process.env.CF_ACCESS_CLIENT_ID || '').trim();
  const clientSecret = (process.env.CF_ACCESS_CLIENT_SECRET || '').trim();

  if (!clientId || !clientSecret) {
    throw new EmailServiceError(
      'CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set in env to send email',
      500,
    );
  }

  const payload = {
    to: to.trim(),
    subject: subject.trim(),
    message: html,
    contentType: 'HTML',
    fromEmail: resolveEmailFrom(),
    // Auth emails are transactional — never block on the unsubscribe list,
    // otherwise users who opted out of marketing get locked out of sign-in.
    respectUnsubscribe: false,
  };

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Access-Client-Id': clientId,
      'CF-Access-Client-Secret': clientSecret,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new EmailServiceError(
      `Email worker returned ${res.status}: ${text || res.statusText}`,
      res.status,
    );
  }
}

// ─── Magic link template ────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveAppUrl(): string {
  // Vercel auto-injects VERCEL_URL (without scheme) on every deployment.
  // NEXT_PUBLIC_APP_URL is a manual override (e.g. for custom domains).
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel}`;
  return 'http://localhost:3000';
}

export async function sendMagicLinkEmail(input: {
  email: string;
  token: string;
  expiresInMinutes: number;
}): Promise<void> {
  const verifyUrl = `${resolveAppUrl()}/auth/verify?token=${encodeURIComponent(input.token)}`;
  const expiresInMinutes = Math.max(1, Math.floor(input.expiresInMinutes || 15));
  const safeUrl = escapeHtml(verifyUrl);

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#e4e4e7;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;background:#18181b;border:1px solid #27272a;border-radius:16px;padding:32px;">
            <tr>
              <td>
                <p style="margin:0 0 12px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#71717a;">xBullRadar</p>
                <h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:#fafafa;">Sign in to xBullRadar</h1>
                <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#a1a1aa;">Click the button below to sign in. This link expires in ${expiresInMinutes} minutes and can only be used once.</p>
                <p style="margin:0 0 24px;">
                  <a href="${verifyUrl}" style="display:inline-block;padding:14px 24px;border-radius:10px;background:#22c55e;color:#0a0a0a;text-decoration:none;font-weight:600;font-size:15px;">Sign In</a>
                </p>
                <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#71717a;">If the button doesn't work, copy and paste this link:</p>
                <p style="margin:0 0 24px;font-size:12px;line-height:1.6;word-break:break-all;color:#22c55e;">${safeUrl}</p>
                <hr style="border:none;border-top:1px solid #27272a;margin:24px 0 16px;" />
                <p style="margin:0;font-size:12px;line-height:1.6;color:#52525b;">If you didn't request this, you can safely ignore this email — no account has been created.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  await sendEmail({
    to: input.email,
    subject: 'Sign in to xBullRadar',
    html,
  });
}
