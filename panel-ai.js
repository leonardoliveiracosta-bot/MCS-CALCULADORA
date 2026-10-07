'use strict';

const crypto = require('node:crypto');
const { consolidateCalcRuns, groupCalculatorByRef, mergeWishlists, REF_RE, time } = require('./panel-domain');
const { validItems, prepareItems } = require('./panel-note');
const { allRows, insert, patchRows, rows, supabase } = require('./panel-server');
const { timezoneForZip } = require('./panel-lead');
const { storeDailyInsight } = require('./panel-pendencias');
const anthropicBudget = require('./panel-anthropic-budget');
const refProof = require('./panel-ref-proof');

const AI_TYPES = new Set(['call_result','checklist','budget','payment','deadline','wishlist','phone','promise','return','stage','disable']);
const DAY_MS = 86400000;
const AI_CONTEXT_MAX_MESSAGES = 150;
const AI_CONTEXT_MAX_CHARS = 40000;
const AI_FAILURE_BACKOFF_MS = 6 * 60 * 60 * 1000;
// Automatic reading starts at 3 MCS messages in the conversation. The automatic greeting does not count;
// MCS messages imported from the WhatsApp history do.
const AI_MIN_MCS_MESSAGES = 3;

function firstJson(text) {
  const source = String(text || '');
  for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < source.length; index++) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else ¶»§q«^