'use client';

// Custom chat UI ("Option B") — intentionally NOT using @copilotkit/react-ui
// or @copilotkit/runtime. We talk directly to /api/copilot using a flat
// JSON wire format defined in @/types and render generative UI (ActButton)
// inline by inspecting the assistant message's `ui` field.

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Download, Mic, Send, Trash2, ChevronRight } from 'lucide-react';
import ActButton from './ActButton';
import Linkify from './Linkify';
import VoiceMode from './VoiceMode';
import ConfirmChangeCard, {
  type PendingProposal,
  type ProposalStatus,
} from './ConfirmChangeCard';
import { Button } from '@/components/ui/button';
import { useVoiceSession, type VoiceToolHandlers } from '@/hooks/useVoiceSession';
import type { CopilotResponse, CopilotUiAction } from '@/types';

interface CopilotChatProps {
  /**
   * Optional callback to hide the chat panel. Provided by Dashboard on
   * desktop where the sidebar can collapse the chat. Mobile chat tab
   * doesn't pass this — the hide button is hidden when the prop is absent.
   */
  onHide?: () => void;
}

interface ChatMessage {
  id: string;
  /**
   * 'user' / 'assistant' are normal turn bubbles. 'system' is a divider
   * line — used to mark the start of a folded-in voice session with a
   * timestamp and duration so users (and exports) can tell sessions
   * apart.
   */
  role: 'user' | 'assistant' | 'system';
  content: string;
  ui?: CopilotUiAction;
  citations?: string[];
  /**
   * If 'voice', this message originated from a voice session and was
   * folded into the text history when the call ended. Renders with a
   * small mic indicator so the user knows it was spoken, not typed.
   */
  source?: 'voice';
}

const STORAGE_KEY = 'xbullradar:chat:v1';

const WELCOME_MESSAGE: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content:
    "Hi! Ask me about a stock, your portfolio, or what's trending on X right now.",
};

export default function CopilotChat({ onHide }: CopilotChatProps = {}) {
  // Initial state matches the SSR render — we hydrate from localStorage in
  // an effect to avoid hydration mismatches.
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [previousResponseId, setPreviousResponseId] = useState<string | undefined>();
  const [hydrated, setHydrated] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Pending portfolio change proposals from voice tool calls. Each entry
  // is a two-stage commit card: the bot proposes, the user confirms.
  const [proposals, setProposals] = useState<PendingProposal[]>([]);

  // Ondo "Act on" buttons rendered by the show_ondo_link voice tool.
  const [ondoLinks, setOndoLinks] = useState<
    Array<{ id: string; ticker: string; ondoSymbol: string }>
  >([]);

  const handleProposalConfirm = useCallback(async (id: string) => {
    setProposals((prev) =>
      prev.map((p) => (p.id === id ? { ...p, status: 'confirming' as ProposalStatus } : p)),
    );
    const proposal = proposals.find((p) => p.id === id);
    if (!proposal) return;

    try {
      // Load current holdings so we can merge the change.
      const res = await fetch('/api/portfolio');
      const data = await res.json();
      const holdings: Array<{ ticker: string; shares: number }> =
        (data.holdings ?? []).map((h: { ticker: string; shares: number }) => ({
          ticker: h.ticker,
          shares: h.shares,
        }));

      let next: Array<{ ticker: string; shares: number }>;
      if (proposal.newShares === 0) {
        // Remove the holding.
        next = holdings.filter(
          (h) => h.ticker.toUpperCase() !== proposal.ticker.toUpperCase(),
        );
      } else {
        const exists = holdings.some(
          (h) => h.ticker.toUpperCase() === proposal.ticker.toUpperCase(),
        );
        if (exists) {
          next = holdings.map((h) =>
            h.ticker.toUpperCase() === proposal.ticker.toUpperCase()
              ? { ...h, shares: proposal.newShares }
              : h,
          );
        } else {
          next = [...holdings, { ticker: proposal.ticker.toUpperCase(), shares: proposal.newShares }];
        }
      }

      const putRes = await fetch('/api/portfolio', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdings: next }),
      });
      if (!putRes.ok) {
        const err = await putRes.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${putRes.status}`);
      }

      setProposals((prev) =>
        prev.map((p) => (p.id === id ? { ...p, status: 'confirmed' as ProposalStatus } : p)),
      );
      // Notify PortfolioView to refresh.
      window.dispatchEvent(new CustomEvent('portfolio:updated'));
    } catch (err) {
      console.error('[copilot] portfolio update failed', err);
      setProposals((prev) =>
        prev.map((p) => (p.id === id ? { ...p, status: 'pending' as ProposalStatus } : p)),
      );
    }
  }, [proposals]);

  const handleProposalCancel = useCallback((id: string) => {
    setProposals((prev) =>
      prev.map((p) => (p.id === id ? { ...p, status: 'cancelled' as ProposalStatus } : p)),
    );
  }, []);

  // Voice tool handlers — registered with useVoiceSession so the hook
  // can dispatch tool calls from xAI to our handlers.
  const toolHandlers: VoiceToolHandlers = useMemo(
    () => ({
      show_ondo_link: async (args: Record<string, unknown>) => {
        const ticker =
          typeof args.ticker === 'string'
            ? args.ticker.trim().toUpperCase()
            : '';
        if (!ticker) return { error: 'Missing ticker.' };
        const ondoSymbol = `${ticker.toLowerCase()}on`;
        setOndoLinks((prev) => [
          ...prev,
          {
            id: `ondo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            ticker,
            ondoSymbol,
          },
        ]);
        return {
          shown: true,
          message: `Showing "Act on ${ticker}on" button on user's screen. They can click it to open Ondo Finance.`,
        };
      },

      propose_holding_change: async (args: Record<string, unknown>) => {
        const ticker =
          typeof args.ticker === 'string'
            ? args.ticker.trim().toUpperCase()
            : '';
        const newShares =
          typeof args.new_shares === 'number' ? args.new_shares : 0;
        const reason =
          typeof args.reason === 'string' ? args.reason : '';

        if (!ticker) {
          return { error: 'Missing ticker.' };
        }

        // Fetch current shares so the card can show "50 → 40".
        let currentShares = 0;
        try {
          const res = await fetch('/api/portfolio');
          const data = await res.json();
          const match = (data.holdings ?? []).find(
            (h: { ticker: string }) =>
              h.ticker.toUpperCase() === ticker,
          );
          if (match) currentShares = match.shares;
        } catch {
          // Non-critical — card will show 0 → newShares which is still
          // understandable.
        }

        const proposal: PendingProposal = {
          id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          callId: '',
          ticker,
          currentShares,
          newShares,
          reason,
          status: 'pending',
        };
        setProposals((prev) => [...prev, proposal]);

        return {
          proposed: true,
          message: `Confirmation card shown to user for ${ticker}: ${currentShares} → ${newShares} shares. User must click Confirm on screen.`,
        };
      },
    }),
    [],
  );

  // Voice session — when mode !== 'idle', we render <VoiceMode /> in place
  // of the text message list. The single chat input button switches between
  // mic-icon (empty input → click to start voice) and send-icon (text in
  // input → click to send a text turn).
  const voice = useVoiceSession({ toolHandlers });
  const voiceActive = voice.mode !== 'idle' && voice.mode !== 'error';
  const prevVoiceActiveRef = useRef(voiceActive);

  // Two-state morphing button: starts as Export → click downloads chat
  // → button morphs to Trash → click clears chat → resets to Export.
  // Any new message resets `exported` to false so users know there's
  // unsaved content.
  const [exported, setExported] = useState(false);

  // When the voice session ends, fold its transcript into the text chat
  // history. The text history is already persisted to localStorage by the
  // useEffect below, so this gives us free voice persistence — users can
  // scroll back through past voice conversations alongside their text
  // ones, share them with us as examples, etc.
  //
  // Each voice message gets source: 'voice' so MessageBubble can render
  // it with a small mic indicator. We also prepend a system divider that
  // includes the start time + duration of the call so multiple voice
  // sessions in the same chat are visually + textually distinguishable.
  useEffect(() => {
    const wasActive = prevVoiceActiveRef.current;
    prevVoiceActiveRef.current = voiceActive;
    if (!wasActive || voiceActive) return;
    if (voice.transcript.length === 0) return;

    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - voice.elapsed * 1000);
    const divider: ChatMessage = {
      id: `vs-${endedAt.getTime()}`,
      role: 'system',
      content: `Voice call · ${formatSessionStart(startedAt)} · ${formatSessionDuration(voice.elapsed)}`,
    };
    const folded: ChatMessage[] = voice.transcript.map((t) => ({
      id: `v-${t.id}`,
      role: t.role === 'user' ? 'user' : 'assistant',
      content: t.text,
      source: 'voice',
    }));
    setMessages((prev) => [...prev, divider, ...folded]);
    setExported(false);
  }, [voiceActive, voice.transcript, voice.elapsed]);

  // Any new text-mode message also flips exported back to false so the
  // header button reverts to Export icon.
  useEffect(() => {
    if (messages.length > 1) setExported(false);
    // We deliberately watch messages length, not the array, to avoid
    // resetting on every keystroke / re-render. New turns push length up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  /**
   * Build the exportable message list. Combines the persisted text
   * history with the LIVE voice transcript when a voice call is in
   * progress, so users can export mid-call without having to End Call
   * first. The live partial assistant reply is also included as a
   * trailing in-progress bubble so the export reflects exactly what
   * the user sees on screen.
   *
   * Returns null if there's nothing meaningful to export (just the
   * welcome message and no voice activity).
   */
  function buildExportMessages(): ChatMessage[] | null {
    const out: ChatMessage[] = [...messages];
    if (voiceActive && voice.transcript.length > 0) {
      // Synthesize a divider for the in-progress call so the export
      // makes the boundary clear even though the call hasn't ended.
      out.push({
        id: `vs-live-${Date.now()}`,
        role: 'system',
        content: `Voice call (in progress) · started ${formatSessionStart(
          new Date(Date.now() - voice.elapsed * 1000),
        )} · ${formatSessionDuration(voice.elapsed)} so far`,
      });
      for (const t of voice.transcript) {
        out.push({
          id: `v-live-${t.id}`,
          role: t.role === 'user' ? 'user' : 'assistant',
          content: t.text,
          source: 'voice',
        });
      }
      if (voice.liveAssistantText.trim()) {
        out.push({
          id: 'v-live-partial',
          role: 'assistant',
          content: `${voice.liveAssistantText.trim()} … (still speaking)`,
          source: 'voice',
        });
      }
    }
    // Filter out the welcome message — it's the only one with id
    // 'welcome' and we never want to export it.
    const meaningful = out.filter((m) => m.id !== 'welcome');
    if (meaningful.length === 0) return null;
    return meaningful;
  }

  function exportChat() {
    const exportMessages = buildExportMessages();
    if (!exportMessages) return;
    const text = formatChatAsText(exportMessages);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadTextFile(`xbullradar-chat-${stamp}.txt`, text);
    setExported(true);
  }

  /**
   * Whether there's anything to export. Either persisted text history
   * (messages beyond just the welcome bubble) or a live voice transcript
   * counts. Used to gate the export button's enabled state.
   */
  const hasExportableContent =
    messages.length > 1 || voice.transcript.length > 0;

  // Hydrate from localStorage once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.messages) && parsed.messages.length > 0) {
          setMessages(parsed.messages);
        }
        if (typeof parsed?.previousResponseId === 'string') {
          setPreviousResponseId(parsed.previousResponseId);
        }
      }
    } catch {
      // Corrupted storage — ignore and start fresh.
    }
    setHydrated(true);
  }, []);

  // Persist messages + Grok thread id after every change (post-hydration).
  // Gate on `hydrated` so we don't overwrite stored history with the empty
  // initial state on first mount.
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ messages, previousResponseId }),
      );
    } catch {
      // localStorage may be full, disabled, or in a private window — ignore.
    }
  }, [messages, previousResponseId, hydrated]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  function clearChat() {
    setMessages([WELCOME_MESSAGE]);
    setPreviousResponseId(undefined);
    setExported(false);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          previousResponseId,
        }),
      });

      const data = (await res.json()) as CopilotResponse;

      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: data.message,
          ui: data.ui,
          citations: data.citations,
        },
      ]);

      if (data.responseId) setPreviousResponseId(data.responseId);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: 'Network error reaching the assistant. Please try again.',
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between border-b border-zinc-800 p-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            🤖 XBullRadar Assistant
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Powered by Grok · Real-time X sentiment
          </p>
        </div>
        <div className="flex items-center gap-1">
          {/* Morphing Export ↔ Trash button. Default Export icon — click
              downloads the conversation as a .txt file, then morphs to
              Trash. Click Trash to clear the chat. New messages reset
              the button back to Export so users always know whether
              they have unsaved content. */}
          {exported ? (
            <button
              type="button"
              onClick={clearChat}
              disabled={loading || messages.length <= 1}
              title="Clear conversation (already exported)"
              aria-label="Clear conversation"
              className="rounded-md p-1.5 text-red-400 transition hover:bg-zinc-900 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={exportChat}
              disabled={loading || !hasExportableContent}
              title={
                voiceActive && voice.transcript.length > 0
                  ? 'Export conversation (includes live voice call)'
                  : 'Export conversation to text file'
              }
              aria-label="Export conversation"
              className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <Download className="h-4 w-4" />
            </button>
          )}
          {onHide && (
            <button
              type="button"
              onClick={onHide}
              title="Hide chat"
              aria-label="Hide chat"
              className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {voiceActive ? (
        <VoiceMode
          mode={voice.mode}
          error={voice.error}
          liveAssistantText={voice.liveAssistantText}
          transcript={voice.transcript}
          elapsed={voice.elapsed}
          onDisconnect={voice.disconnect}
          proposals={proposals}
          onProposalConfirm={handleProposalConfirm}
          onProposalCancel={handleProposalCancel}
          ondoLinks={ondoLinks}
        />
      ) : (
        <>
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-auto p-4">
            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}
            {loading && <p className="text-sm text-zinc-500">Thinking…</p>}
            {voice.error && (
              <p className="rounded-md border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-400">
                Voice error: {voice.error}
              </p>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              // Form submit (Enter or button click) only sends text — never
              // starts voice. This way Enter is unambiguous: it sends what
              // you typed, or does nothing when the input is empty. Voice
              // requires an intentional click on the mic icon, not an
              // accidental Enter on an empty field.
              if (input.trim()) send();
            }}
            className="flex gap-2 border-t border-zinc-800 p-4"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask, or click the mic to talk"
              disabled={loading}
              className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
            />
            {input.trim() ? (
              <Button
                type="submit"
                variant="primary"
                disabled={loading}
                title="Send message"
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                type="button"
                variant="primary"
                disabled={loading}
                onClick={() => voice.connect()}
                title="Talk to the bot"
                aria-label="Start voice session"
              >
                <Mic className="h-4 w-4" />
              </Button>
            )}
          </form>
        </>
      )}
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  // System messages render as a centered horizontal divider with the
  // label inline — used for voice-call timestamp markers. Not a bubble.
  if (msg.role === 'system') {
    return (
      <div className="flex items-center gap-2 py-1 text-[11px] uppercase tracking-wide text-zinc-600">
        <div className="h-px flex-1 bg-zinc-800" />
        <span>{msg.content}</span>
        <div className="h-px flex-1 bg-zinc-800" />
      </div>
    );
  }

  const isUser = msg.role === 'user';
  const isVoice = msg.source === 'voice';
  return (
    <div className={isUser ? 'text-right' : ''}>
      <div
        className={
          'inline-block max-w-[85%] rounded-xl px-4 py-2 text-left text-sm ' +
          (isUser
            ? 'bg-green-600 text-white'
            : 'bg-zinc-900 text-zinc-100')
        }
      >
        {isVoice && (
          <div
            className={
              'mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide ' +
              (isUser ? 'text-green-200' : 'text-zinc-500')
            }
          >
            <Mic className="h-2.5 w-2.5" />
            voice
          </div>
        )}
        <p className="whitespace-pre-wrap"><Linkify text={msg.content} /></p>
        {msg.ui?.type === 'showActButton' && (
          <div className="mt-3">
            <ActButton
              asset={{
                ticker: msg.ui.props.ticker,
                ondoSymbol: msg.ui.props.ondoSymbol,
                sentimentScore: msg.ui.props.sentimentScore,
                reasoning: msg.ui.props.reasoning,
              }}
            />
          </div>
        )}
        {!isUser && msg.citations && msg.citations.length > 0 && (
          <Citations urls={msg.citations} />
        )}
      </div>
    </div>
  );
}

function Citations({ urls }: { urls: string[] }) {
  // Cap to keep the bubble compact; "+N more" hints at the rest.
  const MAX = 5;
  const shown = urls.slice(0, MAX);
  const extra = urls.length - shown.length;

  return (
    <div className="mt-3 border-t border-zinc-800 pt-2 text-xs">
      <p className="mb-1 text-zinc-500">
        Based on {urls.length} {urls.length === 1 ? 'source' : 'sources'}
      </p>
      <ul className="space-y-1">
        {shown.map((url, i) => (
          <li key={url} className="truncate">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 hover:text-green-400 hover:underline"
              title={url}
            >
              [{i + 1}] {hostnameOf(url)}
            </a>
          </li>
        ))}
      </ul>
      {extra > 0 && (
        <p className="mt-1 text-zinc-600">+{extra} more</p>
      )}
    </div>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// ─── Export helpers ─────────────────────────────────────────────────────

/**
 * Format the chat history as a plain-text export. Designed for two
 * audiences: the user reading their own conversation later, and us
 * receiving examples to tune the system prompt.
 *
 * Each turn is tagged with [user] / [assistant] (with `· voice` suffix
 * if it came from a voice session). System dividers (e.g. "Voice call ·
 * 2:32 PM · 3m 21s") get rendered as section headers between turn
 * groups so multi-session histories are scannable.
 */
function formatChatAsText(messages: ChatMessage[]): string {
  const generated = new Date();
  const lines: string[] = [];
  lines.push('xBullRadar conversation export');
  lines.push(`Generated: ${generated.toISOString()}`);
  lines.push('');

  for (const m of messages) {
    if (m.id === 'welcome') continue;

    if (m.role === 'system') {
      lines.push('');
      lines.push('═'.repeat(60));
      lines.push(m.content);
      lines.push('═'.repeat(60));
      lines.push('');
      continue;
    }

    const tag =
      m.source === 'voice' ? `[${m.role} · voice]` : `[${m.role}]`;
    lines.push(`${tag} ${m.content}`);
    if (!('role' in m && m.role === 'user') && m.citations && m.citations.length > 0) {
      for (let i = 0; i < m.citations.length; i++) {
        lines.push(`  [${i + 1}] ${m.citations[i]}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Trigger a browser download of a text file. No network round-trip. */
function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the click has time to fire in all browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "Apr 9, 2:32 PM" — short, locale-agnostic-ish, fits in a divider. */
function formatSessionStart(date: Date): string {
  const month = date.toLocaleString('en-US', { month: 'short' });
  const day = date.getDate();
  let hour = date.getHours();
  const minute = String(date.getMinutes()).padStart(2, '0');
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 === 0 ? 12 : hour % 12;
  return `${month} ${day}, ${hour}:${minute} ${ampm}`;
}

/** "3m 21s" / "45s" — duration format for session dividers. */
function formatSessionDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}
