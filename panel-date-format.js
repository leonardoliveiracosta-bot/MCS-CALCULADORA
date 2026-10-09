'use strict';

// Cache formatter objects only: every call still formats the supplied current value.
// Keep the cache bounded, including when a caller supplies an unusual time zone.
const formatters = new Map();
const MAX_FORMATTERS = 128;
function dateFormatter(locale, options) {
  const key = JSON.stringify([locale, Object.entries(options).sort(([a], [b]) => a.localeCompare(b))]);
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (formatters.size >= MAX_FORMATTERS) formatters.delete(formatters.keys().next().value);
    formatters.set(key, formatter);
  }
  return formatter;
}
module.exports = { dateFormatter };
