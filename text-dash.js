'use strict';

// One rule for every place that removes dashes from AI text: a dash inside a range (2018–2020,
// 20,000–80,000, $15,000–$20,000, 20k–30k) stays a range with a hyphen; any other em or en dash
// becomes ", ". Replacing every dash used to turn "2018–2020" into "2018, 2020".
function undash(text) {
  return String(text || '')
    .replace(/([\d%kK])\s*[—–]\s*(?=\$?\d)/g, '$1-')
    .replace(/\s*[—–]\s*/g, ', ');
}

module.exports = { undash };
