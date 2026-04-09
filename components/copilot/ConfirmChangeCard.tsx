'use client';

// Two-stage commit confirmation card for voice-initiated portfolio
// changes. When the voice bot calls the propose_holding_change tool,
// the frontend renders this card inline in the voice transcript (or
// text chat) and waits for an explicit user click before mutating.
//
// The LLM never directly modifies the portfolio — it can only propose.
// The user's physical click on Confirm is the authoritative action.
// This sidesteps the "LLM confabulates consent" risk entirely.

import { Loader2 } from 'lucide-react';

export type ProposalStatus = 'pending' | 'confirming' | 'confirmed' | 'cancelled';

export interface PendingProposal {
  id: string;
  /** xAI tool call id — needed to send output back. Already sent by the
   *  time the card renders; kept for traceability. */
  callId: string;
  ticker: string;
  /** Current shares the user holds. 0 if adding a new holding. */
  currentShares: number;
  newShares: number;
  reason: string;
  status: ProposalStatus;
}

interface ConfirmChangeCardProps {
  proposal: PendingProposal;
  onConfirm: (id: string) => void;
  onCancel: (id: string) => void;
}

export default function ConfirmChangeCard({
  proposal,
  onConfirm,
  onCancel,
}: ConfirmChangeCardProps) {
  const { id, ticker, currentShares, newShares, reason, status } = proposal;
  const isAdd = currentShares === 0 && newShares > 0;
  const isRemove = newShares === 0;

  const actionLabel = isAdd
    ? `Add ${ticker}`
    : isRemove
      ? `Remove ${ticker}`
      : `${ticker}: ${currentShares} → ${newShares} shares`;

  return (
    <div className="my-2 rounded-xl border border-amber-700/50 bg-amber-950/20 p-3 text-sm">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-400">
        Portfolio change proposal
      </p>
      <p className="font-medium text-zinc-100">{actionLabel}</p>
      {reason && (
        <p className="mt-1 text-xs text-zinc-400">{reason}</p>
      )}

      {status === 'pending' && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => onConfirm(id)}
            className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-green-500"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={() => onCancel(id)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
          >
            Cancel
          </button>
        </div>
      )}

      {status === 'confirming' && (
        <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          Updating portfolio…
        </div>
      )}

      {status === 'confirmed' && (
        <p className="mt-2 text-xs text-green-400">
          Done — portfolio updated.
        </p>
      )}

      {status === 'cancelled' && (
        <p className="mt-2 text-xs text-zinc-500">
          Cancelled — no changes made.
        </p>
      )}
    </div>
  );
}
