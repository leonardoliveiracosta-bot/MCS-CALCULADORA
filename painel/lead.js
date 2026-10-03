(() => {
  'use strict';
  const e = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined && text !== null) node.textContent = String(text); return node; };
  const append = (parent, tag, cls, text) => { const node = e(tag,cls,text); parent.append(node); return node; };
  const fmt = (value) => Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(Number(value)) : '—';
  const cents = (value) => value ? fmt(Number(value)/100) : '—';
  const date = (value,tz='America/New_York') => value ? new Intl.DateTimeFormat('pt-BR',{timeZone:tz,dateStyle:'short',timeStyle:'short'}).format(new Date(value)) : '—';
  const badge = (text,cls) => e('span','lead-badge '+(cls||''),text);
  const button = (parent,label,commit,cls='quiet small') => { const node=append(parent,'button',cls,label); node.type='button'; MCSAction.bind(node,()=>({scope:parent,commit,errorText:(error)=>error?.userMessage||'Não consegui salvar, tente de novo'})); return node; };
  // M31: a button that cannot act yet says why instead of doing nothing
  const needs = (message) => Object.assign(new Error('INPUT_REQUIRED'), { userMessage: message });
  const section = (root,n,title,cls='') => { const card=append(root,'section','lead-card '+cls); append(card,'span','lead-label',`${n} — ${title}`); return card; };
  const row = (root,...values) => { const line=append(root,'div','lead-line'); values.forEach((value)=> append(line,'span','',value || '—')); return line; };
  const stageNames = ['Searching','Cars presented','Bid scheduled','Result'];
  const deadlineLabel = {now:'Imediatamente','30d':'Até 30 dias','3m':'30 a 90 dias',none:'Sem prazo definido','6m':'Até 6 meses','12m':'Até 12 meses'};
  const paymentLabel = {cash:'À vista',fin:'Financiado'};
  const formatPhone=(value)=>{const digits=String(value||'').replace(/\D/g,'');if(digits.length===11&&digits[0]==='1')return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;return value||'sem telefone';};
  const elapsed = (value) => { const hours=(Date.now()-Date.parse(value))/3600000; return hours < 1 ? `${Math.max(1,Math.round(hours*60))} min` : hours < 48 ? `${Math.floor(hours)} h` : `${Math.floor(hours/24)} dias`; };
  const safeString = (value) => value === null || value === undefined ? '' : String(value);
  const directLeadLabel = (source) => source==='WHATSAPP_DIRECT'?'📱 Veio por mensagem · Via WhatsApp (sem calculadora)':source==='SMS_DIRECT'?'✉️ Veio por mensagem · Via SMS (sem calculadora)':'';
  function model(wish) { const make=safeString(wish.make);let name=safeString(wish.model);if(/^not sure$/i.test(name))name='';if(/^other model$/i.test(name))name='Outro modelo';return make&&name.toLowerCase().startsWith(make.toLowerCase()+' ') ? name : [make,name].filter(Boolean).join(' '); }
  const moneyLabel=(value)=>fmt(Number(value));
  function itemLabel(item,tz) {
    const v=item.value;
    if(item.type==='call_result')return ({ANSWERED:'Atendeu',NO_ANSWER:'Não atendeu',LATER:'Pediu para ligar depois',IN_PERSON:'Conversa presencial',DEPOSIT:'Vai pagar o depósito'})[v]||String(v);
    if(item.type==='checklist')return 'Ponto '+item.point+' — OK';
    if(item.type==='budget')return moneyLabel(v)+' de teto total confirmado';
    if(item.type==='payment')return paymentLabel[v]||String(v);
    if(item.type==='deadline')return deadlineLabel[v]||String(v);
    if(item.type==='stage')return ({NOVO:'Novo',RESPONDIDO:'Respondido',EM_BUSCA:'Em busca',DECIDINDO:'Decidindo',QUALIFICADO:'Qualificado'})[v]||String(v);
    if(item.type==='wishlist')return (item.finalWishes||[]).map((car,index)=>{
      const years=car.yearMin&&car.yearMax?`${car.yearMin}–${car.yearMax}`:car.yearMin?`a partir de ${car.yearMin}`:car.yearMax?`até ${car.yearMax}`:'';
      return `${model(car)} ${years} ${car.maxMiles?'até '+Number(car.maxMiles).toLocaleString('pt-BR')+' mi':''} (preferência ${index+1})`.replace(/\s+/g,' ').trim();
    }).join(' · ');
    if(item.type==='phone')return `Telefone ${v.number||''} — ${v.owner||'contato'}`;
    if(['promise','return'].includes(item.type))return `${v.text||''} · ${date(item.dueUtc,tz)} (horário do cliente)`;
    if(item.type==='disable')return `Sugerir desligar: ${v.reason||''}`;
    return String(v||'');
  }
  function timelineRows(data) {
    const record=data.record||{};
    const undone=new Set((record.interactions||[]).filter((item)=>item.detail_text==='Desfeito').map((item)=>'interaction:'+item.id));
    const represented=new Set((data.events||[]).map((item)=>item.detail_json?.interactionId).filter(Boolean).map((id)=>'interaction:'+id));
    const entries=[...(record.timeline||[]).filter((item)=>!undone.has(item.id)&&!represented.has(item.id)).map((item)=>({at:item.occurredAt,text:item.label||item.body_text||'Mensagem'})),
      ...(data.notes||[]).map((item)=>({at:item.created_at,text:`Anotação: ${item.body_text}${(item.distributed_json||[]).length?' · Distribuído: '+item.distributed_json.map((part)=>({call_result:'Resultado',checklist:'Checklist '+part.point,budget:'Teto total',payment:'Pagamento',deadline:'Prazo',wishlist:'Lista de desejo',phone:'Telefone',promise:'Promessa',return:'Retorno',stage:'Etapa',disable:'Sugestão'}[part.type]||part.type)+': '+itemLabel(part,data.timezone)).join('; '):''}`})),
      ...(data.events||[]).map((item)=>({at:item.occurred_at,text:item.event_type==='EXTRA_PHONE'?`Telefone extra (${item.detail_json?.owner||'contato'}): ${item.detail_json?.number}`:item.event_type==='DISABLE_SUGGESTED'?`Sugestão de desligar: ${item.detail_json?.reason||'sem motivo'}`:item.detail_json?.label||item.detail_json?.vehicle||({QUICK_ANSWERED:'Ligação atendida',QUICK_NO_ANSWER:'Ligação não atendida',QUICK_LATER:'Pediu para ligar depois',QUICK_IN_PERSON:'Conversa presencial',QUICK_DEPOSIT:'Vai pagar o depósito',WANT_CAR:'Cliente quer este carro',NOT_FOR_ME:'Cliente não quer este carro',NOTE_CONFIRMED:'Anotação confirmada',UNIT_PRESENTED:'Carro apresentado',TOTAL_CEILING_UPDATED:'Teto total confirmado'}[item.event_type]||String(item.event_type||'Atividade').replaceAll('_',' ').toLocaleLowerCase('pt-BR'))})),
      ...(data.aiHelp||[]).map((item)=>({at:item.created_at,text:`Ajuda da IA: ${item.answer_json?.sugestao||'Resposta registrada'}`})),
      ...(data.order?.simulations||[]).map((item)=>({at:item.occurredAt,text:`Simulação ${item.logicalMode==='VALOR'?'por valor':'carro ideal'} · ${item.vehicleText||'sem carro'}`}))];
    if (record.contact?.notes) entries.push({at:record.created_at,text:`Nota antiga: ${record.contact.notes}`});
    return entries.sort((a,b)=>Date.parse(b.at||0)-Date.parse(a.at||0));
  }
  async function open(options) {
    const {kind,key,root,request,onChanged,actionMessage,downloadShortlist,dispositionControls,mediaObjectUrl,replyComposer,openOptions,openTab,isCurrent} = options;
    const data=await request('/api/panel/lead?'+new URLSearchParams(kind==='order'?{ref:key}:{id:key}));
    // A late answer of another person (or another opening of the same one) never draws over the ficha now on screen.
    if(typeof isCurrent==='function'&&!isCurrent())return;
    root.replaceChildren(); root.classList.add('lead-detail');
    const record=data.record||{},order=data.order||{},track=data.track||null,ref=data.ref,hasCalculatorRef=(data.hasCalculatorRef!==false&&Boolean(data.order))||record.hasCalcRef===true,journeyId=record.id;
    // Ref = proven by the calculator (simulation or the client's calculator message); a code of the ficha without that proof is internal.
    const calcRef=record.hasCalcRef===true?record.calcRef:record.hasCalcRef===false?null:(ref||record.reference_code||null);
    let activeUndo=null;
    const api=async(action,fields={})=>{
      const result=await request('/api/panel/lead',{method:'POST',body:JSON.stringify({action,ref,journeyId,...fields})});
      if(action!=='undo'&&action!=='quick'&&activeUndo){activeUndo.remove();activeUndo=null;}
      return result;
    };
    const reload=async()=>{const position=window.scrollY; await onChanged(); requestAnimationFrame(()=>window.scrollTo(0,position));};
    // "Desfazer" right after a reversible action: a notice pinned to the page (it survives the ficha
    // being redrawn) with one button that puts the previous state back.
    const undoNotice=(text,undoFn)=>{const notice=window.MCSAction&&MCSAction.feedback(document.body,text,'','lead-undo');if(!notice)return;const back=e('button','quiet small','Desfazer');back.type='button';notice.append(' ',back);
      back.addEventListener('click',async()=>{back.disabled=true;try{await undoFn();notice.replaceChildren(document.createTextNode('Desfeito'));await reload();}catch(failure){back.disabled=false;notice.append(' · '+(failure&&failure.code==='UNDO_EXPIRED'?'Passou o tempo para desfazer':'Não consegui desfazer'));}});};
    const actionsApi=(action,fields)=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action,journeyId,...fields})});
    const failed=(card,text)=>append(card,'p','status error',text);
    const title=record.contact?.display_name||order.contactName||'Contato sem nome';
    const phones=(record.phones||[]).filter((item)=>item.is_current!==false).sort((a,b)=>Number(Boolean(b.is_primary))-Number(Boolean(a.is_primary)));
    const heading=section(root,1,'CABEÇALHO DA LIGAÇÃO');
    const header=append(heading,'div','lead-header');
    append(header,'div','lead-score',data.score===null?'—':data.score);
    const identity=append(header,'div','lead-head-name'); append(identity,'h2','',`${title} — ${calcRef?'Ref '+calcRef:'sem Ref da calculadora'}`);if(calcRef&&(record.calcRefsWithoutRun||[]).includes(calcRef))append(identity,'span','muted lead-ref-note',`Ref ${calcRef} comprovada pela mensagem da calculadora · simulação não registrada`);if(record.internalCode)append(identity,'span','muted lead-ref-note',`Código da ficha ${record.internalCode} · interno, não é Ref da calculadora`);const directOrigin=directLeadLabel(data.directLeadSource);if(directOrigin)append(identity,'span','lead-badge blue',directOrigin);
    const locationLine=append(identity,'p','muted',`${data.city?data.city+', ':''}${data.state?.uf||'Local não identificado'}${data.zip?` · ZIP ${data.zip}`:''}`);
    if(data.zip&&!data.city)request('/api/panel/lead?cityZip='+encodeURIComponent(data.zip)).then((place)=>{
      if(locationLine.isConnected&&place.city)locationLine.textContent=`${place.city}, ${data.state?.uf||''} · ZIP ${data.zip}`;
    }).catch(()=>{});
    const right=append(header,'div','lead-head-right');
    append(right,'strong','lead-clock',new Intl.DateTimeFormat('pt-BR',{timeZone:data.timezone,hour:'2-digit',minute:'2-digit'}).format(new Date()));
    append(right,'span','muted',` horário do cliente · ${data.goodHour?'bom horário para ligar':'fora de horário'}`);
    const calling=append(right,'div','lead-actions');
    if(phones.length){phones.forEach((phone)=>{const line=append(calling,'div','lead-phone');const shown=formatPhone(phone.phone_e164||phone.phone_raw);const link=append(line,'a','lead-call',`${shown}${phone.phone_owner?' — '+phone.phone_owner:''}${phone.is_primary?' · principal':''}`);link.href='tel:'+safeString(phone.phone_e164||phone.phone_raw).replace(/[^\d+]/g,'');button(line,'Copiar',()=>navigator.clipboard.writeText(phone.phone_e164||phone.phone_raw));});}
    else append(calling,'span','muted','Sem telefone, pedir no WhatsApp');
    const badges=append(heading,'div','lead-badges');
    // M11: an unknown deadline or payment is shown as unknown, not as "sem prazo" or "à vista".
    badges.append(data.deadlineKnown?badge(deadlineLabel[data.deadlineKnown]||data.deadlineKnown,'green'):badge('Prazo não informado','yellow'),data.paymentKnown?badge(paymentLabel[data.paymentKnown],'green'):badge('Pagamento não informado','yellow'));
    if(data.searchStage)badges.append(badge(data.searchStage.label||({MISSING:'🔍 Busca não salva no Manheim',SAVED:'💾 Busca salva no Manheim',SENT:'📤 Opções enviadas'}[data.searchStage.stage]||''),data.searchStage.stage==='SENT'?'green':data.searchStage.stage==='SAVED'?'':'yellow'));
    if(data.lastCustomerAt) badges.append(badge(`última mensagem do cliente há ${elapsed(data.lastCustomerAt)}`));
    badges.append(badge(record.enabled===false?'DESLIGADO':'LIGADO',record.enabled===false?'red':'green'));
    if(data.disposition)badges.append(badge(data.disposition==='TREATED'?'Tratado':'Descartado',data.disposition==='DISCARDED'?'red':''));
    if(dispositionControls) heading.append(dispositionControls(order.ref?{kind:'CALCULATOR',ref,disposition:data.disposition}:{kind:'JOURNEY',id:record.id,disposition:data.disposition}));
    // Two clicks on the page itself (a browser dialog can be answered "no" without showing up).
    const restoring=record.contact?.is_lead===false;const leadToggle=button(heading,restoring?'Restaurar como lead':'Não é lead',async()=>{if(leadToggle.dataset.confirmed!=='true'){leadToggle.dataset.confirmed='true';leadToggle.textContent=restoring?'Confirmar: restaurar como lead':'Confirmar: não é lead (as mensagens ficam guardadas)';return;}await api('contact_lead',{isLead:restoring});undoNotice(restoring?'Restaurado como lead':'Marcado como não é lead',()=>api('contact_lead',{isLead:!restoring}));await onChanged();});
    const aiReading=data.ai?.reading;
    let aiReadingBlock=null;
    if(aiReading){
      const summary=aiReadingBlock=e('div','lead-card lead-highlight ai-summary');append(summary,'span','lead-label','LEITURA DA CONVERSA (IA, NÃO CONFIRMADA)');
      const want=append(summary,'p');append(want,'b','','Quer: ');want.append(document.createTextNode(aiReading.summary_json?.want||'Ainda não identificado'));
      const money=append(summary,'p');append(money,'b','','Dinheiro: ');money.append(document.createTextNode(aiReading.summary_json?.money||'Ainda não identificado'));
      const missing=append(summary,'p');append(missing,'b','','Falta saber: ');missing.append(document.createTextNode(aiReading.summary_json?.missing||'Nada indicado pela leitura'));
      append(summary,'div','muted',`Atualizado há ${elapsed(aiReading.created_at)} · ${aiReading.summary_json?.contextTruncated?'baseado nas últimas':'baseado em'} ${aiReading.message_count} mensagens`);
    }
    const aiSuggestion=data.ai?.suggestion;
    if(aiSuggestion){
      const suggestion=append(heading,'div','lead-card lead-highlight ai-link-suggestion');append(suggestion,'span','lead-label','LIGAÇÃO SUGERIDA');
      // "É a Ref X" when the customer wrote the Ref in this conversation; "parece ser" only with real doubt.
      const refWritten=new RegExp('\\b'+String(aiSuggestion.target_ref||'').replace(/[^A-Z0-9]/gi,'')+'\\b','i');const confirmedRef=Boolean(aiSuggestion.target_ref)&&(record.conversation||[]).some((message)=>message.direction==='CUSTOMER'&&refWritten.test(String(message.body_text||'')));
      const text=append(suggestion,'p');text.append(document.createTextNode(confirmedRef?'Esta conversa é a ':'Esta conversa parece ser o pedido '));append(text,'strong','ref',`Ref ${aiSuggestion.target_ref}`);
      append(suggestion,'div','muted',`Motivos: ${aiSuggestion.motives||'sinais da conversa e da simulação.'}`);
      const actions=append(suggestion,'div','lead-actions');
      button(actions,'Ligar pedido à ficha',async()=>{const result=await request('/api/panel/ai-conversations',{method:'POST',body:JSON.stringify({action:'suggestion',journeyId:record.id,suggestionId:aiSuggestion.id,link:true})});if(result&&result.undoable)undoNotice(`Ref ${aiSuggestion.target_ref} ligada à ficha`,()=>request('/api/panel/ai-conversations',{method:'POST',body:JSON.stringify({action:'suggestion_undo',journeyId:record.id,suggestionId:aiSuggestion.id})}));await reload();},'small');
      button(actions,'Não é',async()=>{await request('/api/panel/ai-conversations',{method:'POST',body:JSON.stringify({action:'suggestion',journeyId:record.id,suggestionId:aiSuggestion.id,link:false})});await reload();},'quiet small');
      button(actions,'Escolher outro pedido',async()=>{const result=await request('/api/panel/ai-conversations',{method:'POST',body:JSON.stringify({action:'alternatives',journeyId:record.id})});
        let picker=suggestion.querySelector('.ai-alternative-picker');if(picker)picker.remove();picker=append(suggestion,'div','lead-actions ai-alternative-picker');const select=append(picker,'select');select.append(new Option('Escolha outro pedido',''));
        (result.items||[]).filter((item)=>item.ref!==aiSuggestion.target_ref).forEach((item)=>select.append(new Option(`Ref ${item.ref} · ${item.name||'sem nome'} · ${item.vehicle||'sem carro'} · ${cents(item.budgetCents)}`,item.ref)));
        button(picker,'Ligar pedido escolhido à ficha',async()=>{if(!select.value)return;await request('/api/panel/ai-conversations',{method:'POST',body:JSON.stringify({action:'choose',journeyId:record.id,ref:select.value})});await reload();},'small');
      },'quiet small');
    }

    // The case summary, the same data every tab shows: field by field with its source, stage, who it
    // depends on, what is missing and the next action. Loaded apart: the ficha never waits for it.
    if(window.MCSContext){const slot=append(root,'section','lead-card client-context-full');append(slot,'span','lead-label','RESUMO DO CASO');append(slot,'p','muted','Carregando o resumo do caso…');
      (journeyId?MCSContext.forJourney(journeyId,request):MCSContext.forRef(ref,request)).then((context)=>{if(!slot.isConnected)return;if(!context||context.unlinked){slot.replaceChildren(e('span','lead-label','RESUMO DO CASO'),e('p','muted',context&&context.unlinked||'Resumo indisponível para este caso.'));return;}slot.replaceWith(MCSContext.full(context));})
        .catch(()=>{if(slot.isConnected)slot.replaceChildren(e('span','lead-label','RESUMO DO CASO'),e('p','muted','Não foi possível carregar o resumo agora · O resto da ficha continua valendo'));});}
    if(aiReadingBlock)root.append(aiReadingBlock);
    // The conversation and the quick result come right after the summary (built below, moved here).
    const topAnchor=append(root,'div','lead-top-anchor');
    const trio=append(root,'div','lead-grid lead-three');
    const wishes=section(trio,4,'O QUE ELE QUER');
    if(!data.wishes.length) append(wishes,'p','muted','Carro ainda não informado');
    data.wishes.forEach((wish,index)=>row(wishes,`${index+1}. ${model(wish)}`,`${wish.yearMin||'—'}–${wish.yearMax||'—'}`,wish.maxMiles?`até ${Number(wish.maxMiles).toLocaleString('en-US')} mi`:'milhas não informadas'));
    append(wishes,'p','muted',`Lance máximo${data.bidSource==='CALCULADORA'?' (calculadora)':data.bidSource==='FICHA'?' (ficha)':''}: ${data.maxBidCents?cents(data.maxBidCents):'não informado'}`);
    if((data.calculatorNews||[]).length){const news=append(wishes,'div','calculator-news');append(news,'strong','','Nova informação da calculadora (a ficha não foi alterada)');
      data.calculatorNews.forEach((item)=>append(news,'p','muted',item.field==='LANCE'?`Lance: calculadora ${cents(item.calculatorCents)} · ficha ${cents(item.fichaCents)}`:`${({PAGAMENTO:'Pagamento',VEICULO:'Veículo',NOME:'Nome'})[item.field]||item.field}: calculadora "${item.calculator}" · ficha "${item.ficha}"`));}
    append(wishes,'p','muted',`Teto total confirmado: ${cents(data.totalCeilingCents)}`);
    append(wishes,'p','muted',`${data.zipKnown===false?'ZIP não informado (estimativa como FL)':data.florida?'Registra na FL':'Registra fora da FL'} · placa: ${data.plate==='nova'?'nova':data.plateInformed===false?'não informada (custo calculado como transferir)':'transferir'}`);
    const ceilingForm=append(wishes,'div','lead-actions');const ceilingInput=append(ceilingForm,'input');ceilingInput.type='number';ceilingInput.min='1';ceilingInput.step='1';ceilingInput.placeholder='Teto total confirmado (US$)';ceilingInput.value=data.totalCeilingCents?data.totalCeilingCents/100:'';
    button(ceilingForm,'Confirmar teto total',async()=>{await api('total_ceiling',{amount:ceilingInput.value});await reload();});
    const reality=section(trio,5,'REALIDADE (SÓ PARA VOCÊ)');
    append(reality,'p','',`Lance realista: ${data.bid===null?(data.totalCeilingCents?'sem lance viável no teto':'lance máximo não informado'):fmt(data.bid)}`);
    if(!data.typical.length) append(reality,'p','muted','MMR típico: sem referência');
    data.typical.forEach((wish)=>{ append(reality,'p','muted',`MMR típico ${model(wish)}: ${wish.mmrCents?cents(wish.mmrCents):'sem referência'}`);
      if(wish.mmrCents&&data.bid!==null&&wish.mmrCents>data.bid*100) reality.append(badge(`Teto curto em ~${cents(wish.mmrCents-data.bid*100)}`,'yellow')); });
    append(reality,'p','muted','Dentro do teto do cliente: '+(data.fits.length?data.fits.map((car)=>`${car.make} ${car.model} ${car.year} · ${Number(car.miles).toLocaleString('en-US')} mi`).join(' · '):'sem combinação nos CSVs'));
    const numbers=section(trio,6,'NÚMEROS PRONTOS');
    if(data.costs){const c=data.costs;row(numbers,'Depósito',fmt(c.deposito));row(numbers,'Taxa de serviço',fmt(c.servico));row(numbers,'Taxa do leilão + fixas',fmt(c.gLeilao));row(numbers,'Tax, title & registration',fmt(c.gTaxReg));row(numbers,'Total estimado',fmt(c.totalProjetado));}
    else append(numbers,'p','muted',data.totalCeilingCents?'O teto não cobre o lance mínimo e os custos':'Lance máximo ainda não informado');

    const second=append(root,'div','lead-grid lead-three');
    const questions=section(second,7,'PERGUNTAR NA LIGAÇÃO');
    // The open points are marked here (the owner of the question); DADOS E HISTÓRICO lists the done ones.
    data.checklist.filter((point)=>point.status!=='COMPLETE').forEach((point)=>{const line=append(questions,'p','lead-question',`${point.point_number}. ${point.point_label}?`);button(line,'Marcar OK',async()=>{await api('checklist',{point:point.point_number,complete:true});await reload();});});
    if(data.bid!==null&&data.typical.some((wish)=>wish.mmrCents&&wish.mmrCents>data.bid*100)) append(questions,'p','',`O teto de ${cents(data.totalCeilingCents||data.maxBidCents)} é final ou tem margem?`);
    if(!questions.querySelector('p'))append(questions,'p','muted','Checklist completo');
    const offers=section(second,8,'O QUE OFERECER');
    // OPÇÕES owns the selection for the client and the V1; this section shows what the batch has and leads there.
    const offerModes=[...new Set((data.offers||[]).map((car)=>car.mode).filter(Boolean))];
    append(offers,'p','muted',`${data.offers.length} carro(s) compatível(is) no lote ativo · A seleção para o cliente e a V1 são feitas em ENVIAR OPÇÕES`);
    if(journeyId&&(openOptions||openTab)){const go=append(offers,'div','lead-actions');if(offerModes.length&&openOptions)offerModes.forEach((mode)=>button(go,`Abrir em ENVIAR OPÇÕES · ${mode==='VALOR'?'POR VALOR':'POR ANO E MILHAGEM'}`,()=>openOptions(`journey:${journeyId}:${mode}`),'small'));else if(openTab)button(go,'Abrir ENVIAR OPÇÕES',()=>openTab('searches'),'small');}
    if(!data.offers.length)append(offers,'p','muted','Nenhum carro compatível nos CSVs recentes');
    // Adendo, item 2: each search type in one group (com carros, sem carros with the reason, ainda não rodada).
    (data.searchModes||[]).forEach((mode)=>{const count=data.offers.filter((car)=>car.mode===mode).length,label=mode==='VALOR'?'Por valor':'Por carro (ano e milhagem)';const line=append(offers,'p','lead-search-group');
      if(!data.batchActive){line.dataset.searchGroup='NAO_RODADA';line.textContent=`Busca ainda não rodada · ${label}: nenhum lote ativo do Manheim`;return;}
      if(count){line.dataset.searchGroup='COM_CARROS';line.textContent=`Com carros · ${label}: ${count} carro(s) no lote ativo`;return;}
      line.dataset.searchGroup='SEM_CARROS';line.textContent=`Sem carros · ${label}: a busca rodou no lote ativo e nenhum carro serviu`;
      if(journeyId){const reason=append(offers,'p','search-empty-reason','Motivo: lendo o lote…');request('/api/panel/pesquisas',{method:'POST',timeoutMs:60000,body:JSON.stringify({action:'empty_reasons',keys:[`ficha:journey:${journeyId}:${mode}`]})}).then((out)=>{const found=(out.reasons||{})[`ficha:journey:${journeyId}:${mode}`];reason.textContent='Motivo: '+(found?found.text:'nenhum carro do lote ativo serviu para estes critérios');}).catch(()=>{reason.textContent='Motivo: não consegui ler o lote agora';});}});
    data.offers.forEach((car)=>{const line=append(offers,'div','lead-offer');line.append(badge(car.kind==='POR_VALOR'?'POR VALOR · ligar':car.kind,car.kind==='BATE'?'green':car.kind==='POR_VALOR'?'blue':'yellow'));
      append(line,'span','',`${car.year} ${car.make} ${car.model} ${car.trim||''} · ${car.miles===null||car.miles===undefined||car.miles===''?'milhagem não informada':Number(car.miles).toLocaleString('en-US')+' mi'} · ${car.locationDisplay||car.location||''} · ${car.saleDate||'data não informada'}`);
      if(car.matchNotice)line.append(badge(car.matchNotice,'yellow'));else if(car.matchReason)append(line,'span','muted',car.matchReason);
      if(car.mode)line.append(badge(car.mode==='VALOR'?'POR VALOR':'POR ANO E MILHAGEM',car.mode==='VALOR'?'blue':'green'));
      button(line,'Registrar que apresentei',async()=>{const result=await api('present',{fingerprint:car.rowFingerprint,mode:car.mode||null});if(result&&result.undo)undoNotice('Apresentação registrada',()=>actionsApi('present_undo',result.undo));await reload();}); });
    const context=section(second,9,'CONTEXTO RÁPIDO');
    const allPromises=[...(record.promises||[]),...(data.promises||[])];
    const promises=allPromises.filter((promise)=>promise.status==='OPEN');
    const clientDay=(value)=>new Intl.DateTimeFormat('en-CA',{timeZone:data.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
    promises.forEach((promise)=>{const line=append(context,'p','',`Prometi: ${promise.promise_text}`);const due=clientDay(promise.due_at),today=clientDay(Date.now());if(due<=today)line.append(badge(due<today?'vencida':'vence hoje',due<today?'red':'yellow'));});
    const presented=append(context,'p','',`Já apresentados: ${record.units?.length?record.units.map((unit)=>unit.vehicle_text).join(' · '):'nenhum carro'}`);
    if(record.units?.length){const seeUnits=button(presented,'↓ detalhes em DADOS E HISTÓRICO',()=>document.getElementById('lead-units')?.scrollIntoView({behavior:'smooth'}));seeUnits.classList.add('lead-context-link');}
    [...(record.conversation||[])].filter((message)=>message.direction==='CUSTOMER').slice(-3).reverse().forEach((message)=>{
      const link=button(context,`↓ ${safeString(message.body_text).slice(0,120)}`,()=>document.getElementById('lead-conversation')?.scrollIntoView({behavior:'smooth'}));link.classList.add('lead-context-link'); });

    const note=section(root,10,'ANOTAÇÕES E AJUDA DA IA','lead-highlight');
    append(note,'p','muted','Escreva do seu jeito, em português · Peça uma opinião sobre este cliente, ou anote o que conversou por telefone ou pessoalmente');
    const textarea=append(note,'textarea','lead-note');textarea.placeholder='Anote a conversa aqui…';textarea.maxLength=12000;
    const draftKey='mcs_lead_draft_'+(ref||journeyId);textarea.value=sessionStorage.getItem(draftKey)||'';
    textarea.addEventListener('input',()=>sessionStorage.setItem(draftKey,textarea.value));
    const noteStatus=append(note,'p','status','');const review=append(note,'div','lead-review');
    button(note,'📋 Distribuir o que conversei',async()=>{
      const body=textarea.value.trim();if(!body){noteStatus.textContent='Escreva a anotação antes de distribuir';textarea.focus();return;}
      noteStatus.textContent='Distribuindo…';review.replaceChildren();const confirmationKey=crypto.randomUUID();
      try{
        const proposal=await request('/api/panel/notes/distribute',{method:'POST',body:JSON.stringify({ref,journeyId,note:body,fallbackKey:confirmationKey})});
        if(proposal.saved){sessionStorage.removeItem(draftKey);textarea.value='';noteStatus.textContent=proposal.message;return;}
        noteStatus.textContent='Vai para:';
        const selected=[],manualDates={};
        proposal.items.forEach((item,index)=>{
          const line=append(review,'label','lead-route');const input=append(line,'input');input.type='checkbox';input.checked=!item.manualReview;selected.push(input);
          append(line,'strong','',item.type==='checklist'?`Checklist ${item.point} → OK`:({call_result:'Resultado da ligação',budget:'Teto',payment:'Pagamento',deadline:'Prazo',wishlist:'Lista de desejo',phone:'Telefones',promise:'Promessa',return:'Retorno',stage:'Etapa operacional',disable:'Desligar lead'}[item.type]||item.type));
          const detail=append(line,'div','lead-route-value');append(detail,'span','',itemLabel(item,data.timezone));append(detail,'small','muted',`“${item.evidence}”`);if(item.manualReview)append(detail,'span','lead-badge yellow','confirmar manualmente');
          if(!item.dueUtc&&(item.type==='promise'||item.type==='return'||item.type==='call_result'&&item.value==='LATER')){
            input.checked=false;input.disabled=true;
            const dateLabel=append(detail,'label','muted','Data e hora, horário do cliente');
            const due=append(detail,'input','lead-manual-date');due.type='datetime-local';due.setAttribute('aria-label','Data e hora, horário do cliente');
            due.addEventListener('input',()=>{manualDates[index]=due.value;input.disabled=!due.value;if(!due.value)input.checked=false;});
            dateLabel.htmlFor=due.id='lead-manual-date-'+index;
          }
        });
        const actions=append(review,'div','lead-actions');
        button(actions,'Confirmar',async()=>{await api('note',{note:body,proposal:proposal.items,signature:proposal.signature,selected:selected.flatMap((input,index)=>input.checked?[index]:[]),manualDates,confirmationKey});sessionStorage.removeItem(draftKey);await reload();},'small');
        button(actions,'Editar anotação',()=>{review.replaceChildren();noteStatus.textContent='';});
      }catch(_){await api('note',{note:body,proposal:[],selected:[],confirmationKey});sessionStorage.removeItem(draftKey);textarea.value='';review.replaceChildren();noteStatus.textContent='Anotação salva; distribuição indisponível agora — tentar de novo';}
    },'small');
    const help=button(note,'💡 Pedir ajuda à IA',async()=>{
      const question=textarea.value.trim();if(!question){noteStatus.textContent='Escreva a pergunta para a IA na anotação';textarea.focus();return;}help.disabled=true;noteStatus.textContent='Pensando no contexto deste lead…';
      try{const result=await request('/api/panel/lead-help',{method:'POST',body:JSON.stringify({ref,journeyId,question})});const answer=result.answer||{};const box=append(note,'div','ai-summary');append(box,'h3','','💡 Opinião da IA');append(box,'p','',`O que está acontecendo: ${answer.situacao}`);append(box,'p','',`O que eu faria: ${answer.sugestao}`);if(answer.mensagem_en){const msgLabel=append(box,'label','suggestion-edit','Mensagem sugerida (editável)');const msg=append(msgLabel,'textarea','suggestion-text lead-help-message');msg.rows=4;msg.maxLength=4000;msg.value=answer.mensagem_en;append(box,'p','muted',`Tradução: ${answer.traducao_pt}`);
        // Same send path as the suggestions: the window decides (panel with confirmation, or the phone).
        if(result.send&&window.MCSSuggest&&MCSSuggest.sendControls)MCSSuggest.sendControls(box,{...result.send,journeyId:result.send.journeyId||journeyId},msg,{request,discard:false,onSent:(sent)=>{if(!(sent&&sent.simulated))setTimeout(()=>reload(),1500);}});
        else button(box,'Copiar mensagem',()=>navigator.clipboard.writeText(msg.value),'small');}
      button(box,'Perguntar de novo',()=>{box.remove();textarea.focus();},'quiet small');noteStatus.textContent='';}catch(error){noteStatus.textContent=error.code==='AI_DAILY_LIMIT'?'Não consegui responder agora, tente mais tarde':'Não consegui responder agora, tente mais tarde';}finally{help.disabled=false;}
    },'small');
    const helpHistory=data.aiHelp||[];if(helpHistory.length){append(note,'h3','','Histórico de ajuda deste lead');helpHistory.forEach((entry)=>append(note,'p','muted',`${date(entry.created_at,data.timezone)} — Você: ${safeString(entry.question).slice(0,150)} · IA: ${safeString(entry.answer_json?.sugestao).slice(0,180)}`));}

    const quick=section(root,3,'RESULTADO RÁPIDO');const quickActions=append(quick,'div','lead-actions');
    function undo(event){if(activeUndo)activeUndo.remove();const toast=append(document.body,'div','undo-toast');activeUndo=toast;append(toast,'span','','Resultado registrado');
      button(toast,'Desfazer',async()=>{await api('undo',{eventId:event.eventId});toast.remove();await reload();});setTimeout(()=>{toast.remove();if(activeUndo===toast)activeUndo=null;},10000);}
    async function quickResult(type,dueLocal){
      const key='mcs_quick_'+ref+'_'+type+'_'+(dueLocal||'');
      let operationId=sessionStorage.getItem(key);
      if(!operationId){operationId=crypto.randomUUID();sessionStorage.setItem(key,operationId);}
      const event=await api('quick',{type,dueLocal,operationId});sessionStorage.removeItem(key);
      if(event.duplicate){const toast=append(document.body,'div','undo-toast');append(toast,'span','','Resultado já registrado');setTimeout(()=>toast.remove(),6000);await reload();return;}undo(event);
      await reload();
    }
    [['Atendeu','ANSWERED'],['Não atendeu','NO_ANSWER'],['Conversa presencial','IN_PERSON'],['Vai pagar o depósito','DEPOSIT']].forEach(([label,type])=>button(quickActions,label,()=>quickResult(type)));
    const later=button(quickActions,'Pediu para ligar depois',()=>{laterForm.hidden=false;});
    const laterForm=append(quick,'div','lead-actions');laterForm.hidden=true;const laterDate=append(laterForm,'input');laterDate.type='datetime-local';append(laterForm,'small','muted','horário do cliente');
    button(laterForm,'Registrar retorno',async()=>{if(!laterDate.value)throw needs('Escolha o dia e a hora do retorno');await quickResult('LATER',laterDate.value);},'small');

    const tracking=section(root,11,'PÁGINA DO CLIENTE','lead-highlight');
    const resultChoice=append(tracking,'div','lead-actions');resultChoice.hidden=true;
    if(track){const steps=append(tracking,'div','lead-steps');stageNames.forEach((label,index)=>button(steps,label,async()=>{
      if(index===3){resultChoice.hidden=false;return;}await api('tracking_step',{step:index+1});await reload();},'lead-step '+(index+1<=track.step?'on':'')));
      button(resultChoice,'Won',async()=>{await api('tracking_step',{step:4,result:'WON'});await reload();});
      button(resultChoice,'Not won',async()=>{await api('tracking_step',{step:4,result:'NOT_WON'});await reload();});
      button(tracking,'Copiar link de acompanhamento',()=>navigator.clipboard.writeText(location.origin+'/t/'+track.public_code));
    }else append(tracking,'p','muted','Ligue ao pedido para criar a página do cliente');
    const customerResponses=(data.events||[]).filter((entry)=>['WANT_CAR','NOT_FOR_ME'].includes(entry.event_type));
    append(tracking,'p','muted',customerResponses.length?customerResponses.map((entry)=>`${entry.detail_json.vehicle}: ${entry.event_type==='WANT_CAR'?'I want this':'Not for me'}`).join(' · '):'O cliente ainda não respondeu aos carros');

    const finalGrid=append(root,'div','lead-grid lead-two');
    const conversation=section(finalGrid,2,'CONVERSA','lead-highlight');conversation.id='lead-conversation';
    const aiReview=append(conversation,'div','lead-card lead-highlight ai-conversation-review');append(aiReview,'span','lead-label','A IA LEU A CONVERSA');
    append(aiReview,'p','muted','Roda sozinha depois de 3 mensagens da MCS, 10 min após a última mensagem do cliente e somente quando houver mensagem nova · Nada é gravado sem confirmação');
    const aiStatus=append(aiReview,'p','status','');
    const readNow=append(aiReview,'button','quiet small','Ler conversa agora');readNow.type='button';MCSAction.bind(readNow,()=>({scope:aiReview,optimistic:()=>{aiStatus.textContent='Lendo conversa…';},commit:()=>request('/api/panel/ai-conversations',{method:'POST',body:JSON.stringify({action:'read',journeyId:record.id,chatId:aiReading?.chat_id||null})}),onSuccess:()=>reload(),onError:(error)=>{aiStatus.textContent=error.code==='AI_DAILY_LIMIT'?'limite do dia atingido':'IA indisponível';},errorText:'Não consegui salvar, tente de novo'}));
    if(aiReading){
      if(!hasCalculatorRef)append(aiReview,'p','muted','Ficha sem Ref da calculadora · o que você confirmar vai direto para esta ficha');
      if(aiReading.items?.length)append(aiReview,'div','ai-route-title','Vai para:');
      const selected=[];
      (aiReading.items||[]).forEach((item)=>{const line=append(aiReview,'label','lead-route');const input=append(line,'input');input.type='checkbox';input.checked=!item.manual_review&&item.type!=='budget';selected.push({input,id:item.id});
        append(line,'strong','',item.type==='checklist'?`Checklist ${item.point} → OK`:({call_result:'Resultado da ligação',budget:'Teto total',payment:'Pagamento',deadline:'Prazo',wishlist:'Lista de desejo',phone:'Telefones',promise:'Promessa',return:'Retorno',stage:'Etapa operacional',disable:'Desligar lead'}[item.type]||item.type));
        const detail=append(line,'div','lead-route-value');append(detail,'span','',itemLabel(item,data.timezone));if(item.manual_review||item.type==='budget')append(detail,'span','lead-badge yellow','confirmar manualmente');append(detail,'small','muted',`Cliente: “${item.evidence}”`);
      });
      const aiActions=append(aiReview,'div','lead-actions');
      const confirm=append(aiActions,'button','small','Confirmar');confirm.type='button';confirm.disabled=!aiReading.items?.length;MCSAction.bind(confirm,()=>{const itemIds=selected.filter((entry)=>entry.input.checked).map((entry)=>entry.id);if(!itemIds.length){aiStatus.textContent='Marque pelo menos um item';return{scope:aiActions,commit:()=>Promise.reject(new Error('NO_ITEMS')),errorText:'Marque pelo menos um item'};}return{scope:aiActions,optimistic:()=>{aiStatus.textContent='Gravando…';},commit:()=>request('/api/panel/ai-conversations',{method:'POST',body:JSON.stringify({action:'confirm',journeyId:record.id,readingId:aiReading.id,itemIds,confirmationKey:crypto.randomUUID()})}),onSuccess:()=>reload(),onError:(error)=>{aiStatus.textContent=error.code==='JOURNEY_FROZEN'?'Ficha encerrada: só aceita telefone ou sugestão':'Não foi possível confirmar';},errorText:'Não consegui salvar, tente de novo'};});
      const discard=append(aiActions,'button','quiet small','Descartar');discard.type='button';discard.disabled=!aiReading.items?.length;MCSAction.bind(discard,()=>({scope:aiActions,commit:()=>request('/api/panel/ai-conversations',{method:'POST',body:JSON.stringify({action:'discard',journeyId:record.id,readingId:aiReading.id})}),onSuccess:()=>reload(),onError:()=>{aiStatus.textContent='Não foi possível descartar';},errorText:'Não consegui salvar, tente de novo'}));
      aiActions.append(readNow);
    }
    // Suggested reply inside this conversation: never sent from the panel.
    // A message sent by the panel shows up in the thread: the ficha reloads a moment after the
    // confirmation is read (a simulated send outside production adds nothing, so nothing reloads).
    const afterSend=(result)=>{if(result&&result.simulated)return;setTimeout(()=>reload(),1500);};
    if(journeyId&&window.MCSSuggest)conversation.append(MCSSuggest.box(journeyId,{request,onSent:afterSend}));
    // Guided reply: the operator says what to convey, the AI writes it in the client's language (never sent).
    if(journeyId&&window.MCSSuggest&&MCSSuggest.guided)conversation.append(MCSSuggest.guided(journeyId,{request,onSent:afterSend}));
    const uploadAttachment=async(files,status)=>{const ensured=journeyId?{journeyId,contactId:record.contact_id}:await api('ensure');for(const file of files){status.textContent='Enviando e lendo…';const head=new Uint8Array(await file.slice(0,64).arrayBuffer()),signed=await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'sign',filename:file.name,mimeType:file.type,byteSize:file.size,magicBase64:btoa(String.fromCharCode(...head)),journeyId:ensured.journeyId,contactId:ensured.contactId})}),uploadUrl=new URL(signed.uploadUrl);uploadUrl.searchParams.set('token',signed.token);const uploaded=await fetch(uploadUrl.toString(),{method:'PUT',headers:{'content-type':file.type,'x-upsert':'false'},body:file});if(!uploaded.ok)throw Error('UPLOAD_FAILED');const read=await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'read',readId:signed.readId})});if(read.manual){status.textContent=(read.read?.error_code==='SMS_PRINT_DAILY_LIMIT'?'Limite de leituras de print do dia atingido':'Não consegui ler agora, tente mais tarde')+' · O print ficou guardado';continue;}const values=read.read.extracted_json||{},saved=await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'confirm',auto:true,readId:signed.readId,phone:values.phone||'',name:values.name||'',ref:values.ref||'',message:values.message||'',translation:values.translation||''})});status.textContent=saved.duplicate?'Este print já foi guardado.':`✓ Guardado no lead de ${saved.name||'Pedido'} · Ref ${saved.ref||values.ref||'—'}`;button(status.parentElement,'Desfazer',async()=>{await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'undo',readId:signed.readId})});await reload();},'quiet small');}await reload();};
    const attachmentButton=(parent)=>{const card=append(parent,'div','attachment-choice');append(card,'strong','','📷 Anexar print');append(card,'p','muted','Print de SMS, de WhatsApp ou foto · O painel lê a Ref e o número e coloca no cliente certo sozinho');const picker=append(card,'label','small','📷 Escolher prints'),input=append(picker,'input');input.type='file';input.accept='image/*';input.multiple=true;input.hidden=true;const info=append(card,'span','muted','');const actions=append(card,'div','inline-actions');const remove=button(actions,'✕ Remover',()=>{input.value='';info.textContent='';send.disabled=true;remove.hidden=true;},'quiet small');remove.hidden=true;const send=button(actions,'Guardar print',async()=>{await uploadAttachment([...input.files],status);},'small');send.disabled=true;const status=append(card,'span','status','');input.addEventListener('change',()=>{const files=[...input.files];info.textContent=files.map((file)=>`${file.name} · ${(file.size/1024/1024).toFixed(1)} MB`).join(' · ');send.disabled=!files.length;remove.hidden=!files.length;});};
    const controls=append(conversation,'div','lead-actions');
    const attachLink=button(controls,'📷 Anexar print',()=>document.getElementById('lead-history')?.scrollIntoView({behavior:'smooth'}));attachLink.title='Os prints são anexados em DADOS E HISTÓRICO';
    const sort=append(controls,'select');[['recent','Mais recentes'],['oldest','Mais antigas']].forEach(([value,label])=>sort.append(new Option(label,value)));
    sort.value=localStorage.getItem('mcs_conversation_sort')||'recent';
    const filter=append(controls,'select');[['all','Tudo'],['CUSTOMER','Cliente'],['MCS','MCS']].forEach(([value,label])=>filter.append(new Option(label,value)));
    if(journeyId){[...new Set((record.conversation||[]).map((message)=>message.chat_id).filter(Boolean))].forEach((chatId)=>{const invert=button(controls,'Inverter remetentes desta conversa',async()=>{if(invert.dataset.confirmed!=='true'){invert.dataset.confirmed='true';invert.textContent='Confirmar inversão';return;}await api('manual',{panelAction:'invert_senders',payload:{chatId}});await reload();});});}
    const thread=append(conversation,'div','lead-thread');const messages=record.conversation||[];
    // Translation on demand (cached by message): shown under the original, which never changes.
    let visibleIds=[],translateButton=null,translateStatus=null;
    const tr=journeyId&&window.MCSSuggest&&MCSSuggest.translator?MCSSuggest.translator(journeyId,{request,onChange:()=>draw()}):null;
    // Counts what the button translates: the pending messages shown with the current filter.
    const paintTranslate=()=>{if(!translateButton)return;const pending=tr.pending().filter((id)=>visibleIds.includes(id)).length;translateButton.disabled=tr.busy()||!pending;translateButton.textContent=tr.busy()?'Traduzindo…':pending?`Traduzir conversa (${pending})`:(tr.hasAny()?'Conversa traduzida':'Traduzir conversa');};
    if(tr){translateButton=button(controls,'Traduzir conversa',async()=>{if(tr.busy())return;translateStatus.textContent='';try{const out=await tr.translate(visibleIds);if(out&&out.simulated)translateStatus.textContent='Tradução simulada neste ambiente · sem IA e sem custo';}catch(error){translateStatus.textContent=error&&error.code==='OPENAI_BUDGET_LIMIT'?'Sem saldo pré-pago na OpenAI · Nada foi cobrado':'Não consegui traduzir agora · tente de novo';}finally{setTimeout(paintTranslate,0);}},'small');translateButton.classList.add('translate-conversation');translateStatus=append(controls,'span','status','');paintTranslate();}
    const draw=()=>{thread.replaceChildren();let list=messages.filter((message)=>filter.value==='all'||message.direction===filter.value);if(sort.value==='recent')list=list.slice().reverse();visibleIds=list.map((message)=>message.id);
      list.forEach((message)=>{const bubble=append(thread,'article','lead-message '+(message.direction==='MCS'?'m':'c'));
        append(bubble,'small','muted',`${message.channel} · ${message.direction==='CUSTOMER'?'Cliente':'MCS'} · ${date(message.occurred_at_utc||message.created_at,data.timezone)}${message.is_automatic?' · 🤖 automática':''}`);
        append(bubble,'p','',message.body_text);
        if(tr){const done=tr.get(message.id);if(done){const box=append(bubble,'div','message-translation');append(box,'small','muted','Tradução para português');append(box,'p','',done.textPt);}else if(tr.canTranslate(message.id)&&tr.hasAny()){const one=button(bubble,'traduzir',async()=>{if(tr.busy())return;translateStatus.textContent='';try{await tr.translate([message.id]);}catch(error){translateStatus.textContent=error&&error.code==='OPENAI_BUDGET_LIMIT'?'Sem saldo pré-pago na OpenAI · Nada foi cobrado':'Não consegui traduzir esta mensagem · tente de novo';}},'quiet small');one.classList.add('translate-one');}}
        if(message.direction==='MCS'&&message.media_kind)append(bubble,'span','muted',({image:'Foto enviada',audio:'Áudio enviado',video:'Vídeo enviado',document:'Documento enviado',sticker:'Sticker enviado'}[message.media_kind]||'Mídia enviada'));else if(message.media_status==='STORED'&&mediaObjectUrl){const media=append(bubble,'div','whatsapp-media'),load=append(media,'button','quiet small',message.media_kind==='document'?'Baixar':'Carregar mídia');load.type='button';load.addEventListener('click',async()=>{load.disabled=true;try{const url=await mediaObjectUrl(message.id);load.remove();if(message.media_kind==='image'){const image=append(media,'img','whatsapp-media-image');image.alt='Foto da conversa';image.src=url;image.addEventListener('click',()=>window.open(url,'_blank','noopener'));}else if(message.media_kind==='audio'){const player=append(media,'audio');player.controls=true;player.src=url;}else if(message.media_kind==='video'){const player=append(media,'video');player.controls=true;player.src=url;}else{const link=append(media,'a','', 'Baixar');link.href=url;link.download='';link.target='_blank';link.rel='noopener';}}catch(_){load.disabled=false;load.textContent='Mídia não disponível';}});}else if(message.media_status==='FAILED')append(bubble,'span','muted','Mídia não disponível');
        if(message.direction==='MCS'){const automatic=button(bubble,message.is_automatic?'não é automática':'marcar como automática',async()=>{automatic.disabled=true;try{await request('/api/panel/messages',{method:'POST',body:JSON.stringify({messageId:message.id,automatic:!message.is_automatic})});await reload();}finally{automatic.disabled=false;}});automatic.classList.add('quiet','small');}
        if(journeyId&&actionMessage)bubble.append(actionMessage(message,journeyId,reload,ref,data.timezone));});
      if(!list.length)append(thread,'p','muted','Nenhuma mensagem neste filtro');if(tr)paintTranslate();};
    sort.addEventListener('change',()=>{localStorage.setItem('mcs_conversation_sort',sort.value);draw();});filter.addEventListener('change',draw);draw();
    if(tr)tr.load();
    // A20: reply from the panel (review in Portuguese, translation, 24 h window checked by the server).
    if(journeyId&&replyComposer)replyComposer(conversation,journeyId,reload);

    const history=section(finalGrid,12,'DADOS E HISTÓRICO','lead-highlight');history.id='lead-history';
    attachmentButton(history);
    append(history,'h3','','Anexos');const attachments=append(history,'div','lead-attachments');
    (record.attachments||[]).forEach((item)=>{const card=append(attachments,'button','lead-attachment');card.type='button';if(item.kind==='IMAGE'){const thumb=append(card,'img','lead-attachment-thumb');thumb.alt='';request('/api/panel/attachments',{method:'POST',body:JSON.stringify({action:'download',attachmentId:item.id})}).then((signed)=>{thumb.src=signed.url;}).catch(()=>{thumb.replaceWith(Object.assign(document.createElement('span'),{className:'lead-attachment-thumb',textContent:'🖼️'}));});}else append(card,'span','lead-attachment-thumb','📄');append(card,'span','',`${item.original_filename} · ${date(item.created_at,data.timezone)}`);card.addEventListener('click',async()=>{card.disabled=true;try{const signed=await request('/api/panel/attachments',{method:'POST',body:JSON.stringify({action:'download',attachmentId:item.id})});window.open(signed.url,'_blank','noopener');}finally{card.disabled=false;}});});
    if(!record.attachments?.length)append(attachments,'p','muted','Nenhum anexo');
    append(history,'h3','',`Checklist ${data.checklist.filter((point)=>point.status==='COMPLETE').length}/6`);
    // M32: the point is a label; marking and unmarking are separate, explicit buttons
    data.checklist.forEach((point)=>{const line=append(history,'div','lead-check');const done=point.status==='COMPLETE';append(line,'span','',`${point.point_number}. ${point.point_label} · ${done?'OK':'Pendente'}`);button(line,done?'Desmarcar':'Marcar OK',async()=>{await api('checklist',{point:point.point_number,complete:!done});await reload();},done?'quiet small':'small');});
    const extraPhones=(data.events||[]).filter((item)=>item.event_type==='EXTRA_PHONE');
    if(extraPhones.length){append(history,'h3','','Telefones extras');extraPhones.forEach((item)=>row(history,item.detail_json?.owner||'Contato',item.detail_json?.number));}
    append(history,'h3','','Retornos e promessas em aberto');
    (record.returns||[]).filter((item)=>item.status==='OPEN').forEach((item)=>{const line=row(history,item.text,date(item.dueAt,data.timezone));button(line,'Concluir',async()=>{await api('manual',{panelAction:'return_update',payload:{returnKind:item.kind,returnId:item.kind==='PROMISE'?item.id:null,operation:'COMPLETE'}});await reload();});});
    if(!record.next_action_at){const form=append(history,'div','lead-actions');const task=append(form,'input');task.placeholder='Retorno manual';const due=append(form,'input');due.type='datetime-local';
      append(form,'small','muted','horário do cliente');button(form,'Adicionar retorno',async()=>{await api('manual',{panelAction:'next_action',payload:{operation:'CREATE',text:task.value,atLocal:due.value}});await reload();});}
    const unitsTitle=append(history,'h3','','Unidades apresentadas');unitsTitle.id='lead-units';
    (record.units||[]).forEach((unit)=>{const line=append(history,'div','lead-unit');append(line,'strong','',unit.vehicle_text);append(line,'p','muted',`${date(unit.presented_at,data.timezone)} · ${{PRESENTED:'Apresentada',UNDER_REVIEW:'Em análise',ACCEPTED:'Aceita',DECLINED:'Recusada'}[unit.status]||unit.status}`);
      const fields=append(line,'div','lead-actions');const value=append(fields,'input');value.type='number';value.placeholder='Retail comparison (US$)';value.value=unit.details_json?.retailValue||'';
      const link=append(fields,'input');link.type='url';link.placeholder='Link da página de comparativos MCS';link.value=unit.details_json?.retailUrl||'';
      button(fields,'Salvar comparativo',async()=>{await api('retail',{unitId:unit.id,value:value.value,url:link.value});await reload();});});
    if(!record.units?.length)append(history,'p','muted','Nenhuma unidade apresentada');
    append(history,'h3','','Etapa operacional');const stage=append(history,'select');
    [['NOVO','Novo'],['RESPONDIDO','Respondido'],['EM_BUSCA','Em busca'],['DECIDINDO','Decidindo'],['QUALIFICADO','Qualificado']].forEach(([v,label])=>stage.append(new Option(label,v)));
    stage.value=record.stage||'NOVO';button(history,'Salvar etapa',async()=>{await api('manual',{panelAction:'set_funnel',payload:{value:stage.value}});await reload();});
    append(history,'h3','','Simulações da Ref');
    (order.simulations||[]).forEach((simulation)=>row(history,simulation.logicalMode==='VALOR'?'Por valor':'Carro ideal',simulation.vehicleText||'Veículo não informado',cents(simulation.budgetCents)));
    const closedPromises=allPromises.filter((promise)=>promise.status!=='OPEN');if(closedPromises.length)append(history,'h3','','Promessas concluídas ou canceladas');closedPromises.forEach((promise)=>{const line=row(history,promise.promise_text,date(promise.due_at,data.timezone),({OPEN:'Aberta',FULFILLED:'Concluída',CANCELLED:'Cancelada'})[promise.status]||promise.status);if(promise.status==='OPEN')button(line,'Concluir',async()=>{await api('promise_complete',{promiseId:promise.id,kind:promise.message_id?'OLD':'NEW'});await reload();});});
    append(history,'h3','','Linha do tempo');const timeline=append(history,'ul','lead-timeline');timelineRows(data).forEach((item)=>append(timeline,'li','',`${date(item.at,data.timezone)} — ${item.text}`));
    const power=append(history,'div','lead-actions');
    // A7: a closed ficha is reopened explicitly; one merged into another conversation stays closed.
    if(record.status==='ENCERRADO'&&record.closed_reason==='WHATSAPP_LINKED')append(power,'p','muted','Ficha juntada a outra conversa');
    else if(record.enabled===false)button(power,record.status==='ENCERRADO'?'Reabrir ficha':'Ligar lead',async()=>{await api('manual',{panelAction:'toggle_journey',payload:{enabled:true}});undoNotice('Ficha religada',()=>api('manual',{panelAction:'toggle_journey',payload:{enabled:false,reason:record.offReason||null}}));await reload();});
    else {const reason=append(power,'select');[['','Desligar com motivo'],['MCS_PURCHASE','Comprou com a MCS'],['OTHER_PURCHASE','Comprou em outro lugar'],['GAVE_UP','Desistiu'],['NO_RESPONSE','Sem resposta']].forEach(([v,label])=>reason.append(new Option(label,v)));
      const off=button(power,'Desligar',async()=>{await api('manual',{panelAction:'toggle_journey',payload:{enabled:false,reason:reason.value}});undoNotice('Ficha desligada',()=>api('manual',{panelAction:'toggle_journey',payload:{enabled:true}}));await reload();});
      off.disabled=true;off.title='Escolha o motivo';reason.addEventListener('change',()=>{off.disabled=!reason.value;});}
    // Order on screen: header → case summary → conversation → quick result → the rest.
    topAnchor.replaceWith(conversation,quick);finalGrid.classList.add('lead-one');
    if(downloadShortlist){const matching=(data.offers||[]).map((car)=>({vehicle_json:{parsed:car}}));if(matching.length){button(history,'Baixar PDF',()=>downloadShortlist(matching,ref));append(history,'span','muted','PDF com todos os compatíveis do lote · o PDF só dos selecionados para o cliente fica em ENVIAR OPÇÕES');}}
  }
  window.MCSLead={open};
})();
