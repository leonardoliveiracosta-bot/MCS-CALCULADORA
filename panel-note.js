'use strict';
const crypto = require('node:crypto');
function digest(secret, ref, note, items) { return crypto.createHmac('sha256', secret).update(JSON.stringify([ref,note,items])).digest('hex'); }
function verified(secret, ref, note, items, signature) {
  return typeof signature==='string' && /^[0-9a-f]{64}$/.test(signature) && crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(digest(secret,ref,note,items)));
}
const types=new Set(['call_result','checklist','budget','payment','deadline','wishlist','phone','promise','return','stage','disable']);
const checklistTerms={1:/carro|modelo|ano|milha|critério/i,2:/teto|orçamento|valor|total/i,3:/pagamento|financ|vista/i,4:/prazo|urgên|dia|mês|semana/i,5:/flórida|florida|outro estado|fora da fl/i,6:/inspeção|devolução|risco|test drive/i};
const outcome={ANSWERED:/atendeu|conversamos|falei|falamos/i,NO_ANSWER:/não atendeu|sem resposta|caixa postal|não respondeu/i,LATER:/ligar depois|retornar|retorno|ligue/i,IN_PERSON:/presencial|pessoalmente/i,DEPOSIT:/depósito|deposito/i};
function evidenceNumber(text, amount) {
  return [...text.matchAll(/(?:^|[^\d])((?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:\s*(?:mil|k))?)(?=$|[^\d])/gi)]
    .some((match)=>{
      const token=match[1].toLowerCase();
      const multiplier=/\s*(?:mil|k)$/.test(token)?1000:1;
      return Number(token.replace(/(?:mil|k)$/,'').replace(/[.,\s]/g,''))*multiplier===Number(amount);
    });
}
function checklistDenied(point, evidence) {
  if (point===6) return /(?:não|nunca)\s+(?:\w+\s+){0,3}(?:aceita|entende|sabe|confirm)/i.test(evidence);
  const subject={1:'carro|modelo|ano|milha|critério',2:'teto|orçamento|valor|total',3:'pagamento|financ|vista',4:'prazo|urgên|dia|mês|semana',5:'flórida|florida|outro estado|fora da fl'}[point];
  return new RegExp('(?:não|ainda não|sem confirmar)\\s+(?:[\\wÀ-ÿ]+\\s+){0,4}(?:'+subject+')','i').test(evidence);
}
function evidenceSupports(item) {
  const e=String(item.evidence||'').toLowerCase(),v=item.value;
  const hasNumber=(n)=>Number.isFinite(Number(n))&&new RegExp('(^|\\D)'+String(Number(n)).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(\\D|$)').test(e.replace(/[,.](?=\d{3}\b)/g,''));
  if(item.type==='budget') return evidenceNumber(e,v)&&/teto|total|orçamento|limite|máximo|final|valor/i.test(e);
  if(item.type==='checklist') return checklistTerms[item.point]?.test(e)&&!checklistDenied(item.point,e) && /confirm|sim|aceit|entend|sabe|ciente|combin|defin|fechad|será|vai |é |está /i.test(e);
  if(item.type==='call_result') return Boolean(outcome[v]?.test(e));
  if(item.type==='payment') return v==='cash'?/à vista|a vista|dinheiro|cash/i.test(e):v==='fin'?/financi/i.test(e):false;
  if(item.type==='deadline') return v==='now'?/agora|imediat|hoje/i.test(e):v==='30d'?/30\s*dias|um mês|1\s*mês/i.test(e):v==='3m'?/90\s*dias|3\s*meses|três meses/i.test(e):/sem prazo/i.test(e);
  if(item.type==='promise'||item.type==='return') return /\b\d{1,2}(?:[:h]\d{2})?\s*(?:h|horas)?\b|amanhã|quinta|sexta|segunda|terça|quarta|sábado|domingo|hoje/i.test(e) && /\b\d{1,2}(?:[:h]\d{2})?\s*(?:h|horas)\b|\b\d{1,2}:\d{2}\b/i.test(e);
  if(item.type==='phone') return String(v?.number||'').replace(/\D/g,'').slice(-7)===e.replace(/\D/g,'').slice(-7)&&(!v?.owner||e.includes(String(v.owner).toLowerCase()));
  if(item.type==='wishlist') return Boolean(v?.car?.model&&e.includes(String(v.car.model).toLowerCase()))&&(!v.car.yearMin||hasNumber(v.car.yearMin))&&(!v.car.yearMax||hasNumber(v.car.yearMax))&&(!v.car.maxMiles||hasNumber(v.car.maxMiles));
  if(item.type==='stage') return ({QUALIFICADO:/qualificad/i,EM_BUSCA:/busca|procur/i,DECIDINDO:/decid|avali/i,RESPONDIDO:/respond/i,NOVO:/novo/i})[v]?.test(e)||false;
  if(item.type==='disable') return Boolean(v?.reason&&e.includes(String(v.reason).toLowerCase()));
  return false;
}
function validItems(note,items) {
  return (Array.isArray(items)?items:[]).slice(0,30).filter((item)=>item&&types.has(item.type)&&typeof item.evidence==='string'&&item.evidence.trim().length>=2&&note.includes(item.evidence)).map((item)=>({...item,manualReview:Boolean(item.manualReview)||!evidenceSupports(item)}));
}
function wishlistAfter(wishes, value) {
  const list=(Array.isArray(wishes)?wishes:[]).map((w)=>({...w}));
  const op=String(value?.operation||'').toLowerCase();
  const car={make:String(value?.car?.make||'').trim(),model:String(value?.car?.model||'').trim(),yearMin:Number(value?.car?.yearMin)||null,yearMax:Number(value?.car?.yearMax)||null,maxMiles:Number(value?.car?.maxMiles)||null};
  const index=list.findIndex((entry)=>String(entry.make).toLowerCase()===car.make.toLowerCase()&&String(entry.model).toLowerCase()===car.model.toLowerCase());
  if (!['include','remove','reorder','update'].includes(op)||!car.model) throw new Error('WISHLIST_OPERATION_INVALID');
  if (op==='remove') { if(index>=0) list.splice(index,1); }
  else if(op==='include') { if(index<0) list.push(car); else list[index]={...list[index],...Object.fromEntries(Object.entries(car).filter(([,v])=>v!==null&&v!==''))}; }
  else { if(index<0) throw new Error('WISHLIST_CAR_NOT_FOUND'); const existing=list.splice(index,1)[0];list.splice(op==='reorder'?Math.max(0,Math.min(list.length,(Number(value.preference)||1)-1)):index,0,op==='update'?{...existing,...Object.fromEntries(Object.entries(car).filter(([,v])=>v!==null&&v!==''))}:existing); }
  return list.slice(0,10);
}
function prepareItems(items, lead) {
  const { localToUtc, addClientDays }=require('./panel-lead');
  let wishes=lead.wishes||[];
  return items.map((item)=>{
    const prepared={...item};
    if(item.type==='wishlist') { try { wishes=wishlistAfter(wishes,item.value);prepared.finalWishes=wishes; } catch (_) { prepared.manualReview=true;prepared.finalWishes=wishes; } }
    if(item.type==='return'||item.type==='promise'||item.type==='call_result') {
      const raw=item.type==='call_result'?item.dueAt:item.value?.at;
      if(raw) prepared.dueUtc=/^\d{4}-\d\d-\d\dT\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(raw)?new Date(raw).toISOString():localToUtc(String(raw).slice(0,16),lead.timezone);
      if(item.type==='call_result'&&!prepared.dueUtc&&['ANSWERED','NO_ANSWER'].includes(item.value)) prepared.dueUtc=addClientDays(Date.now(),lead.timezone,item.value==='ANSWERED'?2:1);
      if(item.type==='call_result'&&item.value==='DEPOSIT') prepared.dueUtc=new Date().toISOString();
      if((item.type==='promise'||item.type==='return'||item.value==='LATER')&&!prepared.dueUtc) prepared.manualReview=true;
    }
    return prepared;
  });
}
module.exports={digest,verified,validItems,wishlistAfter,evidenceSupports,prepareItems};
