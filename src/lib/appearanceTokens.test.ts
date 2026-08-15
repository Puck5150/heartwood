// Structural + contrast tests against the authored CSS text in
// src/app.css — not against a rendered DOM, since jsdom doesn't compute
// real CSS cascade/contrast. Reads the file as text and extracts each
// exact selector block, so a missing theme/mode/accent selector or a
// missing required token fails loudly and specifically rather than as a
// vague rendering difference.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_CSS_PATH = join(process.cwd(), 'src/app.css');
const appCss = readFileSync(APP_CSS_PATH, 'utf8');

const THEME_FAMILIES = [
  'sunlit',
  'cozy',
  'quiet-natural',
  'coastal-air',
  'night-walk',
  'moon-garden',
  'graphite',
] as const;
const APPEARANCE_MODES = ['light', 'dark'] as const;
const TIMER_ACCENTS = ['blue', 'green', 'orange', 'red', 'yellow'] as const;

const REQUIRED_THEME_TOKENS = [
  '--app-background',
  '--surface',
  '--surface-secondary',
  '--text',
  '--text-muted',
  '--border',
  '--focus-ring',
  '--shadow',
  '--timer-track',
  '--flow-accent',
  '--flow-surface',
  '--break-accent',
  '--break-surface',
  '--danger',
  '--on-danger',
] as const;

function declarationsFor(css: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  if (!match) throw new Error(`Missing selector: ${selector}`);
  return new Map([...match[1].matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)].map((entry) => [entry[1], entry[2].trim()]));
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.trim().replace('#', '');
  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(hexA: string, hexB: string): number {
  const [l1, l2] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

function collectFiles(directory: string, include: (path: string) => boolean): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(path, include);
    return include(path) ? [path] : [];
  });
}

describe('theme token completeness', () => {
  for (const family of THEME_FAMILIES) {
    for (const mode of APPEARANCE_MODES) {
      const selector = `[data-theme='${family}'][data-appearance='${mode}']`;

      it(`${family} ${mode} defines every required semantic token`, () => {
        const declarations = declarationsFor(appCss, selector);
        for (const token of REQUIRED_THEME_TOKENS) {
          expect(declarations.has(token), `${selector} is missing ${token}`).toBe(true);
        }
      });
    }
  }

  for (const mode of APPEARANCE_MODES) {
    for (const accent of TIMER_ACCENTS) {
      const selector = `[data-appearance='${mode}'][data-timer-accent='${accent}']`;

      it(`${mode}/${accent} defines --timer-accent and --on-timer-accent`, () => {
        const declarations = declarationsFor(appCss, selector);
        expect(declarations.has('--timer-accent')).toBe(true);
        expect(declarations.has('--on-timer-accent')).toBe(true);
      });
    }
  }
});

describe('theme token contrast (WCAG AA)', () => {
  for (const family of THEME_FAMILIES) {
    for (const mode of APPEARANCE_MODES) {
      const selector = `[data-theme='${family}'][data-appearance='${mode}']`;

      it(`${family} ${mode} meets AA contrast for text, muted text, and the focus ring`, () => {
        const d = declarationsFor(appCss, selector);
        const appBackground = d.get('--app-background')!;
        const surface = d.get('--surface')!;
        const text = d.get('--text')!;
        const textMuted = d.get('--text-muted')!;
        const focusRing = d.get('--focus-ring')!;
        const onDanger = d.get('--on-danger')!;
        const danger = d.get('--danger')!;

        expect(contrast(text, appBackground)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(textMuted, appBackground)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(focusRing, appBackground)).toBeGreaterThanOrEqual(3);
        expect(contrast(onDanger, danger)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  // The full 7 themes x 2 modes x 5 accents = 70 matrix: every mode-specific
  // timer accent verified against every theme's background in that same
  // mode, plus each accent's own foreground pairing.
  for (const family of THEME_FAMILIES) {
    for (const mode of APPEARANCE_MODES) {
      for (const accent of TIMER_ACCENTS) {
        it(`${accent} timer accent meets AA contrast against ${family} ${mode}'s background`, () => {
          const themeDeclarations = declarationsFor(appCss, `[data-theme='${family}'][data-appearance='${mode}']`);
          const accentDeclarations = declarationsFor(appCss, `[data-appearance='${mode}'][data-timer-accent='${accent}']`);
          const appBackground = themeDeclarations.get('--app-background')!;
          const timerAccent = accentDeclarations.get('--timer-accent')!;
          const onTimerAccent = accentDeclarations.get('--on-timer-accent')!;

          expect(contrast(timerAccent, appBackground)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(onTimerAccent, timerAccent)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});

describe('non-text UI boundary contrast (WCAG 1.4.11)', () => {
  // Regression test for an Impeccable audit finding: BreakdownChart.svelte's
  // and History.svelte's idle-state toggle border originally used --border,
  // which measures well under the 3:1 non-text floor against --surface in
  // every theme — and a first fix attempt swapped the *background* instead
  // of the border, which didn't touch the actual boundary color at all and
  // still failed. The real fix reuses --text-muted (already proven ≥4.5:1
  // for text contrast above), which comfortably clears 3:1 too. This test
  // is what should have caught both failures before they shipped.
  for (const family of THEME_FAMILIES) {
    for (const mode of APPEARANCE_MODES) {
      const selector = `[data-theme='${family}'][data-appearance='${mode}']`;

      it(`idle chart-toggle border (--text-muted) clears WCAG 1.4.11 against --surface in ${family} ${mode}`, () => {
        const d = declarationsFor(appCss, selector);
        const surface = d.get('--surface')!;
        const textMuted = d.get('--text-muted')!;

        expect(contrast(textMuted, surface)).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

describe('no component references a pre-Phase-5A raw token', () => {
  it('every .svelte file under src/ uses only semantic tokens, never the old palette names', () => {
    const componentCss = collectFiles('src', (path) => path.endsWith('.svelte'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    expect(componentCss).not.toMatch(/var\(--(?:bg|accent|accent-contrast|track|surface-flow|surface-break)\)/);
  });
});

// Every card/framed tool in the app — not just Phase 5A's own new chrome
// — stays at 8px radius or less per the approved visual contract; a
// circular/pill shape (a progress track, e.g.) is a different affordance
// and stays exempt.
function radiiInPx(css: string): number[] {
  return [...css.matchAll(/border-radius:\s*([\d.]+)(rem|px|em)/g)]
    .map(([, value, unit]) => Number(value) * (unit === 'px' ? 1 : 16))
    .filter((px) => px < 999);
}

describe('every card/framed tool stays within the approved 8px radius contract', () => {
  for (const path of collectFiles('src', (p) => p.endsWith('.svelte'))) {
    it(`${path} uses no card/frame radius greater than 8px`, () => {
      const css = readFileSync(path, 'utf8');
      for (const px of radiiInPx(css)) {
        expect(px, `${path} has a border-radius of ${px}px`).toBeLessThanOrEqual(8);
      }
    });
  }
});

describe('no component hardcodes a raw CSS color', () => {
  it('every .svelte file under src/ uses only semantic tokens, never a bare named color or hex literal', () => {
    const NAMED_COLORS = ['red', 'green', 'blue', 'orange', 'yellow', 'purple', 'pink'];
    for (const path of collectFiles('src', (p) => p.endsWith('.svelte'))) {
      const css = readFileSync(path, 'utf8');
      for (const color of NAMED_COLORS) {
        expect(css, `${path} references bare color "${color}" inside color-mix()`).not.toMatch(
          new RegExp(`color-mix\\([^)]*\\b${color}\\b`),
        );
      }
      expect(css, `${path} has a raw hex color literal`).not.toMatch(/:\s*#[0-9a-fA-F]{3,8}\b/);
      // rgb()/rgba() functional syntax bypasses the hex-literal check above
      // entirely (see SoundscapePopover.svelte's former hardcoded
      // `box-shadow: 0 12px 30px rgb(0 0 0 / 0.18)`, found by an
      // Impeccable audit) — every color must route through a token, and a
      // token reference never itself contains a raw rgb()/rgba() call.
      // `color-mix(in srgb, ...)` is unaffected: "srgb" is never followed
      // by "(", only rgb()/rgba() as an actual function call are.
      expect(css, `${path} has a raw rgb()/rgba() color literal`).not.toMatch(/\brgba?\(/);
    }
  });
});
