'use strict';

// Execução de uma proposta do assistente: só por aqui, só pelo clique em Confirmar/Enviar do cartão,
// só uma vez. A troca PENDENTE -> EXECUTANDO é um único UPDATE com status, validade e autor no filtro:
// clique duplo, recarregar a página ou repetir o pedido não executam de novo. Cada ação usa a rota que
// o painel já usa (mesmas travas: V1_DIRECT_SEND_ENABLED, janela de 24 h, um envio por vez).
const crypto = require('node:crypto');
const { rows, patchRows, isUuid } = require('./panel-server');
const routes = require('./panel-assistant-routes');
const D = require('./panel-assistant-data');

const env = (ctx) => 'eq.' + ctx.environment;
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const ERRORS = {
  PROPOSAL_USED: 'Esta ação já foi feita (ou está sendo feita) · nada foi repetido',
  PROPOSAL_EXPIRED: 'O cartão passou de 10 minutos · peça de novo',
  PROPOSAL_NOT_FOUND: 'Cartão não encontrado',
  NOTE_CHANGED: 'As observações da ficha mudaram depois do cartão · peça de novo',
  FILE_MISSING: 'O arquivo não veio junto · anexe de novo',
  FILE_CHANGED: 'O arquivo é diferente do que eu li · anexe de novo',
  WINDOW_CLOSED: 'A janela de 24 h do WhatsApp fechou · abra no WhatsApp e envie você',
  V1_DIRECT_SEND_DISABLED: 'O envio direto da V1 está desligado no painel',
  SEND_IN_PROGRESS: 'Já tem um envio desta V1 em andamento',
  V1_ALREADY_SENT: 'Esta V1 já foi enviada',
  V1_SEND_TOO_FAST: 'Espere alguns segundos entre um envio e outro',
  V1_CONTACT_BLOCKED: 'Este lead não pode receber mensagem agora (pediu para não ser contatado, desligado ou encerrado)',
  MANHEIM_OPTION_NOT_SELECTED: 'Um carro não ficou selecionado · nada foi criado',
  MANHEIM_SELECTION_REASON_REQUIRED: 'Um carro não é Lane/Run e precisa de motivo · selecione pela tela',
  MANHEIM_SELECTION_LIMIT: 'Passou do limite de carros selecionados para esta busca',
  MANHEIM_AUDIT_PENDING: 'A conferência do lote ainda não liberou estes carros',
  MANHEIM_SALE_ENDED: 'O leilão de um carro já passou',
  JOURNEY_ALREADY_DISABLED: 'O lead já estava desligado',
  VITRINE_REQUEST_TREATED: 'Este pedido de V2 já foi tratado',
  V1_TEXT_UNKNOWN: 'Não sei se esta V1 é por carro ou por valor · envie pela tela da V1',
  NO_VALID_PHONE: 'O lead não tem telefone válido'
};
const messageOf = (code) => ERRORS[code] || 'Não consegui fazer (' + code + ') · nada foi alterado';

// Uso único: só a primeira troca de PENDENTE para EXECUTANDO devolve a linha.
async function claim(ctx, id) {
  if (!isUuid(id)) throw fail('PROPOSAL_NOT_FOUND');
  const now = new Date().toISOString();
  const taken = await patchRows(ctx, 'panel_assistant_proposals', { environment: env(ctx), id: 'eq.' + id, created_by: 'eq.' + ctx.panel.id, status: 'eq.PENDENTE', expires_at: 'gt.' + now }, { status: 'EXECUTANDO', used_at: now }, true);
  if (taken && taken[0]) return taken[0];
  const [row] = await rows(ctx, 'panel_assistant_proposals', { select: 'id,status,expires_at,created_by', environment: env(ctx), id: 'eq.' + id, limit: '1' });
  if (!row || row.created_by !== ctx.panel.id) throw fail('PROPOSAL_NOT_FOUND');
  if (row.status !== 'PENDENTE') throw fail('PROPOSAL_USED');
  throw fail('PROPOSAL_EXPIRED');
}
const finish = (ctx, id, patch) => patchRows(ctx, 'panel_assistant_proposals', { environment: env(ctx), id: 'eq.' + id }, { ...patch, finished_at: new Date().toISOString() }).catch(() => null);

// O arquivo que o Leo anexou volta junto do clique; tem que ser o mesmo que o assistente leu.
function fileBytes(files, meta) {
  const sent = (Array.isArray(files) ? files : []).find((f) => f && Number(f.index) === Number(meta.index));
  if (!sent || typeof sent.base64 !== 'string') throw fail('FILE_MISSING');
  const bytes = Buffer.from(sent.base64, 'base64');
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== meta.sha256) throw fail('FILE_CHANGED');
  return bytes;
}
async function uploadAttachment(ctx, params, bytes) {
  const signed = await routes.must(ctx, 'attachments', { body: { action: 'sign', filename: params.file.name, mimeType: params.file.mime, byteSize: bytes.length, magicBase64: bytes.subarray(0, 64).toString('base64') } });
  const put = await fetch(signed.uploadUrl, { method: 'PUT', headers: { 'content-type': params.file.mime, 'x-upsert': 'false' }, body: bytes });
  if (!put.ok) throw fail('ATTACHMENT_UPLOAD_FAILED');
  return routes.must(ctx, 'attachments', { body: { action: 'finalize', attachmentId: signed.attachmentId, filename: signed.filename, mimeType: params.file.mime, quarantinePath: signed.quarantinePath, contactId: params.contactId, journeyId: params.journeyId } });
}
// "AAAA-MM-DDTHH:MM" de Nova York -> instante UTC.
function nyLocalToUtc(local) {
  const [date, time] = String(local).split('T');
  const midnight = D.nyMidnight(new Date(Date.parse(date + 'T12:00:00Z')));
  const [h, m] = time.split(':').map(Number);
  return new Date(midnight.getTime() + (h * 60 + m) * 60e3);
}
async function addSms(ctx, params, proposalId) {
  const [journey] = await rows(ctx, 'journeys', { select: 'id,contact_id', environment: env(ctx), id: 'eq.' + params.journeyId, limit: '1' });
  if (!journey) throw fail('JOURNEY_NOT_FOUND');
  const chats = await rows(ctx, 'chats', { select: 'id,channel,is_group', environment: env(ctx), contact_id: 'eq.' + journey.contact_id, channel: 'eq.SMS' });
  const existing = chats.find((c) => !c.is_group) || null;
  const local = params.sms.local || null;
  const utc = local ? nyLocalToUtc(local) : new Date();
  const localText = local || new Intl.DateTimeFormat('sv-SE', { timeZone: D.ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(utc).replace(' ', 'T');
  const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const start = await routes.must(ctx, 'entry', { body: { action: 'start', sourceKind: 'SMS_PASTE', sourceFilename: 'SMS pelo assistente', sourceSha256: sha(params.sms.text + localText + proposalId),
    chat: { channel: 'SMS', chatId: existing ? existing.id : null, isGroup: false, contactId: journey.contact_id, newContactName: null, phone: null, aliasText: 'SMS', senderAliases: [] } } });
  const batch = await routes.must(ctx, 'entry', { body: { action: 'batch', importJobId: start.importJobId, batchNumber: 1, messages: [{
    chat_id: start.chatId, channel: 'SMS', direction: params.sms.direction, body_text: params.sms.text, body_normalized: params.sms.text,
    occurred_at_local: localText + ':00', timezone_assumed: D.ZONE, occurred_at_utc: utc.toISOString(), time_uncertain: !local,
    original_datetime_text: localText, original_order: 1, source_kind: 'SMS_PASTE', is_edit_marker: false, is_delete_marker: false,
    signature_base: sha([start.chatId, localText, params.sms.direction, params.sms.text].join('\u001f')), file_occurrence_total: 1 }] } });
  await routes.must(ctx, 'entry', { body: { action: 'finish', importJobId: start.importJobId, journey: { mode: 'existing', journeyId: journey.id }, refs: [] } });
  return batch;
}
// A busca (por carro ou por valor) de uma V1: a dos carros dela no lote; decide a mensagem padrão do painel.
async function demandKeyOf(ctx, token) {
  const [vitrine] = await rows(ctx, 'vitrines', { select: 'id,journey_id', environment: env(ctx), token: 'eq.' + token, limit: '1' });
  if (!vitrine) return null;
  const cars = await rows(ctx, 'vitrine_cars', { select: 'source_match_id', environment: env(ctx), vitrine_id: 'eq.' + vitrine.id });
  const ids = cars.map((c) => c.source_match_id).filter(isUuid);
  if (!ids.length) return null;
  const matches = await rows(ctx, 'manheim_matches', { select: 'demand_key', environment: env(ctx), id: 'in.(' + ids.join(',') + ')' }).catch(() => []);
  const keys = [...new Set(matches.map((m) => m.demand_key).filter((k) => new RegExp('^journey:' + vitrine.journey_id + ':(VALOR|CARRO)$').test(String(k))))];
  return keys.length === 1 ? keys[0] : null;
}
const firstName = (name) => { const first = String(name || '').trim().split(/\s+/)[0] || ''; return /\p{L}/u.test(first) && !/\d/.test(first) ? first : ''; };

const EXEC = {
  async toggle(ctx, p) {
    const done = [], failed = [];
    for (const journeyId of p.journeyIds) {
      const out = await routes.call(ctx, 'actions', { body: { action: 'toggle_journey', journeyId, enabled: p.enabled, reason: p.reason } });
      if (out.status < 400 && !(out.body && out.body.error)) done.push(journeyId); else failed.push({ journeyId, code: (out.body && out.body.error) || out.status });
    }
    const verb = p.enabled ? 'Liguei' : 'Desliguei';
    return { text: `${verb} ${done.length} lead(s)${failed.length ? ` · ${failed.length} não mudaram (${[...new Set(failed.map((f) => messageOf(String(f.code))))].join('; ')})` : ''}`, ok: done.length > 0, done, failed };
  },
  async note(ctx, p) {
    const [contact] = await rows(ctx, 'contacts', { select: 'notes', environment: env(ctx), id: 'eq.' + p.contactId, limit: '1' });
    if (String((contact && contact.notes) || '').trim() !== p.before) throw fail('NOTE_CHANGED');
    await routes.must(ctx, 'actions', { body: { action: 'update_note', journeyId: p.journeyId, note: p.after } });
    return { text: 'Ficha atualizada', open: { journeyId: p.journeyId } };
  },
  async attach(ctx, p, extra, proposal) {
    const parts = [];
    if (p.file) { await uploadAttachment(ctx, p, fileBytes(extra.files, p.file)); parts.push('arquivo anexado'); }
    if (p.sms) { await addSms(ctx, p, proposal.id); parts.push('SMS na conversa'); }
    return { text: 'Feito · ' + parts.join(' e '), open: { journeyId: p.journeyId } };
  },
  async v1(ctx, p) {
    const upload = await require('./panel-manheim-state').latestActiveUpload(ctx, 'id');
    const selected = upload ? await rows(ctx, 'manheim_option_selections', { select: 'match_id', environment: env(ctx), upload_id: 'eq.' + upload.id, status: 'eq.SELECTED', match_id: 'in.(' + p.matchIds.join(',') + ')' }).catch(() => []) : [];
    const already = new Set(selected.map((s) => s.match_id));
    for (const matchId of p.matchIds.filter((id) => !already.has(id))) await routes.must(ctx, 'manheim-options', { body: { action: 'select', matchId } });
    const created = await routes.must(ctx, 'vitrines', { body: { journeyId: p.journeyId, matchIds: p.matchIds, ...(p.demandKey ? { demandKey: p.demandKey } : {}) } });
    const removed = created.removed && created.removed.length ? ' · fora da V1 (leilão passado): ' + created.removed.join(', ') : '';
    return { text: 'V1 montada' + removed, link: created.link, linkLabel: 'Abrir para revisar', token: created.token };
  },
  async v2(ctx, p, extra) {
    const ensured = await routes.must(ctx, 'vitrine-funnel', { body: { action: 'ensure_request', vitrineId: p.vitrineId, vitrineCarId: p.vitrineCarId } });
    const draft = await routes.call(ctx, 'v2-draft', { body: { requestId: ensured.requestId } });
    const note = draft.status < 400 && draft.body && draft.body.note ? String(draft.body.note) : null;
    const [journey] = await rows(ctx, 'journeys', { select: 'budget_cents', environment: env(ctx), id: 'eq.' + p.journeyId, limit: '1' });
    const limit = journey && Number(journey.budget_cents) > 0 ? String(Math.round(Number(journey.budget_cents) / 100)) : null;
    const created = await routes.must(ctx, 'vitrines', { body: { requestId: ensured.requestId, customerLimitCents: limit, noteText: note } });
    let photos = 0;
    for (const photo of p.photos || []) {
      const bytes = fileBytes(extra.files, photo);
      const out = await routes.call(ctx, 'vitrine-photos', { method: 'POST', query: { vitrineId: created.vitrineId, carId: created.carId }, headers: { 'content-type': 'application/octet-stream' }, body: bytes });
      if (out.status < 400) photos += 1;
    }
    return { text: `V2 montada${photos ? ` · ${photos} foto(s)` : ''}`, link: created.link, linkLabel: 'Abrir para revisar', token: created.token };
  },
  async pdf(ctx, p) {
    const data = await routes.must(ctx, 'vitrines', { body: { action: 'pdf', journeyId: p.journeyId, matchIds: p.matchIds } });
    return { text: 'PDF pronto · a janela de salvar abre agora', pdf: { data, ref: p.ref } };
  },
  async send_v1(ctx, p, extra, proposal) {
    const demandKey = p.demandKey || await demandKeyOf(ctx, p.token);
    const prep = await routes.must(ctx, 'v1-send', { body: { action: 'prepare', token: p.token, baseUrl: extra.baseUrl, ...(demandKey ? { demandKey } : {}) } });
    if (!prep.text) throw fail('V1_TEXT_UNKNOWN');
    if (!(p.direct && prep.eligible && prep.windowOpen && prep.mode !== 'OFF')) return { text: 'Fora da janela de 24 h · abri o WhatsApp com a mensagem pronta · o envio é você quem faz', whatsappLink: prep.whatsappLink || p.whatsappLink };
    const sent = await routes.call(ctx, 'v1-send', { body: { action: 'send', token: p.token, text: prep.text, requestKey: proposal.id, confirmed: true, resend: p.resend === true, ...(demandKey ? { demandKey } : {}) } });
    if (sent.status >= 400 || (sent.body && sent.body.error)) {
      const code = (sent.body && sent.body.error) || String(sent.status);
      if (code === 'WINDOW_CLOSED' && sent.body.whatsappLink) return { text: messageOf(code), whatsappLink: sent.body.whatsappLink };
      throw fail(code);
    }
    const status = sent.body.sendStatus;
    return { text: status === 'SENT' ? (sent.body.simulated ? 'Envio simulado (fora da produção) · ninguém recebeu' : 'V1 enviada pelo WhatsApp') : status === 'UNCONFIRMED' ? 'Envio sem confirmação do WhatsApp · confira na conversa' : 'O WhatsApp recusou o envio', ok: status !== 'FAILED' };
  },
  async send_v2(ctx, p, extra) {
    const [vitrine] = await rows(ctx, 'vitrines', { select: 'token,customer_name,contact_id', environment: env(ctx), id: 'eq.' + p.vitrineId, limit: '1' });
    if (!vitrine) throw fail('VITRINE_NOT_FOUND');
    const data = await D.snapshot(ctx);
    const journey = data.journeyById.get(p.journeyId);
    const phones = journey ? (data.phonesByContact.get(journey.contact_id) || []) : [];
    const phone = D.digits(phones[0] && (phones[0].phone_e164 || phones[0].phone_raw));
    if (!phone) throw fail('NO_VALID_PHONE');
    const name = firstName(vitrine.customer_name || (data.contactById.get(journey.contact_id) || {}).display_name) || 'Hi';
    const base = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(String(extra.baseUrl || '')) ? extra.baseUrl : 'https://www.mycarscout.net';
    const text = `${name}, here's the car you asked to see\n${base}/v/${vitrine.token}`;
    return { text: 'Abri o WhatsApp com a V2 · o envio é você quem faz', whatsappLink: 'https://wa.me/' + phone + '?text=' + encodeURIComponent(text) };
  },
  async link_ref(ctx, p) {
    const out = await routes.must(ctx, 'actions', { body: { action: 'link_request', journeyId: p.journeyId, contactId: p.contactId, calcRef: p.ref } });
    return { text: `Ref ${p.ref} ligada · ${out.simulations || 0} simulação(ões)`, open: { journeyId: p.journeyId } };
  }
};

async function confirm(ctx, body) {
  let proposal;
  try { proposal = await claim(ctx, body.id); }
  catch (error) { return { ok: false, code: error.code, text: messageOf(error.code) }; }
  const extra = { files: body.files, baseUrl: body.baseUrl };
  try {
    const result = await EXEC[proposal.kind](ctx, proposal.params || {}, extra, proposal);
    const ok = result.ok !== false;
    await finish(ctx, proposal.id, { status: ok ? 'FEITA' : 'FALHOU', result: { text: result.text }, error_code: ok ? null : 'PARTIAL' });
    return { ok, ...result };
  } catch (error) {
    const code = (error && error.code) || 'FAILED';
    await finish(ctx, proposal.id, { status: 'FALHOU', error_code: String(code).slice(0, 80) });
    return { ok: false, code, text: messageOf(code) };
  }
}
async function cancel(ctx, id) {
  if (!isUuid(id)) return { ok: false };
  await patchRows(ctx, 'panel_assistant_proposals', { environment: env(ctx), id: 'eq.' + id, created_by: 'eq.' + ctx.panel.id, status: 'eq.PENDENTE' }, { status: 'CANCELADA', finished_at: new Date().toISOString() });
  return { ok: true, text: 'Cancelado · nada foi feito' };
}

module.exports = { confirm, cancel, claim, EXEC, messageOf, nyLocalToUtc };
