'use client';

// Voice mode UI — renders the live transcript + connection status while
// the voice session is active. Lives inside CopilotChat and replaces the
// text message list when the user has started a voice session.
//
// Design intent: minimal. The mic button in the chat input row is the
// canonical "I want voice" gesture; this component is just feedback for
// what's happening on the audio channel.

import { useEffect, useRef } from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';
import Linkify from './Linkify';
import ConfirmChangeCard, {
  type PendingProposal,
} from './ConfirmChangeCard';
import type {
  VoiceMode as VoiceModeType,
  VoiceTranscriptEntry,
} from '@/hooks/useVoiceSession';

interface VoiceModeProps {
  mode: VoiceModeType;
  error: string | null;
  liveAssistantText: string;
  transcript: VoiceTranscriptEntry[];
  elapsed: number;
  onDisconnect: () => void;
  /** Pending portfolio change proposals from tool calls. */
  proposals?: PendingProposal[];
  onProposalConfirm?: (id: string) => void;
  onProposalCancel?: (id: string) => void;
}

export default function VoiceMode({
  mode,
  error,
  liveAssistantText,
  transcript,
  elapsed,
  onDisconnect,
  proposals = [],
  onProposalConfirm,
  onProposalCancel,
}: VoiceModeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the transcript area as new turns arrive — same pattern as
  // the text chat MessageBubble list.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [transcript, liveAssistantText, proposals]);

  return (
    // flex-1 + min-h-0 is the magic combo that lets the inner transcript
    // div actually scroll inside a nested flex-column parent. Without
    // min-h-0, the flex item grows to fit content instead of shrinking
    // to fit the container, and overflow-auto becomes a no-op. Without
    // flex-1, we don't fill the chat panel's available height.
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Status header — replaces the chat input area's "Thinking…" hint */}
      <div className="shrink-0 border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <StatusIndicator mode={mode} />
            <span className="text-xs text-zinc-400">{statusLabel(mode)}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-zinc-500">
              {formatElapsed(elapsed)}
            </span>
            <button
              type="button"
              onClick={onDisconnect}
              className="rounded-md border border-red-900/60 bg-red-950/40 px-2.5 py-1 text-xs font-semibold text-red-300 transition hover:bg-red-950/70"
              aria-label="End voice session"
            >
              End call
            </button>
          </div>
        </div>
        {error && (
          <p className="mt-2 rounded-md border border-red-900/50 bg-red-950/30 px-2 py-1 text-xs text-red-400">
            {error}
          </p>
        )}
      </div>

      {/* Transcript area — finalized turns + the live partial.
          min-h-0 lets this flex child shrink so overflow-auto can kick in. */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-4 overflow-auto p-4"
      >
        {transcript.length === 0 && !liveAssistantText && (
          <p className="text-sm text-zinc-500">
            Start speaking. The bot is listening — your words and its replies
            will appear here as you talk.
          </p>
        )}
        {transcript.map((m) => (
          <TranscriptBubble key={m.id} entry={m} />
        ))}
        {liveAssistantText && (
          <TranscriptBubble
            entry={{
              id: 'live',
              role: 'assistant',
              text: liveAssistantText,
            }}
            partial
          />
        )}
        {proposals.length > 0 &&
          proposals.map((p) => (
            <ConfirmChangeCard
              key={p.id}
              proposal={p}
              onConfirm={onProposalConfirm ?? (() => {})}
              onCancel={onProposalCancel ?? (() => {})}
            />
          ))}
      </div>
    </div>
  );
}

function StatusIndicator({ mode }: { mode: VoiceModeType }) {
  if (mode === 'connecting') {
    return <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />;
  }
  if (mode === 'error' || mode === 'idle') {
    return <MicOff className="h-4 w-4 text-zinc-600" />;
  }
  // listening (waiting for user) — green pulse
  // speaking (bot is talking)  — cyan pulse
  const color = mode === 'speaking' ? 'bg-cyan-400' : 'bg-green-500';
  return (
    <span className="relative flex h-3 w-3 items-center justify-center">
      <span
        className={`absolute inline-flex h-full w-full animate-ping rounded-full ${color} opacity-60`}
      />
      <span
        className={`relative inline-flex h-2 w-2 rounded-full ${color}`}
      />
    </span>
  );
}

function statusLabel(mode: VoiceModeType): string {
  switch (mode) {
    case 'connecting':
      return 'Connecting…';
    case 'listening':
      return 'Listening — speak now';
    case 'speaking':
      return 'Speaking…';
    case 'error':
      return 'Connection error';
    default:
      return 'Idle';
  }
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function TranscriptBubble({
  entry,
  partial,
}: {
  entry: VoiceTranscriptEntry;
  partial?: boolean;
}) {
  const isUser = entry.role === 'user';
  return (
    <div className={isUser ? 'text-right' : ''}>
      <div
        className={
          'inline-block max-w-[85%] rounded-xl px-4 py-2 text-left text-sm ' +
          (isUser
            ? 'bg-green-600 text-white'
            : 'bg-zinc-900 text-zinc-100') +
          (partial ? ' opacity-80' : '')
        }
      >
        <p className="whitespace-pre-wrap">
          <Linkify text={entry.text} />
          {partial && <span className="ml-1 inline-block animate-pulse">▍</span>}
        </p>
      </div>
    </div>
  );
}

export { Mic };
