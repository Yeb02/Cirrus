import { expect, test } from 'vitest';
import { CITE_KEY_TAG, DEFAULT_PREAMBLE, LABEL_TAG, safeLabel, titleToTex } from '../src/latex.ts';

test('titleToTex : les caractères actifs de TeX deviennent du texte (Review Focus 1)', () => {
  expect(titleToTex('50 % & co_x #1 {a} ~ ^ \\input{x}')).toBe(
    String.raw`50 \% \& co\_x \#1 \{a\} \textasciitilde{} \textasciicircum{} \textbackslash{}input\{x\}`,
  );
  expect(titleToTex('$x$')).toBe(String.raw`\$x\$`);
});

test('titleToTex : le latin et la ponctuation typographique restent tels quels', () => {
  expect(titleToTex('Rasoir d’Occam — été')).toBe('Rasoir d’Occam — été');
  expect(titleToTex('‘a’ “b” « c » 1–2 x… a·b')).toBe('‘a’ “b” « c » 1–2 x… a·b');
  // But for TeX's special characters, ¬ and ± (math), the control characters and the letters LaTeX does not set up.
  const elsewhere = new Set('\\#$%&_{}~^¬±ĦħĸĿŀŉŦŧſ');
  for (let c = 0x20; c <= 0x17f; c++) {
    const ch = String.fromCodePoint(c);
    if (elsewhere.has(ch) || (c >= 0x7f && c <= 0x9f)) continue;
    expect(titleToTex(ch), `U+${c.toString(16)}`).toBe(ch);
  }
});

test('titleToTex : les lettres que LaTeX ne connaît pas en UTF-8 (mesuré sous le préambule par défaut) deviennent « ? »', () => {
  expect(titleToTex('ĦħĸĿŀŉŦŧſ')).toBe('?????????');
  expect(titleToTex('Łódź, Ærø, Œuvre, Ŵ')).toBe('Łódź, Ærø, Œuvre, Ŵ');
});

test('titleToTex : grec et symboles mathématiques passent par \\ensuremath', () => {
  expect(titleToTex('θ ≤ ∑ ℝ')).toBe(String.raw`\ensuremath{\theta} \ensuremath{\leq} \ensuremath{\sum} \ensuremath{\mathbb{R}}`);
  expect(titleToTex('ο Ο Α Γ ς')).toBe(String.raw`\ensuremath{o} \ensuremath{\mathrm{O}} \ensuremath{\mathrm{A}} \ensuremath{\Gamma} \ensuremath{\varsigma}`);
  expect(titleToTex('¬p ± 1')).toBe(String.raw`\ensuremath{\neg}p \ensuremath{\pm} 1`);
  // Each listed character has its entry, and nothing of it is left as is.
  for (const ch of 'αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ≤≥≠≈≡∼∝∞∑∏∫∂∇√±∓→←↔⇒⇐⇔∈∉⊂⊆⊃⊇∪∩∅∀∃¬∧∨ℓℕℤℚℝℂ') {
    expect(titleToTex(ch), ch).toMatch(/^\\ensuremath\{[^?]+\}$/);
  }
});

test('titleToTex : tout autre caractère devient « ? », un par caractère (paires de substitution comprises)', () => {
  expect(titleToTex('中😀')).toBe('??');
  expect(titleToTex('a\tb\nc\u0000d\u007fe\u0085f')).toBe('a?b?c?d?e?f');
});

test('safeLabel : 1 à 200 caractères, sans \\ { } % # ni caractère de contrôle', () => {
  for (const name of ['eq:mdl', 'fig:a_b', 'thm 2', 'x'.repeat(200), 'été']) expect(safeLabel(name), name).toBe(true);
  for (const name of ['', 'a}b', 'a{b', 'a\\b', 'a%b', 'a#b', 'x'.repeat(201), 'a\u0007b', 'a\nb', 'a\u009fb']) expect(safeLabel(name), JSON.stringify(name)).toBe(false);
});

test('le préambule par défaut et les noms des tags', () => {
  expect(DEFAULT_PREAMBLE.startsWith('\\documentclass[11pt,a4paper]{article}\n')).toBe(true);
  expect(DEFAULT_PREAMBLE.split('\n')).toHaveLength(9);
  expect(DEFAULT_PREAMBLE).toContain('\\usepackage{amsmath,amssymb,amsthm}\n');
  expect(DEFAULT_PREAMBLE).not.toContain('\\begin{document}');
  expect([CITE_KEY_TAG, LABEL_TAG]).toEqual(['clé_bibtex', 'label']);
});
