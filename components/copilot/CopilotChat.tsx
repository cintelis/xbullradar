'use client';

// Custom chat UI ("Option B") — intentionally NOT using @copilotkit/react-ui
// or @copilotkit/runtime. We talk directly to /api/copilot using a flat
// JSON wire format defined in @/types and render generative UI (ActButton)
// inline by inspecting the assistant message's `ui` field.

import { useState, useRef, useEffect } from 'react';
import { Send, Trash2 } from 'lucide-react';
import ActButton from './ActButton';
import { Button } from '@/components/ui/button';
import type { CopilotResponse, CopilotUiAction } from '@/types';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ui?: CopilotUiAction;
  citations?: string[];
}

const STORAGE_KEY = 'xbullradar:chat:v1';

const WELCOME_MESSAGE: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content:
    "Hi! Ask me about a stock, your portfolio, or what's trending on X right now.",
};

export default function CopilotChat() {
  // Initial state matches the SSR render — we hydrate from localStorage in
  // an effect to avoid hydration mismatches.
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [previousResponseId, setPreviousResponseId] = useState<string | undefined>();
  const [hydrated, setHydrated] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-auto p-4">
        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}
        {loading && (
          <p className="text-sm text-zinc-500">Thinking…</p>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex gap-2 border-t border-zinc-800 p-4"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Sentiment on NVDA?"
          disabled={loading}
          className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
        />
        <Button type="submit" variant="primary" disabled={loading || !input.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
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
