(function attachMoneyText(root, factory) {
  'use strict';
  const api = factory();
  if (root) root.MCSMoneyText = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
  'use strict';

  // Reads a money amount typed or written by a customer: "35k", "35,000", "US$ 35.000",
  // "R$ 35.000,00", "25,000 to 30,000" (the largest value wins). Returns cents or null.
  // Values below US$ 1.000, model years and mileage are not money.
  const TOKEN = /(\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?!\d)\s*(k|mil)?(?![a-z])/gi;

  function tokenValue(raw, suffix) {
    let text = String(raw).replace(/\s+/g, '');
    const lastDot = text.lastIndexOf('.');
    const lastComma = text.lastIndexOf(',');
    const lastSep = Math.max(lastDot, lastComma);
    if (lastSep >= 0) {
      const decimals = text.length - lastSep - 1;
      const both = lastDot >= 0 && lastComma >= 0;
      const sepCount = (text.match(/[.,]/g) || []).length;
      // "35.000,00" / "35,000.00": the last separator is decimal. "35.5k": decimal before a multiplier.
      const decimal = (both && decimals <= 2) || (!both && sepCount === 1 && decimals <= 2);
      if (decimal) text = text.slice(0, lastSep).replace(/[.,]/g, '') + '.' + text.slice(lastSep + 1);
      else text = text.replace(/[.,]/g, '');
    }
    let value = Number(text);
    if (!Number.isFinite(value)) return null;
    if (suffix) value *= 1000;
    return value;
  }

  function isModelYear(raw, suffix, value) {
    return !suffix && /^\d{4}$/.test(String(raw).trim()) && value >= 1950 && value <= 2045;
  }

  function parseMoneyCents(input) {
    const text = String(input === null || input === undefined ? '' : input);
    const values = [];
    for (const match of text.matchAll(TOKEN)) {
      // Mileage is not money: "60,000 miles", "60k mi", "50 mil milhas".
      const rest = text.slice(match.index + match[0].length);
      if (/^\s*(?:mi\b|miles?\b|milhas?\b|km\b)/i.test(rest) || (/^mil$/i.test(match[2] || '') && /^\s*(?:milhas?|mi\b|miles?)/i.test(rest))) continue;
      const value = tokenValue(match[1], match[2]);
      if (value === null || isModelYear(match[1], match[2], value)) continue;
      if (value >= 1000 && value <= 100000000) values.push(value);
    }
    if (!values.length) return null;
    return Math.round(Math.max(...values) * 100);
  }

  function formatUsd(cents) {
    return 'US$ ' + Math.round(Number(cents) / 100).toLocaleString('pt-BR');
  }

  return { parseMoneyCents, formatUsd };
}));
