// Bounded, presentation-only conversion from jsdiff's line diff into stable
// rows a Svelte component can render directly (see RevisionHistory.svelte).
// Never mutates or normalizes stored content — hashes and restores always
// use the original bytes; this module only decides what to *show*.

import { diffLines } from 'diff';
import { MAX_DIFF_BYTES, MAX_DIFF_LINES, MAX_FALLBACK_BYTES } from './revisions';

export type LineEndingKind = 'none' | 'LF' | 'CRLF' | 'mixed';

export interface RevisionDiffLine {
  kind: 'context' | 'added' | 'removed' | 'marker';
  marker: '' | '+' | '-' | '\\';
  text: string;
}

export interface RevisionComparison {
  lines: RevisionDiffLine[];
  fromLineEndings: LineEndingKind;
  toLineEndings: LineEndingKind;
  oversized: boolean;
  truncated: boolean;
}

/** Detects the line-ending style actually present in `content`, without
 * normalizing anything — a lone `\r` (old Mac style) mixed with anything
 * else, or a genuine mix of `\r\n` and bare `\n`, both count as `mixed`.
 * Content with no line breaks at all (including empty content) is `none`,
 * since there's nothing to have a style. */
export function detectLineEndings(content: string): LineEndingKind {
  if (!/\r|\n/.test(content)) return 'none';
  const hasCrlf = /\r\n/.test(content);
  const remainder = content.replace(/\r\n/g, '');
  const hasBareLf = remainder.includes('\n');
  const hasBareCr = remainder.includes('\r');
  if (hasCrlf && !hasBareLf && !hasBareCr) return 'CRLF';
  if (!hasCrlf && hasBareLf && !hasBareCr) return 'LF';
  return 'mixed';
}

/** Below both thresholds, jsdiff and the sanitized Markdown renderer may
 * run directly. Above either one, callers must use the bounded fallback
 * instead — this function alone decides that boundary. */
export function isBoundedForRichComparison(content: string): boolean {
  return (
    new TextEncoder().encode(content).byteLength <= MAX_DIFF_BYTES &&
    content.split(/\r\n|\r|\n/).length <= MAX_DIFF_LINES
  );
}

function splitLinesKeepingTerminators(value: string): string[] {
  if (value === '') return [];
  return value.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

function stripTerminator(line: string): string {
  return line.replace(/\r\n$|\r$|\n$/, '');
}

function endsWithNewline(content: string): boolean {
  return /\r\n$|\r$|\n$/.test(content);
}

export function truncateToByteLimit(content: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(content);
  if (encoded.byteLength <= maxBytes) return { text: content, truncated: false };
  const slice = encoded.slice(0, maxBytes);
  let text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
  // A partial trailing multi-byte sequence decodes to U+FFFD; it isn't
  // real content, so drop it rather than showing a stray replacement glyph.
  if (text.endsWith('�')) text = text.slice(0, -1);
  return { text, truncated: true };
}

function pushLines(lines: RevisionDiffLine[], kind: 'removed' | 'added', text: string): void {
  const marker = kind === 'removed' ? '-' : '+';
  for (const rawLine of splitLinesKeepingTerminators(text)) {
    lines.push({ kind, marker, text: stripTerminator(rawLine) });
  }
}

/** Above either bound, no jsdiff/Markdown parsing runs at all — just a
 * capped, escaped plain-text excerpt of each side, independently truncated
 * so a huge revision can't inflate the current side's budget or vice versa. */
function buildTruncatedTextComparison(
  from: string,
  to: string,
  fromLineEndings: LineEndingKind,
  toLineEndings: LineEndingKind,
): RevisionComparison {
  const lines: RevisionDiffLine[] = [];
  const fromResult = truncateToByteLimit(from, MAX_FALLBACK_BYTES);
  const toResult = truncateToByteLimit(to, MAX_FALLBACK_BYTES);
  pushLines(lines, 'removed', fromResult.text);
  pushLines(lines, 'added', toResult.text);
  return {
    lines,
    fromLineEndings,
    toLineEndings,
    oversized: true,
    truncated: fromResult.truncated || toResult.truncated,
  };
}

/** Converts a bounded jsdiff line diff into stable presentation rows. Never
 * invokes jsdiff (or, by extension, the Markdown renderer for oversized
 * content elsewhere) above the byte/line thresholds — see
 * isBoundedForRichComparison. A missing final newline on either side is
 * rendered with the conventional marker row, attached independently to
 * whichever row represents that side's actual last line — the two sides'
 * last lines may not be the same row when the tail differs, but collapse
 * to a single marker when they are (e.g. identical content missing its
 * newline on both sides). */
export function buildRevisionComparison(from: string, to: string): RevisionComparison {
  const fromLineEndings = detectLineEndings(from);
  const toLineEndings = detectLineEndings(to);
  if (!isBoundedForRichComparison(from) || !isBoundedForRichComparison(to)) {
    return buildTruncatedTextComparison(from, to, fromLineEndings, toLineEndings);
  }

  const lines: RevisionDiffLine[] = [];
  let lastFromIndex = -1;
  let lastToIndex = -1;

  for (const change of diffLines(from, to)) {
    const kind: RevisionDiffLine['kind'] = change.added ? 'added' : change.removed ? 'removed' : 'context';
    const marker: RevisionDiffLine['marker'] = change.added ? '+' : change.removed ? '-' : '';
    for (const rawLine of splitLinesKeepingTerminators(change.value)) {
      lines.push({ kind, marker, text: stripTerminator(rawLine) });
      const index = lines.length - 1;
      if (kind !== 'added') lastFromIndex = index;
      if (kind !== 'removed') lastToIndex = index;
    }
  }

  const fromMissingNewline = from !== '' && !endsWithNewline(from);
  const toMissingNewline = to !== '' && !endsWithNewline(to);
  const markerIndices = new Set<number>();
  if (fromMissingNewline && lastFromIndex >= 0) markerIndices.add(lastFromIndex);
  if (toMissingNewline && lastToIndex >= 0) markerIndices.add(lastToIndex);
  for (const index of [...markerIndices].sort((a, b) => b - a)) {
    lines.splice(index + 1, 0, { kind: 'marker', marker: '\\', text: 'No newline at end of file' });
  }

  return { lines, fromLineEndings, toLineEndings, oversized: false, truncated: false };
}
