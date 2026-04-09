'use client';

// Voice session hook — wraps the xAI Realtime WebSocket lifecycle plus
// browser microphone capture and audio playback. Ported and stripped
// from the cyberdoc VoiceAgent component (which itself is ~1000 lines
// because it includes a draggable floating window, oscilloscope, mobile
// minimized bar, tool calls, and result cards — none of which apply to
// xbullradar's chat-panel mic button).
//
// Architecture per voice turn:
//
//   1. connect()
//      ├─ getUserMedia({ audio }) — must be in user-gesture stack
//      ├─ new AudioContext({ sampleRate: 24000 })
//      ├─ POST /api/voice → { clientSecret, endpoint }
//      ├─ new WebSocket(endpoint, `xai-client-secret.${secret}`)
//      └─ ws.onopen → session.update with voice/instructions/format
//
//   2. Microphone loop (ScriptProcessor.onaudioprocess)
//      ├─ Float32 → Int16 PCM → base64
//      └─ ws.send({ type: 'input_audio_buffer.append', audio: base64 })
//
//   3. Server VAD detects end-of-utterance, transcribes via Whisper,
//      generates a response, streams audio back as base64 PCM16 chunks
//
//   4. Inbound audio handler
//      ├─ base64 → Int16 → Float32 → AudioBuffer
//      └─ AudioContext.createBufferSource().start()
//
//   5. If user starts talking again mid-playback, server emits
//      input_audio_buffer.speech_started — we flush queued audio and
//      send response.cancel so the bot stops immediately.
//
// Notes:
//
//   - ScriptProcessor is deprecated in favor of AudioWorklet but still
//     works in every browser as of 2026. Worth migrating later.
//   - We don't implement push-to-talk — server VAD handles turn detection
//     automatically. The user just speaks and the server figures out when
//     they stopped.
//   - Tool calls are not implemented — the voice bot is conversational
//     only. Adding tool calls (e.g. "open Ondo for NVDA") would mean
//     plumbing function_call_arguments.done handlers + a way for the
//     hook to surface tool invocations to the parent component.

import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceMode =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'error';

export interface VoiceTranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
}

/**
 * Tool call handler function. The hook calls this when xAI sends a
 * response.function_call_arguments.done event. The handler receives
 * the parsed arguments and returns an output object that gets sent
 * back to xAI as the function_call_output.
 */
export type VoiceToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Map of tool-function name → handler. Register this via the `toolHandlers`
 * option when calling useVoiceSession. Keys must match the function names
 * declared in the xAI session config (app/api/voice/route.ts).
 */
export type VoiceToolHandlers = Record<string, VoiceToolHandler>;

export interface UseVoiceSessionOptions {
  /**
   * Tool call handlers. When the bot invokes a function, the hook looks
   * up the function name in this map and calls the handler. The returned
   * value is sent back to xAI as the function_call_output so the bot
   * can incorporate it into its next reply.
   *
   * If no handler is registered for a function name, the hook sends back
   * a generic error output and logs a warning.
   */
  toolHandlers?: VoiceToolHandlers;
}

export interface UseVoiceSessionResult {
  mode: VoiceMode;
  error: string | null;
  /** Live partial transcript of the assistant's current spoken reply. */
  liveAssistantText: string;
  /** Finalized turns from this session. */
  transcript: VoiceTranscriptEntry[];
  /** Seconds since the session connected. */
  elapsed: number;
  /** Open mic + WebSocket. Idempotent — calling while connected is a no-op. */
  connect: () => Promise<void>;
  /** Close mic + WebSocket. Idempotent. */
  disconnect: () => void;
  /** Send a text turn through the active session (typed-while-on-call). */
  sendText: (text: string) => boolean;
}

interface VoiceConfigResponse {
  clientSecret: string;
  expiresAt: number | null;
  endpoint: string;
  error?: string;
}

export function useVoiceSession(
  options: UseVoiceSessionOptions = {},
): UseVoiceSessionResult {
  const toolHandlersRef = useRef<VoiceToolHandlers>(options.toolHandlers ?? {});
  // Keep the ref in sync with the latest handlers so hot-reloads and
  // re-renders don't stale-capture the initial handlers.
  useEffect(() => {
    toolHandlersRef.current = options.toolHandlers ?? {};
  }, [options.toolHandlers]);

  const [mode, setMode] = useState<VoiceMode>('idle');
  const [error, setError] = useState<string | null>(null);
  const [liveAssistantText, setLiveAssistantText] = useState('');
  const [transcript, setTranscript] = useState<VoiceTranscriptEntry[]>([]);
  const [elapsed, setElapsed] = useState(0);

  // Refs for the bits of audio/network state that need to survive re-renders
  // without triggering them. Mirrors the cyberdoc pattern.
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const currentAudioSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const sessionReadyRef = useRef(false);
  const bufferedAudioRef = useRef<string[]>([]);
  const responseInFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const modeRef = useRef<VoiceMode>('idle');

  // Mirror mode → ref so onaudioprocess (which captures `mode` at definition
  // time, not on each call) sees the latest value without us having to
  // re-bind the processor every render.
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // ── Cleanup ────────────────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {
        // ignore
      }
      processorRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {
        // ignore
      }
      sourceRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (wsRef.current && wsRef.current.readyState <= 1) {
      try {
        wsRef.current.close();
      } catch {
        // ignore
      }
    }
    wsRef.current = null;
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
    }
    audioCtxRef.current = null;
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    if (currentAudioSrcRef.current) {
      try {
        currentAudioSrcRef.current.stop();
      } catch {
        // ignore
      }
      currentAudioSrcRef.current = null;
    }
    sessionReadyRef.current = false;
    bufferedAudioRef.current = [];
    responseInFlightRef.current = false;
  }, []);

  // ── Audio playback queue ───────────────────────────────────────────────
  const playNext = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx || audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }
    isPlayingRef.current = true;
    const f32 = audioQueueRef.current.shift()!;
    const buf = ctx.createBuffer(1, f32.length, 24000);
    buf.getChannelData(0).set(f32);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    currentAudioSrcRef.current = src;
    src.connect(ctx.destination);
    src.onended = () => {
      currentAudioSrcRef.current = null;
      playNext();
    };
    src.start();
  }, []);

  const queueAudio = useCallback(
    (b64: string) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const i16 = new Int16Array(bytes.buffer);
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
      audioQueueRef.current.push(f32);
      if (!isPlayingRef.current) playNext();
    },
    [playNext],
  );

  // ── Inbound message handler ───────────────────────────────────────────
  const handleMsg = useCallback(
    (msg: { type: string; [k: string]: unknown }) => {
      switch (msg.type) {
        case 'session.updated':
          sessionReadyRef.current = true;
          // Flush any audio frames captured before the session was ready.
          if (
            wsRef.current &&
            wsRef.current.readyState === WebSocket.OPEN &&
            bufferedAudioRef.current.length > 0
          ) {
            for (const audio of bufferedAudioRef.current) {
              wsRef.current.send(
                JSON.stringify({ type: 'input_audio_buffer.append', audio }),
              );
            }
            bufferedAudioRef.current = [];
          }
          break;

        case 'response.created':
          responseInFlightRef.current = true;
          setMode('speaking');
          break;

        case 'response.output_audio.delta':
          if (typeof msg.delta === 'string') queueAudio(msg.delta);
          break;

        case 'response.output_audio_transcript.delta':
          if (typeof msg.delta === 'string') {
            setLiveAssistantText((prev) => prev + msg.delta);
          }
          break;

        case 'response.output_audio_transcript.done':
          setLiveAssistantText((prev) => {
            if (prev.trim()) {
              setTranscript((t) => [
                ...t,
                {
                  id: `a-${Date.now()}`,
                  role: 'assistant',
                  text: prev.trim(),
                },
              ]);
            }
            return '';
          });
          break;

        case 'response.done':
          responseInFlightRef.current = false;
          setMode((m) => (m === 'speaking' ? 'listening' : m));
          break;

        case 'conversation.item.input_audio_transcription.completed': {
          const t = msg.transcript;
          if (typeof t === 'string' && t.trim()) {
            setTranscript((p) => [
              ...p,
              { id: `u-${Date.now()}`, role: 'user', text: t.trim() },
            ]);
          }
          break;
        }

        case 'input_audio_buffer.speech_started':
          // User started talking again — flush queued playback + interrupt
          // any in-flight server response so the bot stops mid-sentence
          // instead of stepping on the user.
          audioQueueRef.current = [];
          if (currentAudioSrcRef.current) {
            try {
              currentAudioSrcRef.current.stop();
            } catch {
              // ignore
            }
            currentAudioSrcRef.current = null;
          }
          isPlayingRef.current = false;
          if (
            responseInFlightRef.current &&
            wsRef.current?.readyState === WebSocket.OPEN
          ) {
            wsRef.current.send(JSON.stringify({ type: 'response.cancel' }));
            responseInFlightRef.current = false;
          }
          setLiveAssistantText('');
          setMode('listening');
          break;

        case 'response.function_call_arguments.done':
          // Bot invoked a tool. Look up the handler, call it, send output
          // back to xAI so the bot can continue the conversation.
          void handleFunctionCall(msg);
          break;

        case 'error': {
          const errMsg =
            (msg.error as { message?: string } | undefined)?.message ??
            'Voice error';
          setError(errMsg);
          responseInFlightRef.current = false;
          break;
        }

        default:
          break;
      }
    },
    [queueAudio],
  );

  /**
   * Handle a tool invocation from xAI. Parses the arguments, calls the
   * registered handler, and sends the output back over the WebSocket so
   * the bot can weave the result into its next spoken reply.
   */
  async function handleFunctionCall(msg: Record<string, unknown>) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const callId = typeof msg.call_id === 'string' ? msg.call_id : '';
    const name = typeof msg.name === 'string' ? msg.name : '';

    let args: Record<string, unknown> = {};
    try {
      args =
        typeof msg.arguments === 'string'
          ? (JSON.parse(msg.arguments) as Record<string, unknown>)
          : {};
    } catch {
      args = {};
    }

    const handler = toolHandlersRef.current[name];
    let output: unknown;
    if (handler) {
      try {
        output = await handler(args);
      } catch (err) {
        console.error(`[voice] tool handler "${name}" threw`, err);
        output = { error: `Tool handler error: ${(err as Error).message}` };
      }
    } else {
      console.warn(`[voice] no handler for tool "${name}"`);
      output = { error: `Unknown tool: ${name}` };
    }

    // Send the output back to xAI.
    ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: typeof output === 'string' ? output : JSON.stringify(output),
        },
      }),
    );

    // Request the bot to continue after processing the tool result.
    responseInFlightRef.current = false;
    ws.send(JSON.stringify({ type: 'response.create' }));
  }

  // ── Mic capture ────────────────────────────────────────────────────────
  const startMic = useCallback(
    (stream: MediaStream, ws: WebSocket, ctx: AudioContext) => {
      const src = ctx.createMediaStreamSource(stream);
      sourceRef.current = src;
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = proc;
      proc.onaudioprocess = (e) => {
        if (
          !ws ||
          ws.readyState !== WebSocket.OPEN ||
          modeRef.current === 'idle' ||
          modeRef.current === 'error'
        ) {
          return;
        }
        const f = e.inputBuffer.getChannelData(0);
        const i16 = new Int16Array(f.length);
        for (let i = 0; i < f.length; i++) {
          i16[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32768)));
        }
        const b = new Uint8Array(i16.buffer);
        let s = '';
        for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
        const audio = btoa(s);
        if (!sessionReadyRef.current) {
          // Buffer until session.updated arrives — otherwise xAI rejects
          // the audio frames.
          bufferedAudioRef.current.push(audio);
          return;
        }
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
      };
      src.connect(proc);
      proc.connect(ctx.destination);
    },
    [],
  );

  // ── Connect ────────────────────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (modeRef.current !== 'idle' && modeRef.current !== 'error') return;

    setMode('connecting');
    setError(null);
    setTranscript([]);
    setLiveAssistantText('');
    setElapsed(0);
    sessionReadyRef.current = false;
    bufferedAudioRef.current = [];
    responseInFlightRef.current = false;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone not available in this browser.');
      }

      // iOS quirk: AudioContext + getUserMedia must be in the synchronous
      // call stack of a user gesture. No awaits before these calls.
      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const audioCtx = new AudioContextCtor({ sampleRate: 24000 });
      audioCtxRef.current = audioCtx;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        const err = e as Error & { name?: string };
        if (err.name === 'NotAllowedError') {
          throw new Error(
            'Microphone permission denied. Allow mic access in your browser settings and try again.',
          );
        }
        throw new Error(`Microphone error: ${err.message}`);
      }
      streamRef.current = stream;

      if (audioCtx.state === 'suspended') await audioCtx.resume();

      const resp = await fetch('/api/voice', { method: 'POST' });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error || `Voice setup failed (${resp.status})`,
        );
      }
      const config = (await resp.json()) as VoiceConfigResponse;
      if (!config.clientSecret) throw new Error('No client secret returned');

      let ws: WebSocket;
      try {
        ws = new WebSocket(
          config.endpoint,
          `xai-client-secret.${config.clientSecret}`,
        );
      } catch {
        // Fallback to multi-protocol form for browsers that reject the
        // single-string subprotocol shape.
        ws = new WebSocket(config.endpoint, [
          'realtime',
          `xai-client-secret.${config.clientSecret}`,
        ]);
      }
      wsRef.current = ws;

      ws.onopen = () => {
        // The session config (voice, instructions, audio formats) was
        // already baked into the ephemeral secret on the server, so we
        // don't need to re-send it here. Just start streaming mic audio.
        startMic(stream, ws, audioCtx);
        setMode('listening');
        timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
        sessionReadyRef.current = true;
      };

      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        try {
          handleMsg(JSON.parse(e.data));
        } catch {
          // ignore malformed
        }
      };

      ws.onerror = () => {
        setError('Voice connection failed. Try again.');
        setMode('error');
      };

      ws.onclose = () => {
        if (modeRef.current !== 'idle' && modeRef.current !== 'error') {
          setMode('idle');
        }
        cleanup();
      };
    } catch (err) {
      setError((err as Error).message);
      setMode('error');
      cleanup();
    }
  }, [cleanup, handleMsg, startMic]);

  // ── Disconnect ─────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    cleanup();
    setMode('idle');
  }, [cleanup]);

  // ── Send a text turn over the active session ──────────────────────────
  const sendText = useCallback((text: string): boolean => {
    const trimmed = text.trim();
    const ws = wsRef.current;
    if (
      !trimmed ||
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      !sessionReadyRef.current
    ) {
      return false;
    }
    ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: trimmed }],
        },
      }),
    );
    ws.send(JSON.stringify({ type: 'response.create' }));
    setTranscript((p) => [
      ...p,
      { id: `u-${Date.now()}`, role: 'user', text: trimmed },
    ]);
    return true;
  }, []);

  // ── Cleanup on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    mode,
    error,
    liveAssistantText,
    transcript,
    elapsed,
    connect,
    disconnect,
    sendText,
  };
}
