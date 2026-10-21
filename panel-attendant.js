'use strict';

const { rows, isUuid } = require('./panel-server');
const QUICK = new Set(['QUICK_ANSWERED','QUICK_NO_ANSWER','QUICK_IN_PERSON','QUICK_DEPOSIT','QUICK_LATER','NOTE_CONFIRMED','CAR_PRESENTED']);

async function names(ctx, ids, services = { rows }) {
  const wanted = [...new Set(ids.filter(isUuid))];
  if (!wanted.length) return new Map();
  const users = await services.rows(ctx, 'panel_users', {
    select:'id,display_name,email', environment:'eq.'+ctx.environment, id:'in.('+wanted.join(',')+')'
  });
  return new Map(users.map(user => [user.id, String(user.display_name || user.email || 'Conta sem nome').trim()]));
}

// Reading a ficha never assigns it to the reader. Only saved results, notes and actual outbound
// records identify the login that acted. Names always come from the server's panel_users table.
async function enrich(ctx, lead, services = { rows }) {
  if (!lead) return lead;
  const events = (lead.events || []).filter(event => !event.undone_at && QUICK.has(event.event_type));
  const candidates = events.map(event => ({userId:event.created_by, at:event.occurred_at}));
  for (const note of lead.notes || []) candidates.push({userId:note.created_by, at:note.created_at});
  const journeyId = lead.record?.id;
  if (isUuid(journeyId)) {
    const interactions = await services.rows(ctx, 'interactions', {
      select:'id,type,created_by,occurred_at,message_id', environment:'eq.'+ctx.environment,
      journey_id:'eq.'+journeyId, undone_at:'is.null', created_by:'not.is.null',
      type:'in.(OUTBOUND_MESSAGE,CALL_ANSWERED,CALL_ATTEMPT,IN_PERSON)', order:'occurred_at.desc', limit:'100'
    });
    const messages = new Set((lead.record.conversation || []).filter(message => !message.undone_at).map(message => message.id));
    for (const item of interactions) {
      // An SMS handoff that was undone is no longer an attendance record.
      if (item.message_id && !messages.has(item.message_id)) continue;
      candidates.push({userId:item.created_by, at:item.occurred_at});
    }
  }
  const byUser = await names(ctx, candidates.map(item => item.userId), services);
  const latest = candidates.filter(item => byUser.has(item.userId) && Number.isFinite(Date.parse(item.at)))
    .sort((a,b) => Date.parse(b.at)-Date.parse(a.at))[0];
  return {
    ...lead,
    notes:(lead.notes || []).map(note => ({...note, actorName:byUser.get(note.created_by) || null})),
    events:(lead.events || []).map(event => ({...event, actorName:byUser.get(event.created_by) || null})),
    attendant:latest ? {name:byUser.get(latest.userId), at:latest.at} : null,
    attendantState:'ok'
  };
}

module.exports = { names, enrich };
