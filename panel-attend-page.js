'use strict';
// Exact list rules shared with the panel. Pagination happens after cases, filters and ordering.
const MCSAttend = require('./painel/atendimento');
const MCSCompleting = require('./painel/completar-pedido');
const MCSGroups = require('./panel-groups');
const uuidOnly = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '')) ? value : null;
const journeyIdOf = item => uuidOnly(item && (item.journeyId || item.journey_id || (['CALCULATOR', 'CALCULATOR_ORDER'].includes(item.kind) ? null : item.id)));
const formatMoney = cents => Number(cents) ? new Intl.NumberFormat('pt-BR',{style:'currency',currency:'USD'}).format(Number(cents)/100) : '—';
const displayModel = value => String(value || '').replace(/\bnot sure\b/gi,'').replace(/\bother model\b/gi,'Outro modelo').replace(/\s{2,}/g,' ').trim();
const entryReviewChats = entry => (entry && entry.chats || []).filter(chat => !chat.triageOut && chat.group?.key !== 'FORA_DO_ASSUNTO' && (chat.resolution_status !== 'RESOLVED' || chat.hasTimeUncertain));
const atMs = value => { const at=Date.parse(value || ''); return Number.isFinite(at)?at:0; };
const activityAt = item => Math.max(atMs(item?.lastCustomerAt)||0,atMs(item?.latestMessage?.occurred_at_utc||item?.latestMessage?.created_at)||0,atMs(item?.lastRealMessageAt)||0,atMs(item?.occurredAt)||0);
  function caseRequestFields(item) {
    const facts = item.cardFacts || {};
    const per = facts.perMode || {};
    const fields = [];
    const modes = (facts.modes || []).filter((mode) => per[mode]);
    const both = modes.includes('VALOR') && modes.includes('CARRO');
    if (modes.includes('VALOR')) { const v = per.VALOR; fields.push([both ? 'Carro (por valor)' : 'Carro', displayModel(v.vehicleText) || 'não informado'], ['Lance máximo', v.budgetCents ? formatMoney(v.budgetCents) : 'não informado']); }
    if (modes.includes('CARRO')) { const c = per.CARRO; fields.push([both ? 'Carro (por carro)' : 'Carro', displayModel(c.vehicleText) || 'não informado'], ['Anos', c.yearsText || 'não informado'], ['Milhas', c.mileageText || 'não informado']); }
    if (!modes.length) { const vehicle = displayModel(facts.vehicleText || item.vehicleText); const bid = Number(facts.budgetCents || item.budgetCents) || 0; if (vehicle) fields.push(['Carro', vehicle]); if (bid) fields.push(['Lance máximo', formatMoney(bid)]); }
    if (facts.zipText) fields.push(['ZIP', facts.zipText]);
    return fields;
  }

  function refStateOf(item){const state=item?.group?.refState||item?.refState;if(state)return state;return hasRef(item)?'COM_REF':'SEM_REF';}
  function hasRef(item){if(typeof item?.hasCalcRef==='boolean')return item.hasCalcRef;return Boolean(item?.ref||item?.referenceCode||item?.reference_code||(item?.refs||[]).some((entry)=>entry?.ref_code||entry));}
  const calcRefOf=(item)=>typeof item?.hasCalcRef==='boolean'?(item.calcRef||null):(item?.referenceCode||item?.reference_code||item?.ref||null);

  function attendDecisions({ entry, triage, whatsapp, nameLinks = [] }) {
    const out = [];
    (whatsapp?.suggestions || []).forEach((item) => out.push({ key: 'suggestion:' + item.id, kind: 'VINCULO', journeyId: uuidOnly(item.source_journey_id), name: item.sourceName || item.phone_e164 || null, phone: item.phone_e164 || null, label: item.target_ref ? `Confirmar vínculo: esta conversa ${item.refConfirmed ? 'é' : 'parece ser'} a Ref ${item.target_ref}` : 'Confirmar vínculo desta conversa com uma ficha' }));
    (whatsapp?.phoneReviews || []).forEach((item) => out.push({ key: 'phone:' + item.id, kind: 'TELEFONE', journeyId: null, name: item.phone_e164 || null, phone: item.phone_e164 || null, label: 'Escolher o contato certo deste telefone' }));
    (triage?.review || []).forEach((item) => out.push({ key: 'triage:' + item.id, kind: 'TRIAGEM', chatId: item.chatId || null, journeyId: uuidOnly(item.journeyId), name: item.name || null, phone: item.phone_e164 || item.phone || null, label: 'Classificar a conversa (pré-compra ou fora do funil)' }));
    (triage?.offMcs || []).forEach((item) => out.push({ key: 'offmcs:' + item.journeyId, kind: 'FORA_MCS', journeyId: uuidOnly(item.journeyId), name: item.name || null, label: 'Revisar: candidata a fora da MCS · ' + (item.label || '') }));
    entryReviewChats(entry).forEach((chat) => out.push({ key: 'chat:' + chat.id, kind: 'REVISAR_CONVERSA', journeyId: uuidOnly(chat.groupJourneyId), name: chat.contact?.display_name || chat.canonical_key || null, label: chat.resolution_status === 'RESOLVED' ? 'Conferir conversa com hora incerta' : 'Revisar conversa importada e ligar à ficha certa' }));
    nameLinks.forEach((link) => out.push({ key: link.key, kind: 'VINCULO', journeyId: uuidOnly(link.journeyId), name: link.simulation?.name || null, phone: link.phone || null, label: link.via === 'REF' ? 'Confirmar vínculo: Ref desta ficha com divergência' : 'Confirmar vínculo: telefone igual, nome diferente' }));
    return out;
  }

  function incompleteRequests(pesquisas) {
    return (pesquisas && pesquisas.items || []).filter((item) => item.state === 'PRECISA_DETALHE').map((item) => ({ key: item.key, journeyId: uuidOnly(item.person?.journeyId), contactId: uuidOnly(item.person?.contactId), name: item.person?.name || null, lacksText: item.lacksText || 'Falta um dado do carro', missing: Array.isArray(item.missing) ? item.missing : [], criteriaText: item.criteriaText || '', source: item.source }));
  }

  function caseFacts(entry, attendIdentity) {
    if (entry.item) return { known: true, hasRef: hasRef(entry.item), refState: refStateOf(entry.item), item: entry.item, at: activityAt(entry.item) };
    // A decision that carries its own state (a vitrine tap with the link code, resolved by the server) keeps it.
    if (!entry.journeyId) { const carried = (entry.decisions || []).map((decision) => decision.refState).find(Boolean); return { known: true, hasRef: carried === 'COM_REF', refState: carried || 'SEM_REF', item: null, at: 0 }; }
    const identity = attendIdentity.get(entry.journeyId);
    if (identity === 'loading' || identity === undefined) return { known: false };
    if (!identity) return { known: true, hasRef: false, refState: 'SEM_REF', item: null, at: 0 };
    return { known: true, hasRef: identity.hasCalcRef, refState: identity.refState || (identity.hasCalcRef ? 'COM_REF' : 'SEM_REF'), item: identity.origin ? { group: { origin: identity.origin } } : null, at: atMs(identity.at) || 0, identity };
  }
  function attendHaystack(entry, attendIdentity) {
    const item = entry.item;
    const rows = [...(entry.decisions || []), ...(entry.requests || [])];
    const identity = entry.journeyId && attendIdentity.get(entry.journeyId);
    const known = identity && identity !== 'loading' ? identity : null;
    const phones = item ? (item.phones || []).map((phone) => phone.phone_e164 || phone.phone_raw || '') : rows.map((row) => row.phone || '').concat(entry.bucket === 'completar' ? known?.phones || [] : []);
    const words = item ? [calcRefOf(item), item.internalCode, item.contactName, item.name, item.contact && item.contact.display_name, ...caseRequestFields(item).map(([, value]) => value)] : [known && known.calcRef, entry.bucket === 'completar' && known?.internalCode, known && known.name, ...rows.map((row) => [row.name, row.sourceName].join(' '))];
    return { digits: phones.join(' ').replace(/\D/g, ''), text: words.filter(Boolean).join(' ').toLowerCase() };
  }
  function attendMatches(entry, query, attendIdentity) {
    const hay = attendHaystack(entry, attendIdentity);
    const digits = query.replace(/\D/g, '');
    if (digits.length >= 3 && hay.digits.includes(digits)) return true;
    return hay.text.includes(query.toLowerCase());
  }

function identityOf(context) {
  return context ? {hasCalcRef:Boolean(context.hasCalcRef),refState:context.refState||null,calcRef:context.calcRef||null,internalCode:context.internalCode||null,name:context.name||null,
    phones:context.contact?.phones||[],location:context.contact?.location||null,listMessage:context.listMessage||null,refAt:context.refAt||null,
    origin:context.origin?.code ? {group:String(context.origin.code).split(':')[0],key:context.origin.code,label:context.origin.label,financing:Boolean(context.origin.financing)}:null,
    at:context.conversation?.lastAt||null}:null;
}
function modelOf(today, entry, triage, whatsapp, pesquisas, sort, now) {
  const items=today.items||[], live=new Set(items.map(MCSAttend.journeyOf).filter(Boolean)), discarded=new Set(today.discardedJourneys||[]);
  const retain=rows=>rows.filter(row=>!row.journeyId||live.has(row.journeyId)||!discarded.has(row.journeyId));
  return MCSAttend.model({todayItems:items,decisions:retain(attendDecisions({entry,triage,whatsapp,nameLinks:entry.nameLinks||[]})),incomplete:retain(incompleteRequests(pesquisas)),sort,now});
}
function select(model, identities, {sort='ready',ref='all',stat=null,query='',v1JourneyIds=[],now=Date.now()}={}) {
  const facts=new Map(model.cases.map(entry=>[entry.key,caseFacts(entry,identities)]));
  const bucket=model.cases.filter(entry=>MCSAttend.inBucket(entry,'todos'));
  const countRef=state=>bucket.filter(entry=>{const f=facts.get(entry.key);return f.known&&f.refState===state;}).length;
  const refCounts={all:bucket.length,with:countRef('COM_REF'),recover:countRef('A_RECUPERAR'),without:countRef('SEM_REF')};
  const refState={with:'COM_REF',recover:'A_RECUPERAR',without:'SEM_REF'}[ref];
  const shown=bucket.filter(entry=>ref==='all'||facts.get(entry.key).known&&facts.get(entry.key).refState===refState);
  const base=shown.filter(entry=>entry.item).map(entry=>entry.item), sent=new Set(v1JourneyIds);
  const filters={late24:item=>{const latest=item.latestMessage,at=Date.parse(latest&&latest.occurred_at_utc||'');return Boolean(latest&&!latest.is_automatic&&latest.direction==='CUSTOMER'&&Number.isFinite(at)&&now-at>86400000);},hot:item=>item.purchaseWindow==='NOW',sent:item=>sent.has(journeyIdOf(item))};
  const stats=Object.fromEntries(Object.entries(filters).map(([key,predicate])=>[key,base.filter(predicate).length]));
  const windows=Object.fromEntries(['30D','3M','NONE'].map(key=>[key,base.filter(item=>String(item.purchaseWindow||'NONE')===key).length]));
  const byStat=filters[stat]?shown.filter(entry=>entry.item&&filters[stat](entry.item)):shown;
  const visible=query?byStat.filter(entry=>attendMatches(entry,query,identities)):byStat;
  const withItem=visible.filter(entry=>entry.item), without=visible.filter(entry=>!entry.item), byItem=new Map(withItem.map(entry=>[entry.item,entry]));
  let order=without.filter(entry=>entry.bucket!=='completar').map(entry=>({entry,data:{group:'DECISOES'}}));
  const placed=[];
  const groupOf=item=>item?.group?.key?item.group:{key:'ATENDIDO',label:MCSGroups.SECTIONS.ATENDIDO.label,origin:null,unattended:null};
  MCSGroups.split(withItem.map(entry=>entry.item),groupOf).filter(group=>group.items.length).forEach(group=>MCSGroups.areas(group.items).forEach(area=>{
    const place=(item,subject)=>placed.push({entry:byItem.get(item),data:{group:group.key,area:area.key,...(subject?{subject}: {})}});
    if(area.key==='SEM_REF')MCSGroups.bySubject(area.items).forEach(subject=>subject.items.forEach(item=>place(item,subject.key)));
    else area.items.forEach(item=>place(item));
  }));
  if(sort==='ready')order.push(...placed);
  else {const dataOf=new Map(placed.map(row=>[row.entry,row.data]));withItem.forEach(entry=>order.push({entry,data:dataOf.get(entry)||{}}));}
  order=MCSCompleting.insert(order,without.filter(entry=>entry.bucket==='completar').map(entry=>({entry,data:{group:'COMPLETAR'}})),identities,sort,now);
  return {order,counts:model.counts,allKeys:model.cases.map(entry=>entry.key),refCounts,shownCount:shown.length,stats,windows};
}
module.exports={modelOf,select,identityOf,caseRequestFields,attendDecisions,incompleteRequests};
