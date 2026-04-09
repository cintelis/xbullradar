'use client';

// Inline-editable numeric cell. Click the displayed value to turn it
// into an input; press Enter or blur to commit, press Escape to cancel.
//
// Used in two places (so far): the Shares column of the portfolio
// holdings table, and the Amount column of the cash & equivalents
// section. Both share the same UX pattern but format their values
// differently and have slightly different validation rules, so the
// formatting + validation are passed as props.
//
// Design notes:
//
// - When NOT editing, we render a <button> not a <span>, so the cell is
//   keyboard-focusable and screen-reader-announceable as "click to edit".
//   The button looks identical to a span thanks to inheriting the parent
//   text styles.
//
// - On commit, we await the onSave promise. While the save is in flight
//   the input is disabled (avoids double-submits and confusing state).
//
// - We don't try to maintain focus across the edit→display→edit cycle
//   because users are mostly mouse-driven for portfolio editing. If
//   someone tab-walks the table they'll still get the cell focused
//   correctly via the button fallback.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

interface EditableNumberProps {
  /** Current numeric value. */
  value: number;
  /**
   * Called when the user commits a new value. May return a promise; the
   * input stays disabled until it resolves. Throwing/rejecting cancels
   * the edit and reverts to the previous value (the parent is expected
   * to surface the error via its own error state).
   */
  onSave: (next: number) => Promise<void> | void;
  /** Display formatter (e.g. `(n) => n.toFixed(2)` or `formatCurrency`). */
  format: (n: number) => string;
  /**
   * Optional client-side validation. Return an error string to reject
   * the edit BEFORE calling onSave (avoids round-tripping invalid input
   * through the server). Returning null/undefined means valid.
   */
  validate?: (n: number) => string | null | undefined;
  /** Disable the cell (e.g. while a parent mutation is in flight). */
  disabled?: boolean;
  /** HTML number input min. */
  min?: number;
  /** HTML number input step. Default "any" so decimals work. */
  step?: number | 'any';
  /** Additional class for the displayed value (the non-editing state). */
  displayClassName?: string;
  /** Additional class for the input (the editing state). */
  inputClassName?: string;
  /** Native tooltip on the displayed value, e.g. "Click to edit". */
  title?: string;
  /** aria-label for the editable cell. */
  ariaLabel?: string;
}

export function EditableNumber({
  value,
  onSave,
  format,
  validate,
  disabled,
  min,
  step = 'any',
  displayClassName = '',
  inputClassName = '',
  title = 'Click to edit',
  ariaLabel,
}: EditableNumberProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Tracks whether a commit is already in flight from this edit so the
  // blur handler doesn't double-fire when an Enter keypress causes the
  // input to lose focus.
  const committingRef = useRef(false);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function startEditing() {
    if (disabled) return;
    committingRef.current = false;
    setDraft(String(value));
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setDraft('');
    committingRef.current = false;
  }

  async function commitEditing() {
    if (committingRef.current) return;
    committingRef.current = true;

    const trimmed = draft.trim();
    if (!trimmed) {
      cancelEditing();
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      cancelEditing();
      return;
    }
    // No-op if value didn't change.
    if (parsed === value) {
      cancelEditing();
      return;
    }
    if (validate) {
      const err = validate(parsed);
      if (err) {
        // Don't call onSave; just cancel and let the user notice the
        // value snapped back. The parent's error state isn't engaged
        // here because we never round-tripped to the server.
        cancelEditing();
        return;
      }
    }

    setSaving(true);
    try {
      await onSave(parsed);
      setEditing(false);
      setDraft('');
    } catch {
      // Parent surfaces the error; revert UI here.
      cancelEditing();
    } finally {
      setSaving(false);
      committingRef.current = false;
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitEditing();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditing();
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commitEditing()}
        onKeyDown={onKeyDown}
        disabled={saving}
        min={min}
        step={step}
        aria-label={ariaLabel}
        className={`rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-right font-mono text-sm text-zinc-100 focus:border-green-600 focus:outline-none ${inputClassName}`}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={startEditing}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={`rounded border border-transparent px-1 py-0.5 text-right font-mono hover:border-zinc-700 hover:bg-zinc-900/60 disabled:cursor-not-allowed disabled:opacity-50 ${displayClassName}`}
    >
      {format(value)}
    </button>
  );
}
