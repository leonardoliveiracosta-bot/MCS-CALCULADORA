(() => {
  'use strict';
  const e = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined && text !== null) node.textContent = String(text); return node; };
  const liveViews = new WeakMap();
  async function refresh({root,kind,key}) {
    const view = liveViews.get(root);
    if (view && view.kind === kind && view.key === key) return view.refresh();
  }
  const append = (parent, tag, cls, text) => { const node = e(tag,cls,text); parent.append(node); return node; };
  const fmt = (value) => Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(Number(value)) : '—';
  const cents = (value) => value ? fmt(Number(value)/100) : '—';
  const date = (value,tz='America/New_York') => value ? new Intl.DateTimeFormat('pt-BR',{timeZone:tz,dateStyle:'short',timeStyle:'short'}).format(new Date(value)) : '—';
  const badge = (text,cls) => e('span','lead-badge '+(cls||''),text);
  const button = (parent,label,commit,cls='quiet small') => { const node=append(parent,'button',cls,label); node.type='button'; MCSAction.bind(node,()=>({scope:parent,commit,errorText:(error)=>error?.userMessage||'Não consegui salvar, tente de novo'})); return node; };
  // M31: a button that cannot act yet says why instead of doing nothing
  const needs = (message) => Object.assign(new Error('INPUT_REQUIRED'), { userMessage: message });
  // Car lists (cards 5 and 8): at most 10 on screen, in the order already set; "Ver mais (N)" shows the rest.
  const section = (root,n,title,cls='') => { const card=append(root,'section','lead-card '+cls); append(card,'span','lead-label',`${n} — ${title}`); return card; };
  const row = (root,...values) => { const line=append(root,'div','lead-line'); values.forEach((value)=> append(line,'span','',value || '—')); return line; };
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
  async function open(options) {
    const {kind,key,root,request,onChanged,actionMessage,dispositionControls,mediaObjectUrl,replyComposer,openOptions,renderFichaOffersSummary,optionLinkButtons,openTab,isCurrent} = options;
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
    const reload=async()=>{if(typeof isCurrent==='function'&&!isCurrent())return;await onChanged({scrollY:window.scrollY});};
    // "Desfazer" right after a reversible action: a notice pinned to the page (it survives the ficha
    // being redrawn) with one button that puts the previous state back. It outlives this render, so it reloads through
    // onChanged, which redraws only while this same ficha is the one open (never after a tab switch or another ficha).
    const undoNotice=(text,undoFn)=>{const notice=window.MCSAction&&MCSAction.feedback(document.body,text,'','lead-undo');if(!notice)return;const back=e('button','quiet small','Desfazer');back.type='button';notice.append(' ',back);
      back.addEventListener('click',async()=>{back.disabled=true;try{await undoFn();notice.replaceChildren(document.createTextNode('Desfeito'));await onChanged({scrollY:window.scrollY});}catch(failure){back.disabled=false;notice.append(' · '+(failure&&failure.code==='UNDO_EXPIRED'?'Passou o tempo para desfazer':'Não consegui desfazer'));}});};
    const actionsApi=(action,fields)=>request('/api/panel/actions',{method:'POST',body:JSON.stringify({action,journeyId,...fields})});
    const failed=(card,text)=>append(card,'p','status error',text);
    const title=record.contact?.display_name||order.contactName||'Contato sem nome';
    const phones=(record.phones||[]).filter((item)=>item.is_current!==false).sort((a,b)=>Number(Boolean(b.is_primary))-Number(Boolean(a.is_primary)));
    const heading=section(root,1,'CABEÇALHO DA LIGAÇÃO');
    const header=append(heading,'div','lead-header');
    append(header,'div','lead-score',data.score===null?'—':data.score);
    const identity=append(header,'div','lead-head-name'); append(identity,'h2','',`${title} — ${calcRef?'Ref '+calcRef:'sem Ref da calculadora'}`);if(calcRef&&(record.calcRefsWithoutRun||[]).includes(calcRef))append(identity,'span','muted lead-ref-note',`Ref ${calcRef} comprovada pela mensagem da calculadora · simulação não registrada`);if(record.internalCode)append(identity,'span','muted lead-ref-note',`Código da ficha ${record.internalCode} · interno, não é Ref da calculadora`);const calcName=(data.calculatorNews||[]).find((item)=>item.field==='NOME');if(calcName&&calcName.calculator)append(identity,'span','muted lead-ref-note lead-calc-name',`Nome na calculadora: ${calcName.calculator}`);const directOrigin=directLeadLabel(data.directLeadSource);if(directOrigin)append(identity,'span','lead-badge blue',directOrigin);
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
    // One line under the name: the badges on the left, "Não é lead" and "Excluir" on the right (no empty rows).
    const headMeta=append(heading,'div','lead-head-meta');const badges=append(headMeta,'div','lead-badges');const headActions=append(headMeta,'div','lead-head-actions');
    // M11: an unknown deadline or payment is shown as unknown, not as "sem prazo" or "à vista".
    badges.append(data.deadlineKnown?badge(deadlineLabel[data.deadlineKnown]||data.deadlineKnown,'green'):badge('Prazo não informado','yellow'),data.paymentKnown?badge(paymentLabel[data.paymentKnown],'green'):badge('Pagamento não informado','yellow'));
    if(data.searchStage)badges.append(badge(data.searchStage.label||({MISSING:'🔍 Busca não salva no Manheim',SAVED:'💾 Busca salva no Manheim',SENT:'📤 Opções enviadas'}[data.searchStage.stage]||''),data.searchStage.stage==='SENT'?'green':data.searchStage.stage==='SAVED'?'':'yellow'));
    if(data.lastCustomerAt) badges.append(badge(`última mensagem do cliente há ${elapsed(data.lastCustomerAt)}`));
    badges.append(badge(record.enabled===false?'DESLIGADO':'LIGADO',record.enabled===false?'red':'green'));
    if(data.disposition)badges.append(badge(data.disposition==='TREATED'?'Tratado':'Descartado',data.disposition==='DISCARDED'?'red':''));
    // The link of the client's page (/t/…): the only place the panel gives it, a small button next to Excluir.
    if(track&&track.public_code){const copyLink=append(headActions,'button','quiet small lead-copy-link','Copiar link do cliente');copyLink.type='button';copyLink.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(location.origin+'/t/'+track.public_code);copyLink.textContent='Link copiado';}catch(_){copyLink.textContent='Não consegui copiar';}setTimeout(()=>{if(copyLink.isConnected)copyLink.textContent='Copiar link do cliente';},2500);});}
    // "Copiar link de todas as opções" (the same button as in Opções do cliente), once the batch view answers.
    if(optionLinkButtons){const optionLinks=append(headActions,'span','lead-options-links');optionLinkButtons(optionLinks,{journeyId:journeyId||null,ref:ref||null}).catch(()=>{});}
    if(dispositionControls) headActions.append(dispositionControls(order.ref?{kind:'CALCULATOR',ref,disposition:data.disposition}:{kind:'JOURNEY',id:record.id,disposition:data.disposition}));
    // Two clicks on the page itself (a browser dialog can be answered "no" without showing up).
    const restoring=record.contact?.is_lead===false;const leadToggle=button(headActions,restoring?'Restaurar como lead':'Não é lead',async()=>{if(leadToggle.dataset.confirmed!=='true'){leadToggle.dataset.confirmed='true';leadToggle.textContent=restoring?'Confirmar: restaurar como lead':'Confirmar: não é lead (as mensagens ficam guardadas)';return;}await api('contact_lead',{isLead:restoring});undoNotice(restoring?'Restaurado como lead':'Marcado como não é lead',()=>api('contact_lead',{isLead:!restoring}));await onChanged();});
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
    // The conversation comes right after the summary (built below, moved here).
    const topAnchor=append(root,'div','lead-top-anchor');
    // Blocos 4 (O que ele quer), 7 (Perguntar na ligação) e 9 (Contexto rápido) saíram: o carro está no TODOS e em Opções,
    // a IA marca os pontos da ligação sozinha e a última mensagem está na Conversa.
    const numbers=section(root,6,'NÚMEROS PRONTOS');
    if(data.costs){const c=data.costs;row(numbers,'Depósito',data.paymentKnown==='fin'?'Avaliado caso a caso (financiado)':fmt(c.deposito));row(numbers,'Taxa de serviço',fmt(c.servico));row(numbers,'Taxa do leilão + fixas',fmt(c.gLeilao));row(numbers,'Tax, title & registration',fmt(c.gTaxReg));row(numbers,'Total estimado',fmt(c.totalProjetado));}
    else append(numbers,'p','muted',data.totalCeilingCents?'O teto não cobre o lance mínimo e os custos':'Lance máximo ainda não informado');

    // 5 · OPÇÕES NO LOTE: only the summary of the official comparison and "Ver opções" (the client's options
    // screen of ENVIAR OPÇÕES, where the cars, the selection, the PDF and the V1 are). The market's typical MMR stays here.
    const lot=section(root,5,'OPÇÕES NO LOTE','offers-summary');
    if(data.reality&&data.reality.typicalCents)append(lot,'p','reality-typical','MMR típico: $'+Math.round(Number(data.reality.typicalCents)/100).toLocaleString('pt-BR'));
    const lotMount=append(lot,'div','offers-summary-mount');
    if(renderFichaOffersSummary)renderFichaOffersSummary(lotMount,{journeyId:journeyId||null,ref:ref||null,kind,key}).catch(()=>{if(lotMount.isConnected)append(lotMount,'p','warning','Não consegui carregar as opções agora');});
    else append(lotMount,'p','muted','Opções do lote em ENVIAR OPÇÕES');
    const shortWhen=(value)=>{try{return new Intl.DateTimeFormat('pt-BR',{timeZone:data.timezone||'America/New_York',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)).replace(' ',' ');}catch(_){return '';}};
    // "Já apresentados" (back in the ficha, inside OPÇÕES NO LOTE): the cars registered as presented and the cars of a
    // V1/V2 whose /v/ link went in the conversation (sent by hand), once per car.
    const unitMatches=new Set((record.units||[]).map((unit)=>unit.details_json&&unit.details_json.manheim_match_id).filter(Boolean));
    const byLink=(record.sentByLink||[]).flatMap((sent)=>sent.cars.filter((car)=>!car.matchId||!unitMatches.has(car.matchId)).map((car)=>({text:car.vehicleText,at:sent.sentAt,key:car.matchId||car.vin||car.vehicleText})));
    const linkSeen=new Set();const linkCars=byLink.filter((car)=>car.text&&!linkSeen.has(car.key)&&linkSeen.add(car.key));
    const shownCars=[...(record.units||[]).map((unit)=>unit.vehicle_text+(unit.presented_at?` (${shortWhen(unit.presented_at)})`:'')),...linkCars.map((car)=>car.text+(car.at?` (link enviado ${shortWhen(car.at)})`:' (link enviado)'))];
    const presented=e('p','context-presented',`Já apresentados: ${shownCars.length?shownCars.join(' · '):'nenhum carro'}`);lot.insertBefore(presented,lotMount);

    const note=section(root,10,'O QUE A IA NÃO VIU','lead-highlight');
    append(note,'p','muted','Alimente aqui com o que não está na conversa: ligação, pessoalmente, qualquer informação que a IA não tem como saber');
    const textarea=append(note,'textarea','lead-note');textarea.placeholder='Anote a conversa aqui…';textarea.maxLength=12000;
    const draftKey='mcs_lead_draft_'+(ref||journeyId);textarea.value=sessionStorage.getItem(draftKey)||'';
    textarea.addEventListener('input',()=>sessionStorage.setItem(draftKey,textarea.value));
    const noteStatus=append(note,'p','status','');const review=append(note,'div','lead-review note-extract');
    // "Extrair novidades da anotação": the AI turns the note into items to confirm (the same items as the conversation
    // reading); nothing is saved, not even the note, until Confirmar.
    const noteActions=append(note,'div','lead-actions note-actions');
    button(noteActions,'Extrair novidades da anotação',async()=>{
      const body=textarea.value.trim();if(!body){noteStatus.textContent='Escreva a anotação antes de extrair';textarea.focus();return;}
      noteStatus.textContent='Lendo a anotação…';review.replaceChildren();const confirmationKey=crypto.randomUUID();
      try{
        const proposal=await request('/api/panel/notes/distribute',{method:'POST',body:JSON.stringify({ref,journeyId,note:body,noSave:true})});
        noteStatus.textContent='';if(!(proposal.items||[]).length){append(review,'p','ai-nothing-new','Nada novo nesta anotação');}else append(review,'div','ai-route-title','Vai para:');
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
        button(actions,'Confirmar',async()=>{await api('note',{note:body,proposal:proposal.items,signature:proposal.signature,selected:selected.flatMap((input,index)=>input.checked?[index]:[]),manualDates,confirmationKey});sessionStorage.removeItem(draftKey);await reload();},'small ai-confirm');
        button(actions,'Descartar',()=>{review.replaceChildren();noteStatus.textContent='';},'quiet small ai-outline');
      }catch(_){review.replaceChildren();noteStatus.textContent='Não consegui ler a anotação agora · nada foi gravado · tente de novo';}
    },'small');
    // "Destravar esta venda": two specialists (people via OpenAI, sales via Claude), one concrete action each, side by side.
    const unlockBox=append(note,'div','unlock-options');
    const unlock=button(noteActions,'Destravar esta venda',async()=>{
      unlock.disabled=true;unlockBox.replaceChildren();append(unlockBox,'p','muted','Os dois especialistas estão pensando…');
      try{const out=await request('/api/panel/unlock-sale',{method:'POST',timeoutMs:65000,body:JSON.stringify({ref,journeyId})});unlockBox.replaceChildren();
        const drawOption=(option,slot)=>{const card=document.createElement('div');card.className='unlock-option'+(option.ok?'':' is-failed');if(slot)slot.replaceWith(card);else unlockBox.append(card);append(card,'span','unlock-role',`${option.role} · ${option.provider}`);
          if(!option.ok){const retry=append(card,'button','small ai-confirm unlock-retry','Tentar de novo');retry.type='button';retry.addEventListener('click',async()=>{retry.disabled=true;retry.textContent='Pensando…';
            try{const again=await request('/api/panel/unlock-sale',{method:'POST',timeoutMs:65000,body:JSON.stringify({ref,journeyId,only:option.provider})});drawOption((again.options||[])[0]||option,card);}catch(_){retry.disabled=false;retry.textContent='Tentar de novo';}});return;}
          append(card,'strong','unlock-title',option.titulo);append(card,'p','unlock-action',option.acao);if(option.porque)append(card,'p','muted unlock-why',option.porque);
          // Portuguese first (to read), English after (what goes to the customer).
          if(option.mensagemPt){append(card,'span','muted unlock-lang','Português');const pt=append(card,'textarea','unlock-message-pt');pt.rows=4;pt.value=option.mensagemPt;pt.readOnly=true;}
          append(card,'span','muted unlock-lang','Inglês · vai para o cliente');const msg=append(card,'textarea','unlock-message');msg.rows=4;msg.value=option.mensagemEn||option.mensagem||'';
          const original=msg.value.trim();
          const measure=(event,text=msg.value.trim())=>{if(!option.suggestionId||text.length>4000)return;
            const previous=new Uint16Array(text.length+1);for(let j=0;j<=text.length;j++)previous[j]=j;
            for(let i=1;i<=original.length;i++){let diagonal=previous[0];previous[0]=i;for(let j=1;j<=text.length;j++){const above=previous[j];previous[j]=Math.min(previous[j]+1,previous[j-1]+1,diagonal+(original[i-1]===text[j-1]?0:1));diagonal=above;}}
            void request('/api/panel/unlock-sale',{method:'POST',keepalive:true,timeoutMs:5000,body:JSON.stringify({action:'feedback',suggestionId:option.suggestionId,event,text,editDistance:previous[text.length]})}).catch(()=>{});};
          const sendRow=append(card,'div','inline-actions unlock-send');const sendStatus=append(card,'span','status unlock-send-status','');
          const pick=append(sendRow,'button','small ai-confirm unlock-pick','Escolher esta');pick.type='button';pick.addEventListener('click',()=>{unlockBox.querySelectorAll('.unlock-option').forEach((node)=>node.classList.toggle('is-chosen',node===card));measure('PICKED');navigator.clipboard?.writeText(msg.value).catch(()=>{});});
          const digits=String(phones[0]?.phone_e164||phones[0]?.phone_raw||'').replace(/[^\d+]/g,'');
          // WhatsApp: sent by the panel (360dialog, inside the 24 h window, recorded in the conversation); outside the window, WhatsApp opens with the text ready.
          const wa=append(sendRow,'button','small unlock-wa','Enviar por WhatsApp');wa.type='button';let armed=false;
          wa.addEventListener('click',async()=>{const text=msg.value.trim();if(!text){sendStatus.textContent='Mensagem vazia';return;}
            if(!armed){armed=true;wa.textContent='Confirmar envio por WhatsApp';sendStatus.textContent=`Vai para ${title}${digits?' · '+formatPhone(digits):''}`;setTimeout(()=>{if(armed&&!wa.disabled){armed=false;wa.textContent='Enviar por WhatsApp';sendStatus.textContent='';}},8000);return;}
            armed=false;wa.disabled=true;wa.textContent='Enviando…';
            try{const result=await request('/api/panel/reply',{method:'POST',timeoutMs:30000,body:JSON.stringify({action:'send',journeyId,textEn:text})});wa.textContent='Enviado';if(!result?.simulated)measure('SENT',text);sendStatus.textContent='Enviado pelo WhatsApp'+(result&&result.simulated?' · simulado neste ambiente':' · já está na conversa');}
            catch(failure){const code=failure&&failure.code;wa.disabled=false;wa.textContent='Enviar por WhatsApp';
              if((code==='WINDOW_CLOSED'||code==='REPLY_NOT_ELIGIBLE')&&digits){const href='https://wa.me/'+digits.replace(/^\+/,'')+'?text='+encodeURIComponent(text);const opened=window.MCSWaLink?window.MCSWaLink.open(href):window.open(href,'_blank','noopener');if(opened)measure('OPENED_WHATSAPP');sendStatus.textContent=code==='WINDOW_CLOSED'?'Janela de 24 h fechada · WhatsApp com a mensagem pronta':'WhatsApp com a mensagem pronta';if(!opened){const link=append(sendStatus,'a','',' · Abrir no WhatsApp');link.href=href;link.target='_blank';link.rel='noopener';link.addEventListener('click',()=>measure('OPENED_WHATSAPP'));}}
              else sendStatus.textContent=code==='SENT_NOT_RECORDED'?'Enviado, mas não registrado na conversa':'Não enviado · tente de novo'+(code?` (${code})`:'');}});
          // SMS: the phone's messages app with the text ready.
          const sms=append(sendRow,'button','small unlock-sms','Enviar por SMS');sms.type='button';sms.disabled=!digits;
          sms.addEventListener('click',()=>{const text=msg.value.trim();if(!text||!digits)return;measure('OPENED_SMS');location.href='sms:'+digits+'?&body='+encodeURIComponent(text);sendStatus.textContent='Abri o SMS com a mensagem pronta';});};
        (out.options||[]).forEach((option)=>drawOption(option));
      }catch(_){unlockBox.replaceChildren();append(unlockBox,'p','muted','Não consegui gerar as opções agora · tente de novo');}finally{unlock.disabled=false;}
    },'small');
    const help=button(noteActions,'💡 Pedir ajuda à IA',async()=>{
      const question=textarea.value.trim();if(!question){noteStatus.textContent='Escreva a pergunta para a IA na anotação';textarea.focus();return;}help.disabled=true;noteStatus.textContent='Pensando no contexto deste lead…';
      try{const result=await request('/api/panel/lead-help',{method:'POST',body:JSON.stringify({ref,journeyId,question})});const answer=result.answer||{};const box=append(note,'div','ai-summary');append(box,'h3','','💡 Opinião da IA');append(box,'p','',`O que está acontecendo: ${answer.situacao}`);append(box,'p','',`O que eu faria: ${answer.sugestao}`);if(answer.mensagem_en){const msgLabel=append(box,'label','suggestion-edit','Mensagem sugerida (editável)');const msg=append(msgLabel,'textarea','suggestion-text lead-help-message');msg.rows=4;msg.maxLength=4000;msg.value=answer.mensagem_en;append(box,'p','muted',`Tradução: ${answer.traducao_pt}`);
        // Same send path as the suggestions: the window decides (panel with confirmation, or the phone).
        if(result.send&&window.MCSSuggest&&MCSSuggest.sendControls)MCSSuggest.sendControls(box,{...result.send,journeyId:result.send.journeyId||journeyId},msg,{request,discard:false,onSent:(sent)=>{if(!(sent&&sent.simulated))setTimeout(()=>reload(),1500);}});
        else button(box,'Copiar mensagem',()=>navigator.clipboard.writeText(msg.value),'small');}
      button(box,'Perguntar de novo',()=>{box.remove();textarea.focus();},'quiet small');noteStatus.textContent='';}catch(error){noteStatus.textContent=error.code==='AI_DAILY_LIMIT'?'Não consegui responder agora, tente mais tarde':'Não consegui responder agora, tente mais tarde';}finally{help.disabled=false;}
    },'small');
    const helpHistory=data.aiHelp||[];if(helpHistory.length){append(note,'h3','','Histórico de ajuda deste lead');helpHistory.forEach((entry)=>append(note,'p','muted',`${date(entry.created_at,data.timezone)} — Você: ${safeString(entry.question).slice(0,150)} · IA: ${safeString(entry.answer_json?.sugestao).slice(0,180)}`));}

    // Resultado rápido lives inside the header card (one card for the call): the buttons on one line, the return date and the
    // note only open when asked. Anotações writes the note right here (no AI) and the saved notes show below.
    const quick=append(heading,'div','lead-quick');append(quick,'span','lead-quick-label','Resultado');const quickActions=append(quick,'div','lead-actions lead-quick-actions');
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
    const later=button(quickActions,'Pediu para ligar depois',()=>{laterForm.hidden=false;noteForm.hidden=true;laterDate.focus();});
    const noteOpen=button(quickActions,'Anotações',()=>{noteForm.hidden=!noteForm.hidden;laterForm.hidden=true;if(!noteForm.hidden)noteInput.focus();});
    const laterForm=append(quick,'div','lead-actions');laterForm.hidden=true;const laterDate=append(laterForm,'input');laterDate.type='datetime-local';append(laterForm,'small','muted','horário do cliente');
    button(laterForm,'Registrar retorno',async()=>{if(!laterDate.value)throw needs('Escolha o dia e a hora do retorno');await quickResult('LATER',laterDate.value);},'small');
    const noteForm=append(quick,'div','lead-actions lead-quick-note');noteForm.hidden=true;
    const noteInput=append(noteForm,'textarea','lead-quick-note-text');noteInput.rows=2;noteInput.maxLength=12000;noteInput.placeholder='Escreva a anotação…';noteInput.setAttribute('aria-label','Anotação');
    button(noteForm,'Inserir',async()=>{const text=noteInput.value.trim();if(!text)throw needs('Escreva a anotação antes de inserir');await api('note',{note:text,proposal:[],selected:[],confirmationKey:crypto.randomUUID()});noteInput.value='';await reload();},'small');
    const savedNotes=(data.notes||[]).filter((item)=>safeString(item.body_text).trim()).sort((a,b)=>(Date.parse(b.created_at)||0)-(Date.parse(a.created_at)||0));
    if(savedNotes.length){
      const notesList=append(quick,'ul','lead-quick-notes');
      // "Desfazer" on a plain note (one that distributed no data): it leaves the ficha; the notice brings it back.
      const noteLine=(parent,item)=>{const line=append(parent,'li');append(line,'span','muted',shortWhen(item.created_at)+' · ');line.append(document.createTextNode(safeString(item.body_text)));
        if(Array.isArray(item.distributed_json)&&item.distributed_json.length)return;
        const text=safeString(item.body_text);
        button(line,'Desfazer',async()=>{await api('note_remove',{noteId:item.id});undoNotice('Anotação desfeita',()=>api('note',{note:text,proposal:[],selected:[],confirmationKey:crypto.randomUUID()}));await reload();},'lead-quick-note-undo');};
      savedNotes.slice(0,3).forEach((item)=>noteLine(notesList,item));
      if(savedNotes.length>3){const more=append(quick,'details','lead-quick-more');append(more,'summary','',`Ver todas as anotações (${savedNotes.length})`);const rest=append(more,'ul','lead-quick-notes');savedNotes.slice(3).forEach((item)=>noteLine(rest,item));}
    }

    const conversation=section(root,2,'CONVERSA','lead-highlight');conversation.id='lead-conversation';
    const aiReview=append(conversation,'div','lead-card lead-highlight ai-conversation-review');append(aiReview,'span','lead-label','A IA LEU A CONVERSA');
    append(aiReview,'p','muted ai-review-rule','Roda sozinha depois de 3 mensagens da MCS, 10 min após a última mensagem do cliente e somente quando houver mensagem nova');
    append(aiReview,'p','ai-review-note','Nada é gravado sem confirmação');
    const aiStatus=append(aiReview,'p','status','');
    const readNow=append(aiReview,'button','quiet small ai-outline','Ler conversa agora');readNow.type='button';MCSAction.bind(readNow,()=>({scope:aiReview,optimistic:()=>{aiStatus.textContent='Lendo conversa…';},commit:()=>request('/api/panel/ai-conversations',{method:'POST',body:JSON.stringify({action:'read',journeyId:record.id,chatId:aiReading?.chat_id||null})}),onSuccess:()=>reload(),onError:(error)=>{aiStatus.textContent=error.code==='AI_DAILY_LIMIT'?'limite do dia atingido':'IA indisponível';},errorText:'Não consegui salvar, tente de novo'}));
    if(aiReading){
      if(!hasCalculatorRef)append(aiReview,'p','muted','Ficha sem Ref da calculadora · o que você confirmar vai direto para esta ficha');
      // Only what is new since the ficha: a 3-line summary, unanswered questions, contradictions and the items to confirm.
      const sj=aiReading.summary_json||{};
      if(sj.want||sj.status||sj.next){const box=append(aiReview,'div','ai-new-summary');[['O que quer',sj.want],['Em que pé está',sj.status],['Próximo passo',sj.next]].forEach(([label,value])=>{if(!value)return;const row=append(box,'p','');append(row,'b','',label+': ');row.append(document.createTextNode(value));});}
      if(sj.questions?.length){append(aiReview,'div','ai-route-title','Perguntas sem resposta:');sj.questions.forEach((entry)=>{const row=append(aiReview,'div','ai-note-line');append(row,'span','',entry.question);append(row,'small','muted',`Cliente: “${entry.evidence}”`);});}
      if(sj.contradictions?.length){append(aiReview,'div','ai-route-title','Contradições:');sj.contradictions.forEach((entry)=>{const row=append(aiReview,'div','ai-note-line');append(row,'span','',`${entry.field}: ficha ${entry.ficha} · cliente ${entry.cliente}`);append(row,'small','muted',`Cliente: “${entry.evidence}”`);});}
      if(sj.onlyNew&&!aiReading.items?.length&&!sj.questions?.length&&!sj.contradictions?.length)append(aiReview,'p','ai-nothing-new','Nada novo desde a última leitura');
      if(aiReading.items?.length)append(aiReview,'div','ai-route-title','Vai para:');
      const selected=[];
      (aiReading.items||[]).forEach((item)=>{const line=append(aiReview,'label','lead-route');const input=append(line,'input');input.type='checkbox';input.checked=!item.manual_review&&item.type!=='budget';selected.push({input,id:item.id});
        append(line,'strong','',item.type==='checklist'?`Checklist ${item.point} → OK`:({call_result:'Resultado da ligação',budget:'Teto total',payment:'Pagamento',deadline:'Prazo',wishlist:'Lista de desejo',phone:'Telefones',promise:'Promessa',return:'Retorno',stage:'Etapa operacional',disable:'Desligar lead'}[item.type]||item.type));
        const detail=append(line,'div','lead-route-value');append(detail,'span','',itemLabel(item,data.timezone));if(item.manual_review||item.type==='budget')append(detail,'span','lead-badge yellow','confirmar manualmente');append(detail,'small','muted',`Cliente: “${item.evidence}”`);
      });
      const aiActions=append(aiReview,'div','lead-actions');
      const confirm=append(aiActions,'button','small ai-confirm','Confirmar');confirm.type='button';confirm.disabled=!aiReading.items?.length;MCSAction.bind(confirm,()=>{const noValue=selected.some((entry)=>{const item=entry.input.checked&&(aiReading.items||[]).find((row)=>row.id===entry.id);return item&&item.type==='budget'&&!(Number(item.value)>0&&/^\s*\d+(?:\.\d+)?\s*$/.test(String(item.value)));});if(noValue){aiStatus.textContent='este item não tem valor para salvar';return{scope:aiActions,commit:()=>Promise.reject(new Error('AI_ITEM_NO_VALUE')),errorText:'este item não tem valor para salvar'};}const itemIds=selected.filter((entry)=>entry.input.checked).map((entry)=>entry.id);if(!itemIds.length){aiStatus.textContent='Marque pelo menos um item';return{scope:aiActions,commit:()=>Promise.reject(new Error('NO_ITEMS')),errorText:'Marque pelo menos um item'};}return{scope:aiActions,optimistic:()=>{aiStatus.textContent='Gravando…';},commit:()=>request('/api/panel/ai-conversations',{method:'POST',body:JSON.stringify({action:'confirm',journeyId:record.id,readingId:aiReading.id,itemIds,confirmationKey:crypto.randomUUID()})}),onSuccess:()=>reload(),onError:(error)=>{aiStatus.textContent=error.code==='JOURNEY_FROZEN'?'Ficha encerrada: só aceita telefone ou sugestão':'Não foi possível confirmar';},errorText:'Não consegui salvar, tente de novo'};});
      const discard=append(aiActions,'button','quiet small ai-outline','Descartar');discard.type='button';discard.disabled=!aiReading.items?.length;MCSAction.bind(discard,()=>({scope:aiActions,commit:()=>request('/api/panel/ai-conversations',{method:'POST',body:JSON.stringify({action:'discard',journeyId:record.id,readingId:aiReading.id})}),onSuccess:()=>reload(),onError:()=>{aiStatus.textContent='Não foi possível descartar';},errorText:'Não consegui salvar, tente de novo'}));
      aiActions.append(readNow);
    }
    // Suggested reply inside this conversation: never sent from the panel.
    // A message sent by the panel shows up in the thread: the ficha reloads a moment after the
    // confirmation is read (a simulated send outside production adds nothing, so nothing reloads).
    const afterSend=(result)=>{if(result&&result.simulated)return;setTimeout(()=>reload(),1500);};
    if(journeyId&&window.MCSSuggest)conversation.append(MCSSuggest.box(journeyId,{request,onSent:afterSend}));
    // Guided reply: the operator says what to convey, the AI writes it in the client's language (never sent).
    if(journeyId&&window.MCSSuggest&&MCSSuggest.guided)conversation.append(MCSSuggest.guided(journeyId,{request,onSent:afterSend}));
        // SMS prints are downscaled in the browser before upload (long side 1600px, JPEG 0.85): the
    // full-size file never travels and the AI reads a much smaller image. Falls back to the original file.
    const downscalePrint=(file)=>new Promise((resolve)=>{
      const done=(blob,name,type,downscaled)=>resolve({blob,name,type,downscaled});
      const url=URL.createObjectURL(file),img=new Image();
      img.onload=()=>{URL.revokeObjectURL(url);const longer=Math.max(img.width,img.height),scale=Math.min(1,1600/longer);
        if(scale>=1&&file.type==='image/jpeg')return done(file,file.name,file.type,false);
        const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));
        canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
        canvas.toBlob((blob)=>{if(!blob)return done(file,file.name,file.type,false);
          done(blob,(file.name.replace(/\.[a-z0-9]+$/i,'')||'print')+'.jpg','image/jpeg',true);},'image/jpeg',0.85);};
      img.onerror=()=>{URL.revokeObjectURL(url);done(file,file.name,file.type,false);};
      img.src=url;});
    const putWithProgress=(url,shot,onProgress)=>new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();xhr.open('PUT',url);
      xhr.setRequestHeader('content-type',shot.type);xhr.setRequestHeader('x-upsert','false');
      xhr.upload.addEventListener('progress',(event)=>{if(event.lengthComputable)onProgress(Math.round(event.loaded/event.total*100));});
      xhr.addEventListener('load',()=>{xhr.status>=200&&xhr.status<300?resolve():reject(new Error('UPLOAD_FAILED'));});
      xhr.addEventListener('error',()=>reject(new Error('UPLOAD_FAILED')));
      xhr.addEventListener('abort',()=>reject(new Error('UPLOAD_FAILED')));
      xhr.send(shot.blob);});
    // One pipeline per file, all in parallel, each with its own status line: sign → PUT (with %) →
    // AI read → confirm. The old serial loop made N prints cost N × (upload + up to 20s of AI + confirm).
    const uploadAttachment=async(files,status)=>{
      const host=status.parentElement;
      const ensured=journeyId?{journeyId,contactId:record.contact_id}:await api('ensure');
      const runOne=async(file)=>{
        const line=document.createElement('div');line.className='status';host.append(line);
        const set=(text)=>{line.textContent=text;};
        try{
          set(`Reduzindo ${file.name}…`);
          const shot=await downscalePrint(file);
          const head=new Uint8Array(await shot.blob.slice(0,64).arrayBuffer());
          set(`Enviando ${shot.name}…`);
          const signed=await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'sign',filename:shot.name,mimeType:shot.type,byteSize:shot.blob.size,magicBase64:btoa(String.fromCharCode(...head)),journeyId:ensured.journeyId,contactId:ensured.contactId})});
          const uploadUrl=new URL(signed.uploadUrl);uploadUrl.searchParams.set('token',signed.token);
          await putWithProgress(uploadUrl.toString(),shot,(pct)=>set(`Enviando ${shot.name}… ${pct}%`));
          set(`Lendo ${shot.name} com IA…`);
          const read=await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'read',readId:signed.readId})});
          if(read.manual){set((read.read?.error_code==='SMS_PRINT_DAILY_LIMIT'?'Limite de leituras de print do dia atingido':'Não consegui ler agora, tente mais tarde')+' · O print ficou guardado');return 'kept';}
          const values=read.read.extracted_json||{},fields={phone:values.phone||'',name:values.name||'',ref:values.ref||'',message:values.message||'',translation:values.translation||''};
          let saved;
          try{saved=await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'confirm',auto:true,readId:signed.readId,...fields})});}
          catch(failure){
            // The phone of the print already belongs to another contact: the same "Guardar em [nome]" as the Importações queue.
            const owner=failure&&failure.code==='SMS_PRINT_PHONE_OWNER'?failure.reason:null;
            if(!owner||!owner.journeyId)throw failure;
            set(`Este telefone já é de ${owner.name||'outro contato'}`);
            button(host,`Guardar em ${owner.name||'outro contato'}${owner.ref?` · ${owner.ref}`:''}`,async()=>{const moved=await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'confirm',readId:signed.readId,targetJourneyId:owner.journeyId,keepSource:true,...fields})});set(`✓ Guardado em ${moved.name||owner.name} · Ref ${moved.ref||owner.ref||'—'}`);await reload();},'small');
            return 'owner';}
          set(saved.duplicate?'Este print já foi guardado.':`✓ Guardado no lead de ${saved.name||'Pedido'} · Ref ${saved.ref||values.ref||'—'}`);
          button(host,'Desfazer',async()=>{await request('/api/panel/sms-print',{method:'POST',body:JSON.stringify({action:'undo',readId:signed.readId})});await reload();},'quiet small');
          return 'saved';
        }catch(_){set(`Não consegui guardar ${file.name} · tente de novo`);return 'failed';}
      };
      const results=await Promise.all(files.map(runOne));
      status.textContent='';
      if(!results.includes('owner'))await reload();
    };
    const attachmentButton=(parent)=>{const card=append(parent,'div','attachment-choice');append(card,'strong','','📷 Anexar print');append(card,'p','muted','Print de SMS, de WhatsApp ou foto · O painel lê a Ref e o número e coloca no cliente certo sozinho');const picker=append(card,'label','small','📷 Escolher prints'),input=append(picker,'input');input.type='file';input.accept='image/*';input.multiple=true;input.hidden=true;const info=append(card,'span','muted','');const actions=append(card,'div','inline-actions');const remove=button(actions,'✕ Remover',()=>{input.value='';info.textContent='';send.disabled=true;remove.hidden=true;},'quiet small');remove.hidden=true;const send=button(actions,'Guardar print',async()=>{await uploadAttachment([...input.files],status);},'small');send.disabled=true;const status=append(card,'span','status','');input.addEventListener('change',()=>{const files=[...input.files];info.textContent=files.map((file)=>`${file.name} · ${(file.size/1024/1024).toFixed(1)} MB`).join(' · ');send.disabled=!files.length;remove.hidden=!files.length;});};
    // No controls block above the conversation (Anexar print, ordem, filtro, inverter remetentes, traduzir): the thread is chronological and complete.
    // The conversation in WhatsApp Web bubbles inside "A IA LEU A CONVERSA" (client left in white, MCS right in green,
    // centred date dividers, time inside the bubble); the list "Vai para:" comes right below it.
    const thread=append(conversation,'div','lead-thread wa-thread');aiStatus.after(thread);let messages=record.conversation||[];
    let tzOf=data.timezone||'America/New_York';
    // No date (null, 0 or empty: a print without its original date) gives no day and no time, never 31/12/1969 or 19:00.
    const dayOf=(value)=>{if(!value)return '';try{return new Intl.DateTimeFormat('pt-BR',{timeZone:tzOf,day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(value));}catch(_){return '';}};
    const timeOf=(value)=>{if(!value)return '';try{return new Intl.DateTimeFormat('pt-BR',{timeZone:tzOf,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));}catch(_){return '';}};
    // Translation on demand (cached by message): shown under the original, which never changes.
    let visibleIds=[];const translateButton=null,translateStatus={textContent:''};
    const tr=journeyId&&window.MCSSuggest&&MCSSuggest.translator?MCSSuggest.translator(journeyId,{request,onChange:()=>draw()}):null;
    // Counts what the button translates: the pending messages shown with the current filter.
    const paintTranslate=()=>{if(!translateButton)return;const pending=tr.pending().filter((id)=>visibleIds.includes(id)).length;translateButton.disabled=tr.busy()||!pending;translateButton.textContent=tr.busy()?'Traduzindo…':pending?`Traduzir conversa (${pending})`:(tr.hasAny()?'Conversa traduzida':'Traduzir conversa');};
    const draw=()=>{thread.replaceChildren();let list=messages.slice();visibleIds=list.map((message)=>message.id);
      let lastDay=null;
      list.forEach((message)=>{const at=message.occurred_at_utc||message.created_at;const day=dayOf(at);if(day&&day!==lastDay){lastDay=day;const divider=append(thread,'div','wa-day');append(divider,'span','',day);}
        const bubble=append(thread,'article','lead-message wa-bubble '+(message.direction==='MCS'?'m':'c'));
        append(bubble,'p','wa-text',message.body_text);
        append(bubble,'span','wa-time',message.date_unknown?'data original desconhecida':timeOf(at));
        if(tr){const done=tr.get(message.id);if(done){const box=append(bubble,'div','message-translation');append(box,'small','muted','Tradução para português');append(box,'p','',done.textPt);}else if(tr.canTranslate(message.id)){const one=button(bubble,'traduzir',async()=>{if(tr.busy())return;translateStatus.textContent='';try{await tr.translate([message.id]);}catch(error){translateStatus.textContent=error&&error.code==='OPENAI_BUDGET_LIMIT'?'Sem saldo pré-pago na OpenAI · Nada foi cobrado':'Não consegui traduzir esta mensagem · tente de novo';}},'quiet small');one.classList.add('translate-one');}}
        if(message.direction==='MCS'&&message.media_kind)append(bubble,'span','muted',({image:'Foto enviada',audio:'Áudio enviado',video:'Vídeo enviado',document:'Documento enviado',sticker:'Sticker enviado'}[message.media_kind]||'Mídia enviada'));else if(message.media_status==='STORED'&&mediaObjectUrl){const media=append(bubble,'div','whatsapp-media'),load=append(media,'button','quiet small',message.media_kind==='document'?'Baixar':'Carregar mídia');load.type='button';load.addEventListener('click',async()=>{load.disabled=true;try{const url=await mediaObjectUrl(message.id);load.remove();if(message.media_kind==='image'){const image=append(media,'img','whatsapp-media-image');image.alt='Foto da conversa';image.src=url;image.addEventListener('click',()=>window.open(url,'_blank','noopener'));}else if(message.media_kind==='audio'){const player=append(media,'audio');player.controls=true;player.src=url;}else if(message.media_kind==='video'){const player=append(media,'video');player.controls=true;player.src=url;}else{const link=append(media,'a','', 'Baixar');link.href=url;link.download='';link.target='_blank';link.rel='noopener';}}catch(_){load.disabled=false;load.textContent='Mídia não disponível';}});}else if(message.media_status==='FAILED')append(bubble,'span','muted','Mídia não disponível');
        if(message.direction==='MCS'){const automatic=button(bubble,message.is_automatic?'não é automática':'marcar como automática',async()=>{automatic.disabled=true;try{await request('/api/panel/messages',{method:'POST',body:JSON.stringify({messageId:message.id,automatic:!message.is_automatic})});await reload();}finally{automatic.disabled=false;}});automatic.classList.add('quiet','small');}
        if(journeyId&&actionMessage)bubble.append(actionMessage(message,journeyId,reload,ref,data.timezone));});
      if(!list.length)append(thread,'p','muted','Nenhuma mensagem neste filtro');if(tr)paintTranslate();};
    draw();
    liveViews.set(root,{kind,key,refresh:async()=>{
      if(typeof isCurrent==='function'&&!isCurrent())return;
      const fresh=await request('/api/panel/lead?'+new URLSearchParams(kind==='order'?{ref:key}:{id:key}));
      if(typeof isCurrent==='function'&&!isCurrent())return;
      const next=fresh.record?.conversation,timezone=fresh.timezone||'America/New_York';
      if(!Array.isArray(next)){if(!record.id&&fresh.record===null)return;throw Error('LEAD_RESPONSE_INVALID');}
      if(JSON.stringify(next)===JSON.stringify(messages)&&timezone===tzOf)return;
      messages=next;tzOf=timezone;draw();if(tr)tr.load();
    }});
    if(tr)tr.load();
    // A20: reply from the panel (review in Portuguese, translation, 24 h window checked by the server).
    if(journeyId&&replyComposer)replyComposer(conversation,journeyId,reload);

    // Bloco 12 (Dados e histórico) e 11 (Página do cliente) saíram; ficam os anexos (imagens que o cliente manda, o único
    // lugar do painel onde aparecem) e o Anexar print, num cartão logo abaixo da Conversa. O link do cliente está no cabeçalho.
    const attachmentsCard=append(root,'section','lead-card lead-attachments-card');attachmentsCard.id='lead-attachments';append(attachmentsCard,'span','lead-label','ANEXOS');
    const attachments=append(attachmentsCard,'div','lead-attachments');
    (record.attachments||[]).forEach((item)=>{const card=append(attachments,'button','lead-attachment');card.type='button';if(item.kind==='IMAGE'){const thumb=append(card,'img','lead-attachment-thumb');thumb.alt='';request('/api/panel/attachments',{method:'POST',body:JSON.stringify({action:'download',attachmentId:item.id})}).then((signed)=>{thumb.src=signed.url;}).catch(()=>{thumb.replaceWith(Object.assign(document.createElement('span'),{className:'lead-attachment-thumb',textContent:'🖼️'}));});}else append(card,'span','lead-attachment-thumb','📄');append(card,'span','',`${item.original_filename} · ${date(item.created_at,data.timezone)}`);card.addEventListener('click',async()=>{card.disabled=true;try{const signed=await request('/api/panel/attachments',{method:'POST',body:JSON.stringify({action:'download',attachmentId:item.id})});window.open(signed.url,'_blank','noopener');}finally{card.disabled=false;}});});
    if(!record.attachments?.length)attachmentsCard.classList.add('lead-attachments-empty');
    attachmentButton(attachmentsCard);
    // Order on screen: header (with the quick result inside) → case summary → conversation → anexos → the rest.
    topAnchor.replaceWith(conversation,attachmentsCard);
    // End of the page: switch the ficha off (with the reason) and, in the same place, on again. A7: a closed ficha is
    // reopened explicitly; one merged into another conversation stays closed.
    const power=append(root,'section','lead-card lead-power');append(power,'span','lead-label',record.enabled===false?'FICHA DESLIGADA':'DESLIGAR FICHA');
    const powerActions=append(power,'div','lead-actions');
    if(record.status==='ENCERRADO'&&record.closed_reason==='WHATSAPP_LINKED')append(powerActions,'p','muted','Ficha juntada a outra conversa');
    else if(record.enabled===false){if(record.offReason)append(power,'p','muted','Motivo: '+(({MCS_PURCHASE:'Comprou com a MCS',OTHER_PURCHASE:'Comprou em outro lugar',GAVE_UP:'Desistiu',NO_RESPONSE:'Sem resposta'})[record.offReason]||record.offReason));
      button(powerActions,record.status==='ENCERRADO'?'Reabrir ficha':'Ligar lead',async()=>{await api('manual',{panelAction:'toggle_journey',payload:{enabled:true}});undoNotice('Ficha religada',()=>api('manual',{panelAction:'toggle_journey',payload:{enabled:false,reason:record.offReason||null}}));await reload();});}
    else {const reason=append(powerActions,'select');[['','Desligar com motivo'],['MCS_PURCHASE','Comprou com a MCS'],['OTHER_PURCHASE','Comprou em outro lugar'],['GAVE_UP','Desistiu'],['NO_RESPONSE','Sem resposta']].forEach(([v,label])=>reason.append(new Option(label,v)));
      const off=button(powerActions,'Desligar',async()=>{await api('manual',{panelAction:'toggle_journey',payload:{enabled:false,reason:reason.value}});undoNotice('Ficha desligada',()=>api('manual',{panelAction:'toggle_journey',payload:{enabled:true}}));await reload();});
      off.disabled=true;off.title='Escolha o motivo';reason.addEventListener('change',()=>{off.disabled=!reason.value;});}
  }
  window.MCSLead={open,refresh};
})();
