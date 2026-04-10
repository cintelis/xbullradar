'use client';

// Auto-link URLs in plain text. Used in both voice transcript bubbles
// and text chat message bubbles so any URL the bot mentions (especially
// Ondo Finance links) becomes clickable without requiring a dedicated
// tool call or special formatting.
//
// The regex is intentionally conservative — it matches http(s):// URLs
// only, not bare domains or email addresses. This avoids false positives
// on things like "2.5%" or "U.S." that a greedy regex would catch.

import { Fragment } from 'react';

const URL_REGEX = /https?:\/\/[^\s<>)"']+/gi;

interface LinkifyProps {
  text: string;
  /** Class applied to the <a> elements. */
  linkClassName?: string;
}

/**
 * Renders a text string with embedded URLs converted to clickable links.
 * Non-URL text is rendered as-is. All links open in a new tab with
 * noopener noreferrer.
 */
export default function Linkify({
  text,
  linkClassName = 'underline break-all hover:text-green-400 transition',
}: LinkifyProps) {
  const parts: Array<{ type: 'text' | 'link'; value: string }> = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_REGEX)) {
    const url = match[0];
    const index = match.index!;
    if (index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, index) });
    }
    // Strip trailing punctuation that's likely sentence-ending, not part
    // of the URL (e.g. "check https://example.com." → the "." is prose).
    const cleaned = url.replace(/[.,;:!?)]+$/, '');
    const trailing = url.slice(cleaned.length);
    parts.push({ type: 'link', value: cleaned });
    if (trailing) {
      parts.push({ type: 'text', value: trailing });
    }
    lastIndex = index + url.length;
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }

  // Fast path: no URLs found → return plain text (avoids extra DOM nodes).
  if (parts.length === 0 || (parts.length === 1 && parts[0].type === 'text')) {
    return <>{text}</>;
  }

  return (
    <>
      {parts.map((part, i) =>
        part.type === 'link' ? (
          <a
            key={i}
            href={part.value}
            target="_blank"
            rel="noopener noreferrer"
            className={linkClassName}
          >
            {part.value}
          </a>
        ) : (
          <Fragment key={i}>{part.value}</Fragment>
        ),
      )}
    </>
  );
}
