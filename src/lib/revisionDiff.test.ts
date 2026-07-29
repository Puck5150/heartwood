import { describe, expect, it } from 'vitest';
import { MAX_DIFF_BYTES, MAX_DIFF_LINES, MAX_FALLBACK_BYTES } from './revisions';
import { buildRevisionComparison, detectLineEndings, isBoundedForRichComparison } from './revisionDiff';

describe('detectLineEndings', () => {
  it('detects LF-only content', () => {
    expect(detectLineEndings('one\ntwo\nthree')).toBe('LF');
  });

  it('detects CRLF-only content', () => {
    expect(detectLineEndings('one\r\ntwo\r\nthree')).toBe('CRLF');
  });

  it('detects mixed content', () => {
    expect(detectLineEndings('one\r\ntwo\nthree')).toBe('mixed');
  });

  it('treats a lone CR as mixed', () => {
    expect(detectLineEndings('one\rtwo')).toBe('mixed');
  });

  it('reports none for content with no line breaks', () => {
    expect(detectLineEndings('one line only')).toBe('none');
    expect(detectLineEndings('')).toBe('none');
  });
});

describe('buildRevisionComparison', () => {
  it('marks added, removed, and context lines', () => {
    const result = buildRevisionComparison('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
    expect(result.lines.some((line) => line.kind === 'context' && line.text === 'one')).toBe(true);
    expect(result.lines.some((line) => line.kind === 'removed' && line.text === 'two')).toBe(true);
    expect(result.lines.some((line) => line.kind === 'added' && line.text === 'TWO')).toBe(true);
    expect(result.lines.some((line) => line.kind === 'context' && line.text === 'three')).toBe(true);
  });

  it('reports each side detected line endings independently', () => {
    const result = buildRevisionComparison('one\r\ntwo', 'one\nthree\n');
    expect(result.fromLineEndings).toBe('CRLF');
    expect(result.toLineEndings).toBe('LF');
    expect(result.lines.some((line) => line.kind === 'removed')).toBe(true);
    expect(result.lines.some((line) => line.kind === 'added')).toBe(true);
  });

  it('keeps a pure line-ending change visible rather than normalizing it away', () => {
    const result = buildRevisionComparison('one\r\ntwo\r\n', 'one\ntwo\n');
    expect(result.fromLineEndings).toBe('CRLF');
    expect(result.toLineEndings).toBe('LF');
    // Content is textually identical, but the byte-level difference must
    // still surface as a change, not collapse into pure context.
    expect(result.lines.some((line) => line.kind === 'removed' || line.kind === 'added')).toBe(true);
  });

  it('marks a missing final newline on the revision side only', () => {
    const result = buildRevisionComparison('one\ntwo', 'one\ntwo\n');
    const markerIndex = result.lines.findIndex((line) => line.kind === 'marker');
    expect(markerIndex).toBeGreaterThan(-1);
    expect(result.lines[markerIndex].text).toBe('No newline at end of file');
  });

  it('marks a missing final newline on the current side only', () => {
    const result = buildRevisionComparison('one\ntwo\n', 'one\ntwo');
    expect(result.lines.some((line) => line.kind === 'marker')).toBe(true);
  });

  it('does not mark a missing newline for genuinely empty content', () => {
    const result = buildRevisionComparison('', '');
    expect(result.lines.some((line) => line.kind === 'marker')).toBe(false);
  });

  it('emits only one marker when both sides share the same missing-newline line', () => {
    const result = buildRevisionComparison('same content, no trailing newline', 'same content, no trailing newline');
    const markers = result.lines.filter((line) => line.kind === 'marker');
    expect(markers).toHaveLength(1);
  });

  it('handles empty current content against non-empty revision content', () => {
    const result = buildRevisionComparison('was here\n', '');
    expect(result.lines.some((line) => line.kind === 'removed' && line.text === 'was here')).toBe(true);
    expect(result.lines.some((line) => line.kind === 'added')).toBe(false);
  });

  it('handles empty revision content against non-empty current content', () => {
    const result = buildRevisionComparison('', 'now here\n');
    expect(result.lines.some((line) => line.kind === 'added' && line.text === 'now here')).toBe(true);
  });

  it('preserves Unicode content exactly', () => {
    const result = buildRevisionComparison('café\n☕\n', 'café\n🍵\n');
    expect(result.lines.some((line) => line.kind === 'context' && line.text === 'café')).toBe(true);
    expect(result.lines.some((line) => line.kind === 'removed' && line.text === '☕')).toBe(true);
    expect(result.lines.some((line) => line.kind === 'added' && line.text === '🍵')).toBe(true);
  });

  it('falls back to a bounded excerpt above the byte threshold and never runs jsdiff', () => {
    const huge = 'x'.repeat(MAX_DIFF_BYTES + 1);
    const result = buildRevisionComparison(huge, 'small');
    expect(result.oversized).toBe(true);
    expect(result.truncated).toBe(true);
    const totalBytes = result.lines.reduce((sum, line) => sum + new TextEncoder().encode(line.text).byteLength, 0);
    expect(totalBytes).toBeLessThanOrEqual(MAX_FALLBACK_BYTES * 2); // both sides capped independently
  });

  it('falls back to a bounded excerpt above the line-count threshold', () => {
    const manyLines = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line ${i}`).join('\n');
    const result = buildRevisionComparison(manyLines, 'small');
    expect(result.oversized).toBe(true);
  });

  it('is usable for content with no trailing newline and a single unbroken line', () => {
    const result = buildRevisionComparison('no newline here', 'no newline here either');
    expect(result.lines.length).toBeGreaterThan(0);
  });
});

describe('isBoundedForRichComparison', () => {
  it('accepts content under both thresholds', () => {
    expect(isBoundedForRichComparison('hello world')).toBe(true);
  });

  it('rejects content over the byte threshold', () => {
    expect(isBoundedForRichComparison('x'.repeat(MAX_DIFF_BYTES + 1))).toBe(false);
  });

  it('rejects content over the line threshold', () => {
    const manyLines = Array.from({ length: MAX_DIFF_LINES + 1 }, () => 'x').join('\n');
    expect(isBoundedForRichComparison(manyLines)).toBe(false);
  });
});
