'use strict';

// Identidade visual: os tokens do painel e as combinações de cor usadas pelos componentes.
// Texto >= 4,5:1, borda de campo >= 3:1, texto preto sobre dourado, sem laranja, sem fonte externa
// e tema claro único (fundo branco). O contraste do que está de fato na tela é medido em identidade-visual.spec.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const theme = read('painel/tema-mcs.css');
const layer = read('painel/identidade.css');
const html = read('painel/index.html');

const tokens = Object.fromEntries([...theme.slice(theme.indexOf(':root {'), theme.indexOf('}', theme.indexOf(':root {'))).matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex) => { const [r, g, b] = rgb(hex).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const token = (name) => { assert.match(tokens[name] || '', /^#[0-9A-Fa-f]{6}$/, name); return tokens[name]; };

test('tokens: valores da identidade My Car Scout', () => {
  const expected = {
    'mcs-bg': '#FFFFFF', 'mcs-surface': '#FFFFFF', 'mcs-card': '#FFFFFF', 'mcs-elevated': '#F4F4F5', 'mcs-line': '#E4E4E7', 'mcs-field-line': '#8A8A93',
    'mcs-gold': '#C69632', 'mcs-text': '#0B0B0D', 'mcs-text-2': '#52525B', 'mcs-muted': '#52525B', 'mcs-faint': '#6B6B74',
    'mcs-red': '#B91C1C', 'mcs-red-strong': '#DC2626', 'mcs-amber': '#735C00', 'mcs-green': '#15803D', 'mcs-blue': '#1D5FA3', 'mcs-neutral': '#52525B', 'mcs-on-gold': '#0B0B0D'
  };
  for (const [name, value] of Object.entries(expected)) assert.equal(tokens[name], value, name);
});

test('contraste: todo texto do tema passa de 4,5:1 nas três superfícies', () => {
  const surfaces = ['mcs-bg', 'mcs-card', 'mcs-elevated'];
  const texts = ['mcs-text', 'mcs-text-2', 'mcs-muted', 'mcs-faint', 'mcs-gold-text', 'mcs-red', 'mcs-amber', 'mcs-green', 'mcs-blue', 'mcs-neutral'];
  const results = [];
  for (const text of texts) for (const surface of surfaces) {
    const value = ratio(token(text), token(surface));
    results.push(`${text}/${surface} ${value.toFixed(2)}`);
    assert.ok(value >= 4.5, `${text} sobre ${surface}: ${value.toFixed(2)}`);
  }
  console.log('CONTRASTE TOKENS', results.join(' · '));
});

test('contraste: selos com texto escuro colorido sobre fundo claro tingido passam de 4,5:1', () => {
  const pairs = [['mcs-red', 'mcs-red-tint'], ['mcs-amber', 'mcs-amber-tint'], ['mcs-green', 'mcs-green-tint'], ['mcs-blue', 'mcs-blue-tint'], ['mcs-gold-text', 'mcs-gold-tint'], ['mcs-neutral', 'mcs-tag'], ['mcs-text-2', 'mcs-tag'], ['mcs-text', 'mcs-gold-tint']];
  for (const [text, tint] of pairs) {
    const value = ratio(token(text), token(tint));
    assert.ok(value >= 4.5, `${text} sobre ${tint}: ${value.toFixed(2)}`);
  }
  // The tint is light: dark colored text on it, never white on a vivid color.
  for (const tint of ['mcs-red-tint', 'mcs-amber-tint', 'mcs-green-tint', 'mcs-blue-tint', 'mcs-gold-tint']) assert.ok(luminance(token(tint)) > 0.85, tint);
});

test('contraste: texto preto sobre dourado e branco nunca sobre dourado', () => {
  assert.ok(ratio(token('mcs-on-gold'), token('mcs-gold')) >= 4.5);
  assert.ok(ratio('#FFFFFF', token('mcs-gold')) < 4.5, 'branco sobre dourado seria ilegível');
  // Every gold background in the new layer carries the black text token.
  // (a barra de progresso .pending-bar i é dourada e não tem texto)
  for (const [, selector, block] of layer.matchAll(/([^{}]+){([^{}]*background:\s*var\(--mcs-gold\)[^{}]*)}/g)) {
    if (selector.trim() === '.pending-bar i') continue;
    assert.match(block, /color:\s*var\(--mcs-on-gold\)/, selector.trim());
  }
  assert.doesNotMatch(layer, /color:\s*#fff\b|color:\s*#ffffff\b|color:\s*white\b/i);
});

test('bordas de campo: pelo menos 3:1 contra fundo, superfície e superfície elevada', () => {
  for (const surface of ['mcs-bg', 'mcs-card', 'mcs-elevated']) {
    const value = ratio(token('mcs-field-line'), token(surface));
    assert.ok(value >= 3, `borda de campo sobre ${surface}: ${value.toFixed(2)}`);
  }
  assert.match(layer, /input,\s*select,\s*textarea,\s*\.lead-note\s*{[^}]*border:\s*1px solid var\(--mcs-field-line\)/);
});

test('sem laranja: nenhuma cor da camada nova nem dos tokens cai no laranja', () => {
  const hue = (hex) => { const [r, g, b] = rgb(hex).map((v) => v / 255); const max = Math.max(r, g, b), min = Math.min(r, g, b); if (max === min) return null; const d = max - min; const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return { hue: (h * 60 + 360) % 360, saturation: max === 0 ? 0 : d / max }; };
  const colors = [...new Set([...Object.values(tokens).join(' ').matchAll(/#[0-9A-Fa-f]{6}\b/g), ...layer.matchAll(/#[0-9A-Fa-f]{6}\b/g)].map(([value]) => value.toUpperCase()))];
  const orange = colors.filter((hex) => { const h = hue(hex); return h && h.saturation > 0.45 && h.hue >= 12 && h.hue < 38; });
  assert.deepEqual(orange, []);
  // wait-orange é nome de classe usado pelo JavaScript; como cor, orange não aparece.
  assert.doesNotMatch(layer + theme, /:\s*orange\b/i);
});

test('tema claro único, fontes locais e logo em SVG', () => {
  assert.match(theme, /color-scheme:\s*light/);
  for (const [file, text] of [['index.html', html], ['tema-mcs.css', theme], ['identidade.css', layer], ['painel.css', read('painel/painel.css')]]) {
    assert.doesNotMatch(text, /prefers-color-scheme/, file);
    assert.doesNotMatch(text, /Anton|fonts\.googleapis|fonts\.gstatic/, file);
  }
  assert.doesNotMatch(layer, /https?:\/\//);
  assert.match(html, /href="\/painel\/tema-mcs\.css(?:\?v=[\w-]+)?">\s*<link rel="stylesheet" href="\/painel\/identidade\.css(?:\?v=[\w-]+)?">/);
  assert.ok(fs.existsSync(path.join(root, 'painel/mcs-logo-claro.svg')), 'nenhum SVG apagado');
  assert.equal(JSON.parse(read('painel/manifest.webmanifest')).theme_color.toUpperCase(), '#FFFFFF');
});
