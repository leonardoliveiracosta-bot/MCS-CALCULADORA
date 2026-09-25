(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MCSParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ZW = /[\u200b-\u200f\u202a-\u202e\ufeff]/g;
  const REF_RE = /\bRef\s*:\s*([A-HJ-NP-Z2-9]{5})\b/gi;
  const SYSTEM_RE = /messages and calls are end-to-end encrypted|mensagens e ligações (?:são|sao) protegidas|created group|criou o grupo|changed the subject|mudou o assunto|added .+ to the group|adicionou .+ ao grupo|joined using|entrou usando/i;
  const GROUP_RE = /created group|criou o grupo|added .+ to the group|adicionou .+ ao grupo|left the group|saiu do grupo|removed .+ from the group|removeu .+ do grupo/i;

  function clean(value) {
    return String(value || '').normalize('NFC').replace(/\r\n?/g, '\n').replace(ZW, '').trim();
  }

  function normalizeSender(value) {
    return clean(value).toLocaleLowerCase('pt-BR');
  }

  function header(line) {
    let match = line.match(/^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?(?:[Mm])\.?)?\]\s?(.*)$/);
    if (match) return { style: 'IPHONE', parts: match.slice(1, 8), rest: match[8] };
    match = line.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?(?:[Mm])\.?)?\s+-\s+(.*)$/);
    if (match) return { style: 'ANDROID', parts: match.slice(1, 8), rest: match[8] };
    return null;
  }

  function splitSender(rest) {
    const match = String(rest || '').match(/^([^:\n]{1,200}):\s?(.*)$/s);
    return match ? { sender: clean(match[1]), body: match[2] || '' } : { sender: null, body: rest || '' };
  }

  function scan(raw) {
    const messages = [];
    const system = [];
    let current = null;
    let recognized = 0;
    let style = null;
    clean(raw).split('\n').forEach((line) => {
      const found = header(line);
      if (found) {
        recognized += 1;
        style = style || found.style;
        const payload = splitSender(found.rest);
        const item = { rawParts: found.parts, sender: payload.sender, body: payload.body, original: line };
        if (!payload.sender || SYSTEM_RE.test(clean(payload.body))) {
          system.push(item);
          current = null;
        } else {
          messages.push(item);
          current = item;
        }
      } else if (current) {
        current.body += '\n' + line;
      }
    });
    return { messages, system, recognized, style };
  }

  function inferDateOrder(messages) {
    let dmy = false;
    let mdy = false;
    messages.forEach((item) => {
      const first = Number(item.rawParts[0]);
      const second = Number(item.rawParts[1]);
      if (first > 12 && second <= 12) dmy = true;
      if (second > 12 && first <= 12) mdy = true;
    });
    if (dmy && mdy) return 'CONFLICT';
    if (dmy) return 'DMY';
    if (mdy) return 'MDY';
    return null;
  }

  function localKey(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).reduce((all, part) => { all[part.type] = part.value; return all; }, {});
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  }

  function resolveNewYork(parts) {
    const wanted = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`;
    const localMillis = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const candidates = [4, 5].map((hours) => new Date(localMillis + hours * 3600000)).filter((date) => localKey(date) === wanted);
    return { local: wanted, utc: candidates.length === 1 ? candidates[0].toISOString() : null, timeUncertain: candidates.length !== 1 };
  }

  function parseDate(rawParts, order) {
    const first = Number(rawParts[0]);
    const second = Number(rawParts[1]);
    const yearRaw = Number(rawParts[2]);
    let hour = Number(rawParts[3]);
    const minute = Number(rawParts[4]);
    const secondValue = Number(rawParts[5] || 0);
    const ampm = String(rawParts[6] || '').replace(/\./g, '').toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    const month = order === 'DMY' ? second : first;
    const day = order === 'DMY' ? first : second;
    const check = new Date(Date.UTC(year, month - 1, day));
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || secondValue > 59 || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    return resolveNewYork({ year, month, day, hour, minute, second: secondValue });
  }

  function extractRefs(messages) {
    const refs = new Set();
    messages.forEach((item) => {
      let match;
      REF_RE.lastIndex = 0;
      while ((match = REF_RE.exec(item.body))) refs.add(match[1].toUpperCase());
    });
    return [...refs];
  }

  function extractPhoneCandidate(value) {
    const source = clean(value);
    const candidates = source.match(/\+?[\d][\d\s().\-\u00a0\u2011_]{7,}[\d]/g) || [];
    return candidates.map((item) => clean(item.replace(/_/g, ' '))).find((item) => {
      const digits = item.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 15;
    }) || null;
  }

  function parseWhatsApp(raw, filename, options) {
    const scanned = scan(raw);
    if (!scanned.recognized || !scanned.messages.length) return { supported: false, reason: 'formato não suportado' };
    const inferred = inferDateOrder(scanned.messages);
    if (inferred === 'CONFLICT') return { supported: false, reason: 'formato de data inconsistente' };
    const dateOrder = options && options.dateOrder ? options.dateOrder : inferred;
    const senders = [...new Set(scanned.messages.map((item) => clean(item.sender)))];
    const groupSignal = senders.length > 2 || scanned.system.some((item) => GROUP_RE.test(clean(item.body)));
    const base = {
      supported: true,
      channel: 'WHATSAPP',
      title: clean(String(filename || 'WhatsApp').replace(/\.txt$/i, '')) || 'WhatsApp',
      style: scanned.style,
      senders,
      refs: extractRefs(scanned.messages),
      phoneCandidate: extractPhoneCandidate(filename),
      groupSignal,
      requiresGroupConfirmation: !groupSignal,
      inferredDateOrder: inferred,
      requiresDateOrder: !dateOrder,
      entries: []
    };
    if (!dateOrder) return base;
    if (!['DMY', 'MDY'].includes(dateOrder)) return { supported: false, reason: 'formato de data inválido' };
    for (let index = 0; index < scanned.messages.length; index += 1) {
      const item = scanned.messages[index];
      const date = parseDate(item.rawParts, dateOrder);
      if (!date) return { supported: false, reason: 'data inválida' };
      base.entries.push({
        sender: clean(item.sender), body: clean(item.body), original: item.original,
        originalOrder: index + 1, date,
        edit: /mensagem editada|edited message|message edited/i.test(item.body),
        deleted: /mensagem apagada|mensagem excluída|message deleted|you deleted this message/i.test(item.body),
        mediaOmitted: /<media omitted>|mídia oculta|media omitted|imagem ocultada/i.test(item.body)
      });
    }
    base.dateOrder = dateOrder;
    base.hasTimeUncertain = base.entries.some((entry) => entry.date.timeUncertain);
    return base;
  }

  function assignDirections(parsed, mcsSender) {
    const chosen = normalizeSender(mcsSender);
    if (!chosen || !parsed.senders.some((sender) => normalizeSender(sender) === chosen)) throw new Error('MCS_SENDER_REQUIRED');
    return parsed.entries.map((entry) => ({ ...entry, direction: normalizeSender(entry.sender) === chosen ? 'MCS' : 'CUSTOMER' }));
  }

  function automaticImportMatch(parsed, chatAliases, chats, senderAliases) {
    if (!parsed || !parsed.supported || parsed.requiresDateOrder || parsed.groupSignal) return null;
    const alias = (Array.isArray(chatAliases) ? chatAliases : []).find((item) => normalizeSender(item.alias_text) === normalizeSender(parsed.title));
    const chat = alias && (Array.isArray(chats) ? chats : []).find((item) => item.id === alias.chat_id && !item.is_group && item.contact_id);
    if (!chat) return null;
    const mcs = (Array.isArray(senderAliases) ? senderAliases : []).find((item) => item.chat_id === chat.id && item.direction === 'MCS' && parsed.senders.some((sender) => normalizeSender(sender) === normalizeSender(item.sender_text)));
    return mcs ? { chat, mcsSender: mcs.sender_text } : null;
  }

  return { clean, normalizeSender, inferDateOrder, resolveNewYork, parseWhatsApp, assignDirections, extractRefs, extractPhoneCandidate, automaticImportMatch };
});
