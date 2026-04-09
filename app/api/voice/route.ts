// POST /api/voice — mint an ephemeral xAI Realtime client secret so the
// browser can open a direct WebSocket to wss://api.x.ai/v1/realtime.
//
// Architecture:
//   1. Browser POSTs to this route with no body (auth comes from session
//      cookie)
//   2. We auth-gate via getCurrentUser
//   3. We load the user's portfolio snapshot from the shared lib so the
//      voice bot has the same context the text bot does
//   4. We POST to xAI's /v1/realtime/client_secrets with the full
//      instructions (base prompt + voice addendum + portfolio snapshot)
//      embedded in the session config
//   5. We return { clientSecret, endpoint } to the browser
//
// The browser then opens a WebSocket directly to xAI using
// `xai-client-secret.${secret}` as the WebSocket subprotocol. All audio
// streaming happens client-side; the server is only involved in minting
// the secret. This minimizes round-trip latency on every voice turn.
//
// xAI Realtime is billed at $0.05/min ($3/hr) per active session.
// Concurrent session limit: 100/team. Max session duration: 30min.

import { type NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import {
  INVESTING_SYSTEM_PROMPT,
  VOICE_MODE_ADDENDUM,
} from '@/lib/copilot/prompt';
import { loadPortfolioContext } from '@/lib/copilot/context';

export const runtime = 'nodejs';

const XAI_REALTIME_ENDPOINT = 'wss://api.x.ai/v1/realtime';
const XAI_CLIENT_SECRETS_URL = 'https://api.x.ai/v1/realtime/client_secrets';

// Voice picked from xAI's catalog (eve, ara, rex, sal, leo). Eve is xAI's
// own default voice in their docs and reads as soft/non-masculine — a
// better match for an investing co-pilot than Leo (which cyberdoc uses).
const VOICE = 'eve';

// 10 minutes of session validity is plenty — xAI caps the session at
// 30min anyway, and the secret only needs to be valid at connection time.
const SECRET_TTL_SECONDS = 600;

export async function POST(_request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    console.error('[voice] XAI_API_KEY is not set');
    return Response.json(
      { error: 'Voice service not configured' },
      { status: 503 },
    );
  }

  // Build the full instructions: base persona + voice addendum + the
  // user's actual portfolio snapshot. Loaded fresh per session so the
  // bot always reflects the latest holdings.
  const portfolioSnapshot = await loadPortfolioContext(user.id).catch((err) => {
    console.warn('[voice] portfolio context load failed', err);
    return null;
  });

  const instructionParts = [INVESTING_SYSTEM_PROMPT, VOICE_MODE_ADDENDUM];
  if (portfolioSnapshot) {
    instructionParts.push('---', portfolioSnapshot);
  }
  const instructions = instructionParts.join('\n\n');

  try {
    const secretResp = await fetch(XAI_CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        expires_after: { seconds: SECRET_TTL_SECONDS },
        session: {
          voice: VOICE,
          instructions,
          turn_detection: { type: 'server_vad' },
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          tools: [
            {
              type: 'function',
              name: 'propose_holding_change',
              description:
                'Propose a change to the user\'s stock portfolio. This renders a confirmation card on the user\'s screen — the actual change only happens when the user clicks Confirm. ' +
                'IMPORTANT: you MUST get the user\'s explicit verbal consent BEFORE calling this tool. Say exactly what you plan to change and why, and wait for them to say "yes" or "go ahead". ' +
                'Do NOT call this tool on vague wording like "I\'m thinking about it" or "maybe". ' +
                'Use new_shares = 0 to propose removing a holding entirely. Use a positive number to set the holding to that many shares (not add — SET).',
              parameters: {
                type: 'object',
                properties: {
                  ticker: {
                    type: 'string',
                    description:
                      'Stock ticker symbol in uppercase, e.g. NVDA, MSFT',
                  },
                  new_shares: {
                    type: 'number',
                    description:
                      'The new total share count to set. 0 = remove holding. Must be non-negative.',
                  },
                  reason: {
                    type: 'string',
                    description:
                      'Brief explanation of why this change is being proposed. Shown on the confirmation card so the user can make an informed decision.',
                  },
                },
                required: ['ticker', 'new_shares', 'reason'],
                additionalProperties: false,
              },
            },
          ],
        },
      }),
    });

    if (!secretResp.ok) {
      const errText = await secretResp.text().catch(() => '');
      console.error(
        '[voice] xAI client_secrets failed',
        secretResp.status,
        errText,
      );
      return Response.json(
        { error: 'Failed to create voice session' },
        { status: 502 },
      );
    }

    const data = (await secretResp.json()) as {
      value?: string;
      expires_at?: number;
    };

    if (!data.value) {
      console.error('[voice] xAI client_secrets returned no value', data);
      return Response.json(
        { error: 'Invalid voice session response' },
        { status: 502 },
      );
    }

    return Response.json(
      {
        clientSecret: data.value,
        expiresAt: data.expires_at ?? null,
        endpoint: XAI_REALTIME_ENDPOINT,
      },
      {
        // Don't let any cache layer (Vercel edge, browser, etc.) hold on
        // to an ephemeral secret. Each connection needs a fresh one.
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  } catch (err) {
    console.error('[voice] unhandled error minting client secret', err);
    return Response.json(
      { error: 'Voice service unavailable' },
      { status: 502 },
    );
  }
}
