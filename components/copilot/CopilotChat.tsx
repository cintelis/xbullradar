'use client';

// Custom chat UI ("Option B") — intentionally NOT using @copilotkit/react-ui
// or @copilotkit/runtime. We talk directly to /api/copilot using a flat
// JSON wire format defined in @/types and render generative UI (ActButton)
// inline by inspecting the assistant message's `ui` field.

import { useState, useRef, useEffect } from 'react';
import { Mic, Send, Trash2, ChevronRight } from 'lucide-react';
import ActButton from './ActButton';
import VoiceMode from './VoiceMode';
import { Button } from '@/components/ui/button';
import { useVoiceSession } from '@/hooks/useVoiceSession';
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
  role: 'user' | 'assistant';
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

  // Voice session — when mode !== 'idle', we render <VoiceMode /> in place
  // of the text message list. The single chat input button switches between
  // mic-icon (empty input → click to start voice) and send-icon (text in
  // input → click to send a text turn).
  const voice = useVoiceSession();
  const voiceActive = voice.mode !== 'idle' && voice.mode !== 'error';
  const prevVoiceActiveRef = useRef(voiceActive);

  // When the voice session ends, fold its transcript into the text chat
  // history. The text history is already persisted to localStorage by the
  // useEffect below, so this gives us free voice persistence — users can
  // scroll back through past voice conversations alongside their text
  // ones, share them with us as examples, etc.
  //
  // Each voice message gets source: 'voice' so MessageBubble can render
  // it with a small mic indicator. We also slot in a system divider to
  // mark where the voice conversation started.
  useEffect(() => {
    const wasActive = prevVoiceActiveRef.current;
    prevVoiceActiveRef.current = voiceActive;
    if (!wasActive || voiceActive) return;
    if (voice.transcript.length === 0) return;

    const folded: ChatMessage[] = voice.transcript.map((t) => ({
      id: `v-${t.id}`,
      role: t.role === 'user' ? 'user' : 'assistant',
      content: t.text,
      source: 'voice',
    }));
    setMessages((prev) => [...prev, ...folded]);
  }, [voiceActive, voice.transcript]);

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
          <button
            type="button"
            onClick={clearChat}
            disabled={loading || messages.length <= 1}
            title="Clear conversation"
            aria-label="Clear conversation"
            className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Trash2 className="h-4 w-4" />
          </button>
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
        <p className="whitespace-pre-wrap">{msg.content}</p>
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
