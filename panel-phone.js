'use strict';

function normalizePhone(value) {
  const raw=String(value||'').trim();
  if(!raw)return null;
  const digits=raw.replace(/\D/g,'');
  const normalized=digits.length===10?'1'+digits:digits;
  return /^[1-9]\d{6,14}$/.test(normalized)?'+'+normalized:null;
}

function formatPhone(value) {
  const normalized=normalizePhone(value);
  if(!normalized)return null;
  const digits=normalized.slice(1);
  return digits.length===11&&digits.startsWith('1')?`(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`:normalized;
}

function phoneSearchDigits(value) { return String(value||'').replace(/\D/g,''); }

module.exports={normalizePhone,formatPhone,phoneSearchDigits};
