(() => {
  'use strict';
  const e = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined && text !== null) node.textContent = String(text); return node; };
  const append = (parent, tag, cls, text) => { const node = e(tag,cls,text); parent.append(node); return node; };
  const fmt = (value) => Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(Number(value)) : '—';
  const cents = (value) => value ? fmt(Number(value)/100) : '—';
  const date = (value,tz='America/New_York') => value ? new Intl.DateTimeFormat('pt-BR',{timeZone:tz,dateStyle:'short',timeStyle:'short'}).format(new Date(value)) : '—';
  const badge = (text,cls) => e('span','lead-badge '+(cls||''),text);
  const button = (parent,label,run,cls='quiet small') => { const node=append(parent,'button',cls,label); node.type='button'; node.addEventListener('click',async () => { node.disabled=true; try { await run(); } catch (_) { alert('Não foi possível salvar. Tente novamente.'); } finally { node.disabled=false; } }); return node; };
  const section = (root,n,title,cls='') => { const card=append(root,'section','lead-card '+cls); append(card,'span','lead-label',`${n} — ${title}`); return card; };
  const row = (root,...values) => { const line=append(root,'div','lead-line'); values.forEach((value)=> append(line,'span','',value || '—')); return line; };
  const stageNames = ['Searching','Cars presented','Bid scheduled','Result'];
  const deadlineLabel = {now:'Agora','30d':'até 30 dias','3m':'30–90 dias',none:'Sem prazo'};
  const paymentLabel = {cash:'À vista',fin:'Financiado'};
  const formatPhone=(value)=>{const digits=String(value||'').replace(/\D/g,'');if(digits.length===11&&digits[0]==='1')return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;return value||'sem telefone';};
  const elapsed = (value) => { const hours=(Date.now()-Date.parse(value))/3600000; return hours < 1 ? `${Math.max(1,Math.round(hours*60))} min` : hours < 48 ? `${Math.floor(hours)} h` : `${Math.floor(hours/24)} dias`; };
  const safeString = (value) => value === null || value === undefined ? '' : String(value);
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
      ...(data.events||[]).map((item)=>({at:item.occurred_at,text:item.event_type==='EXTRA_PHONE'?`Telefone extra (${item.detail_json?.owner||'contato'}): ${item.detail_json?.number}`:item.event_type==='DISABLE_SUGGESTED'?`Sugestão de desligar: ${item.detail_json?.reason||'sem motivo'}`:item.detail_json?.label||item.detail_json?.vehicle||item.event_type})),
      ...(data.order?.simulations||[]).map((item)=>({at:item.occurredAt,text:`Simulação ${item.logicalMode==='VALOR'?'por valor':'carro ideal'} · ${item.vehicleText||'sem carro'}`}))];
    if (record.contact?.notes) entries.push({at:record.created_at,text:`Nota antiga: ${record.contact.notes}`});
    return entries.sort((a,b)=>Date.parse(b.at||0)-Date.parse(a.at||0));
  }
  async function open(options) {
    const {kind,key,root,request,onChanged,actionMessage,downloadShortlist,dispositionControls} = options;
    const data=await request('/api/panel/lead?'+new URLSearchParams(kind==='order'?{ref:key}:{id:key}));
    root.replaceChildren(); root.classList.add('lead-detail');
    const record=data.record||{},order=data.order||{},track=data.track||{},ref=data.ref,journeyId=record.id;
    let activeUndo=null;
    const api=async(action,fields={})=>{
      const result=await request('/api/panel/lead',{method:'POST',body:JSON.stringify({action,ref,journeyId,...fields})});
      if(action!=='undo'&&action!=='quick'&&activeUndo){activeUndo.remove();activeUndo=null;}
      return result;
    };
    const reload=async()=>{const position=window.scrollY; await onChanged(); requestAnimationFrame(()=>window.scrollTo(0,position));};
    const failed=(card,text)=>append(card,'p','status error',text);
    const title=record.contact?.display_name||order.contactName||'Contato sem nome';
    const phones=(record.phones||[]).filter((item)=>item.is_current!==false).sort((a,b)=>Number(Boolean(b.is_primary))-Number(Boolean(a.is_primary)));
    const heading=section(root,1,'CABEÇALHO DA LIGAÇÃO');
    const header=append(heading,'div','lead-header');
    append(header,'div','lead-score',data.score===null?'—':data.score);
    const identity=append(header,'div','lead-head-name'); append(identity,'h2','',`${title} — Ref ${ref}`);
    const locationLine=append(identity,'p','muted',`${data.city?data.city+', ':''}${data.state?.uf||'Local não identificado'}${data.zip?` · ZIP ${data.zip}`:''}`);
    if(data.zip&&!data.city)request('/api/panel/lead?cityZip='+encodeURIComponent(data.zip)).then((place)=>{
      if(locationLine.isConnected&&place.city)locationLine.textContent=`${place.city}, ${data.state?.uf||''} · ZIP ${data.zip}`;
    }).catch(()=>{});
    const right=append(header,'div','lead-head-right');
    append(right,'strong','lead-clock',new Intl.DateTimeFormat('pt-BR',{timeZone:data.timezone,hour:'2-digit',minute:'2-digit'}).format(new Date()));
    append(right,'span','muted',` horário do cliente · ${data.goodHour?'bom horário para ligar':'fora de horário'}`);
    const calling=append(right,'div','lead-actions');
    if(phones.length){phones.forEach((phone)=>{const line=append(calling,'div','lead-phone');const shown=formatPhone(phone.phone_e164||phone.phone_raw);const link=append(line,'a','lead-call',`${shown}${phone.phone_owner?' — '+phone.phone_owner:''}${phone.is_primary?' · principal':''}`);link.href='tel:'+safeString(phone.phone_e164||phone.phone_raw).replace(/[^\d+]/g,'');button(line,'Copiar',()=>navigator.clipboard.writeText(phone.phone_e164||phone.phone_raw));});}
    else append(calling,'span','muted','Sem telefone — pedir no WhatsApp');
    const badges=append(heading,'div','lead-badges');
    badges.append(badge(deadlineLabel[record.customer_deadline_text||order.deadlineText]||'Sem prazo','green'),badge(paymentLabel[data.payment]||'Não informado','green'));
    if(data.lastCustomerAt) badges.append(badge(`última mensagem do cliente há ${elapsed(data.lastCustomerAt)}`));
    badges.append(badge(record.enabled===false?'DESLIGADO':'LIGADO',record.enabled===false?'red':'green'));
    if(dispositionControls) heading.append(dispositionControls(order.ref?{kind:'CALCULATOR',ref}:{kind:'JOURNEY',id:record.id}));
    button(heading,record.contact?.is_lead===false?'Restaurar como lead':'Não é lead',async()=>{if(!window.confirm(record.contact?.is_lead===false?'Restaurar este contato como lead?':'Marcar como não-lead? As mensagens continuarão guardadas.'))return;await api('contact_lead',{isLead:record.contact?.is_lead===false});await onChanged();});

    const trio=append(root,'div','lead-grid lead-three');
    const wishes=section(trio,2,'O QUE ELE QUER');
    if(!data.wishes.length) append(wishes,'p','muted','Carro ainda não informado.');
    data.wishes.forEach((wish,index)=>row(wishes,`${index+1}. ${model(wish)}`,`${wish.yearMin||'—'}–${wish.yearMax||'—'}`,wish.maxMiles?`até ${Number(wish.maxMiles).toLocaleString('en-US')} mi`:'milhas não informadas'));
    append(wishes,'p','muted',`Lance máximo (calculadora): ${cents(data.maxBidCents)}`);
    append(wishes,'p','muted',`Teto total confirmado: ${cents(data.totalCeilingCents)}`);
    append(wishes,'p','muted',`${data.florida?'Registra na FL':'Registra fora da FL'} · placa: ${data.plate==='nova'?'nova':'transferir'}`);
    const ceilingForm=append(wishes,'div','lead-actions');const ceilingInput=append(ceilingForm,'input');ceilingInput.type='number';ceilingInput.min='1';ceilingInput.step='1';ceilingInput.placeholder='Teto total confirmado (US$)';ceilingInput.value=data.totalCeilingCents?data.totalCeilingCents/100:'';
    button(ceilingForm,'Confirmar teto total',async()=>{await api('total_ceiling',{amount:ceilingInput.value});await reload();});
    const reality=section(trio,3,'REALIDADE (SÓ PARA VOCÊ)');
    append(reality,'p','',`Lance realista: ${data.bid===null?(data.totalCeilingCents?'sem lance viável no teto':'lance máximo não informado'):fmt(data.bid)}`);
    if(!data.typical.length) append(reality,'p','muted','MMR típico: sem referência');
    data.typical.forEach((wish)=>{ append(reality,'p','muted',`MMR típico ${model(wish)}: ${wish.mmrCents?cents(wish.mmrCents):'sem referência'}`);
      if(wish.mmrCents&&data.bid!==null&&wish.mmrCents>data.bid*100) reality.append(badge(`Teto curto em ~${cents(wish.mmrCents-data.bid*100)}`,'yellow')); });
    append(reality,'p','muted','Cabe no teto: '+(data.fits.length?data.fits.map((car)=>`${car.make} ${car.model} ${car.year} · ${Number(car.miles).toLocaleString('en-US')} mi`).join(' · '):'sem combinação nos CSVs'));
    const numbers=section(trio,4,'NÚMEROS PRONTOS');
    if(data.costs){const c=data.costs;row(numbers,'Depósito',fmt(c.deposito));row(numbers,'Taxa de serviço',fmt(c.servico));row(numbers,'Taxa do leilão + fixas',fmt(c.gLeilao));row(numbers,'Tax, title & registration',fmt(c.gTaxReg));row(numbers,'Total estimado',fmt(c.totalProjetado));}
    else append(numbers,'p','muted',data.totalCeilingCents?'O teto não cobre o lance mínimo e os custos.':'Lance máximo ainda não informado.');

    const second=append(root,'div','lead-grid lead-three');
    const questions=section(second,5,'PERGUNTAR NA LIGAÇÃO');
    data.checklist.filter((point)=>point.status!=='COMPLETE').forEach((point)=>append(questions,'p','',`${point.point_number}. ${point.point_label}?`));
    if(data.bid!==null&&data.typical.some((wish)=>wish.mmrCents&&wish.mmrCents>data.bid*100)) append(questions,'p','',`O teto de ${cents(data.totalCeilingCents||data.maxBidCents)} é final ou tem margem?`);
    if(!questions.querySelector('p'))append(questions,'p','muted','Checklist completo.');
    const offers=section(second,6,'O QUE OFERECER');
    if(!data.offers.length)append(offers,'p','muted','Nenhum carro compatível dentro do lance realista.');
    data.offers.forEach((car)=>{const line=append(offers,'div','lead-offer');line.append(badge(car.kind,car.kind==='BATE'?'green':'yellow'));
      append(line,'span','',`${car.year} ${car.make} ${car.model} ${car.trim||''} · ${Number(car.miles).toLocaleString('en-US')} mi · ${car.locationDisplay||car.location||''} · ${car.saleDate||'data não informada'}`);
      button(line,'Apresentar',async()=>{await api('present',{fingerprint:car.rowFingerprint});await reload();}); });
    const context=section(second,7,'CONTEXTO RÁPIDO');
    const allPromises=[...(record.promises||[]),...(data.promises||[])];
    const promises=allPromises.filter((promise)=>promise.status==='OPEN');
    const clientDay=(value)=>new Intl.DateTimeFormat('en-CA',{timeZone:data.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
    promises.forEach((promise)=>{const line=append(context,'p','',`Prometi: ${promise.promise_text}`);const due=clientDay(promise.due_at),today=clientDay(Date.now());if(due<=today)line.append(badge(due<today?'vencida':'vence hoje',due<today?'red':'yellow'));});
    append(context,'p','',`Já apresentados: ${record.units?.length?record.units.map((unit)=>unit.vehicle_text).join(' · '):'nenhum carro'}`);
    [...(record.conversation||[])].filter((message)=>message.direction==='CUSTOMER').slice(-3).reverse().forEach((message)=>{
      const link=button(context,`↓ ${safeString(message.body_text).slice(0,120)}`,()=>document.getElementById('lead-conversation')?.scrollIntoView({behavior:'smooth'}));link.classList.add('lead-context-link'); });

    const note=section(root,8,'ANOTAÇÕES DA LIGAÇÃO','lead-highlight');
    append(note,'p','muted','Escreva do seu jeito, em português, durante ou depois da ligação.');
    const textarea=append(note,'textarea','lead-note');textarea.placeholder='Anote a conversa aqui…';textarea.maxLength=12000;
    const draftKey='mcs_lead_draft_'+ref;textarea.value=sessionStorage.getItem(draftKey)||'';
    textarea.addEventListener('input',()=>sessionStorage.setItem(draftKey,textarea.value));
    const noteStatus=append(note,'p','status','');const review=append(note,'div','lead-review');
    button(note,'Distribuir anotação',async()=>{
      const body=textarea.value.trim();if(!body)return;
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
            const dateLabel=append(detail,'label','muted','Data e hora — horário do cliente');
            const due=append(detail,'input','lead-manual-date');due.type='datetime-local';due.setAttribute('aria-label','Data e hora — horário do cliente');
            due.addEventListener('input',()=>{manualDates[index]=due.value;input.disabled=!due.value;if(!due.value)input.checked=false;});
            dateLabel.htmlFor=due.id='lead-manual-date-'+index;
          }
        });
        const actions=append(review,'div','lead-actions');
        button(actions,'Confirmar',async()=>{await api('note',{note:body,proposal:proposal.items,signature:proposal.signature,selected:selected.flatMap((input,index)=>input.checked?[index]:[]),manualDates,confirmationKey});sessionStorage.removeItem(draftKey);await reload();},'small');
        button(actions,'Editar anotação',()=>{review.replaceChildren();noteStatus.textContent='';});
      }catch(_){await api('note',{note:body,proposal:[],selected:[],confirmationKey});sessionStorage.removeItem(draftKey);textarea.value='';review.replaceChildren();noteStatus.textContent='Anotação salva; distribuição indisponível agora — tentar de novo';}
    },'small');

    const quick=section(root,9,'RESULTADO RÁPIDO');const quickActions=append(quick,'div','lead-actions');
    function undo(event){if(activeUndo)activeUndo.remove();const toast=append(document.body,'div','undo-toast');activeUndo=toast;append(toast,'span','','Resultado registrado.');
      button(toast,'Desfazer',async()=>{await api('undo',{eventId:event.eventId});toast.remove();await reload();});setTimeout(()=>{toast.remove();if(activeUndo===toast)activeUndo=null;},10000);}
    async function quickResult(type,dueLocal){
      const key='mcs_quick_'+ref+'_'+type+'_'+(dueLocal||'');
      let operationId=sessionStorage.getItem(key);
      if(!operationId){operationId=crypto.randomUUID();sessionStorage.setItem(key,operationId);}
      const event=await api('quick',{type,dueLocal,operationId});sessionStorage.removeItem(key);
      if(event.duplicate)alert('Resultado já registrado.');else undo(event);
      await reload();
    }
    [['Atendeu','ANSWERED'],['Não atendeu','NO_ANSWER'],['Conversa presencial','IN_PERSON'],['Vai pagar o depósito','DEPOSIT']].forEach(([label,type])=>button(quickActions,label,()=>quickResult(type)));
    const later=button(quickActions,'Pediu para ligar depois',()=>{laterForm.hidden=false;});
    const laterForm=append(quick,'div','lead-actions');laterForm.hidden=true;const laterDate=append(laterForm,'input');laterDate.type='datetime-local';append(laterForm,'small','muted','horário do cliente');
    button(laterForm,'Registrar retorno',async()=>{if(laterDate.value)await quickResult('LATER',laterDate.value);},'small');

    const tracking=section(root,10,'PÁGINA DO CLIENTE','lead-highlight');
    const steps=append(tracking,'div','lead-steps');stageNames.forEach((label,index)=>button(steps,label,async()=>{
      if(index===3){resultChoice.hidden=false;return;}await api('tracking_step',{step:index+1});await reload();},'lead-step '+(index+1<=track.step?'on':'')));
    const resultChoice=append(tracking,'div','lead-actions');resultChoice.hidden=true;
    button(resultChoice,'Won',async()=>{await api('tracking_step',{step:4,result:'WON'});await reload();});
    button(resultChoice,'Not won',async()=>{await api('tracking_step',{step:4,result:'NOT_WON'});await reload();});
    button(tracking,'Copiar link do cliente',()=>navigator.clipboard.writeText(location.origin+'/t/'+track.public_code));
    const customerResponses=(data.events||[]).filter((entry)=>['WANT_CAR','NOT_FOR_ME'].includes(entry.event_type));
    append(tracking,'p','muted',customerResponses.length?customerResponses.map((entry)=>`${entry.detail_json.vehicle}: ${entry.event_type==='WANT_CAR'?'I want this':'Not for me'}`).join(' · '):'O cliente ainda não respondeu aos carros.');

    const finalGrid=append(root,'div','lead-grid lead-two');
    const conversation=section(finalGrid,11,'CONVERSA','lead-highlight');conversation.id='lead-conversation';
    const uploadAttachment=async(file,status)=>{if(!file)return;status.textContent='Enviando…';const ensured=journeyId?{journeyId,contactId:record.contact_id}:await api('ensure');const head=new Uint8Array(await file.slice(0,64).arrayBuffer());const magicBase64=btoa(String.fromCharCode(...head));const signed=await request('/api/panel/attachments',{method:'POST',body:JSON.stringify({action:'sign',filename:file.name,mimeType:file.type,byteSize:file.size,magicBase64})});const uploadUrl=new URL(signed.uploadUrl);uploadUrl.searchParams.set('token',signed.token);const uploadBody=new FormData();uploadBody.append('cacheControl','3600');uploadBody.append('',file);const uploaded=await fetch(uploadUrl.toString(),{method:'PUT',headers:{'x-upsert':'false'},body:uploadBody});if(!uploaded.ok)throw Error('UPLOAD_FAILED');await request('/api/panel/attachments',{method:'POST',body:JSON.stringify({action:'finalize',attachmentId:signed.attachmentId,quarantinePath:signed.quarantinePath,filename:signed.filename,mimeType:file.type,contactId:ensured.contactId,journeyId:ensured.journeyId})});status.textContent='Anexo salvo.';await reload();};
    const attachmentButton=(parent)=>{const input=append(parent,'input');input.type='file';input.accept='image/jpeg,image/png,image/webp,application/pdf';input.hidden=true;const status=append(parent,'span','status','');button(parent,'Anexar',()=>input.click());input.addEventListener('change',()=>uploadAttachment(input.files[0],status).catch((error)=>{status.textContent=error.message==='ATTACHMENT_REJECTED'?'Tipo não aceito ou arquivo maior que 10 MB.':'Falha no envio do anexo.';}));};
    attachmentButton(conversation);
    const controls=append(conversation,'div','lead-actions');
    const sort=append(controls,'select');[['recent','Mais recentes'],['oldest','Mais antigas']].forEach(([value,label])=>sort.append(new Option(label,value)));
    sort.value=localStorage.getItem('mcs_conversation_sort')||'recent';
    const filter=append(controls,'select');[['all','Tudo'],['CUSTOMER','Cliente'],['MCS','MCS']].forEach(([value,label])=>filter.append(new Option(label,value)));
    if(journeyId){[...new Set((record.conversation||[]).map((message)=>message.chat_id).filter(Boolean))].forEach((chatId)=>button(controls,'Inverter remetentes desta conversa',async()=>{if(!window.confirm('Inverter os remetentes desta conversa?'))return;await api('manual',{panelAction:'invert_senders',payload:{chatId}});await reload();}));}
    const thread=append(conversation,'div','lead-thread');const messages=record.conversation||[];
    const draw=()=>{thread.replaceChildren();let list=messages.filter((message)=>filter.value==='all'||message.direction===filter.value);if(sort.value==='recent')list=list.slice().reverse();
      list.forEach((message)=>{const bubble=append(thread,'article','lead-message '+(message.direction==='MCS'?'m':'c'));
        append(bubble,'small','muted',`${message.channel} · ${message.direction==='CUSTOMER'?'Cliente':'MCS'} · ${date(message.occurred_at_utc||message.created_at,data.timezone)}`);
        append(bubble,'p','',message.body_text);if(journeyId&&actionMessage)bubble.append(actionMessage(message,journeyId,reload,ref));});
      if(!list.length)append(thread,'p','muted','Nenhuma mensagem neste filtro.');};
    sort.addEventListener('change',()=>{localStorage.setItem('mcs_conversation_sort',sort.value);draw();});filter.addEventListener('change',draw);draw();

    const history=section(finalGrid,12,'DADOS E HISTÓRICO','lead-highlight');
    attachmentButton(history);
    append(history,'h3','','Anexos');const attachments=append(history,'div','lead-attachments');
    (record.attachments||[]).forEach((item)=>{const card=append(attachments,'button','lead-attachment');card.type='button';if(item.kind==='IMAGE')append(card,'span','lead-attachment-thumb','🖼️');else append(card,'span','lead-attachment-thumb','📄');append(card,'span','',`${item.original_filename} · ${date(item.created_at,data.timezone)}`);card.addEventListener('click',async()=>{card.disabled=true;try{const signed=await request('/api/panel/attachments',{method:'POST',body:JSON.stringify({action:'download',attachmentId:item.id})});window.open(signed.url,'_blank','noopener');}finally{card.disabled=false;}});});
    if(!record.attachments?.length)append(attachments,'p','muted','Nenhum anexo.');
    append(history,'h3','',`Checklist ${data.checklist.filter((point)=>point.status==='COMPLETE').length}/6`);
    data.checklist.forEach((point)=>{const line=append(history,'div','lead-check');button(line,`${point.point_number}. ${point.point_label} · ${point.status==='COMPLETE'?'OK':'Pendente'}`,async()=>{await api('checklist',{point:point.point_number,complete:point.status!=='COMPLETE'});await reload();});});
    const extraPhones=(data.events||[]).filter((item)=>item.event_type==='EXTRA_PHONE');
    if(extraPhones.length){append(history,'h3','','Telefones extras');extraPhones.forEach((item)=>row(history,item.detail_json?.owner||'Contato',item.detail_json?.number));}
    append(history,'h3','','Retornos');
    (record.returns||[]).filter((item)=>item.status==='OPEN').forEach((item)=>{const line=row(history,item.text,date(item.dueAt,data.timezone));button(line,'Concluir',async()=>{await api('manual',{panelAction:'return_update',payload:{returnKind:item.kind,returnId:item.kind==='PROMISE'?item.id:null,operation:'COMPLETE'}});await reload();});});
    if(!record.next_action_at){const form=append(history,'div','lead-actions');const task=append(form,'input');task.placeholder='Retorno manual';const due=append(form,'input');due.type='datetime-local';
      append(form,'small','muted','horário do cliente');button(form,'Adicionar retorno',async()=>{await api('manual',{panelAction:'next_action',payload:{operation:'CREATE',text:task.value,atLocal:due.value}});await reload();});}
    append(history,'h3','','Unidades apresentadas');
    (record.units||[]).forEach((unit)=>{const line=append(history,'div','lead-unit');append(line,'strong','',unit.vehicle_text);append(line,'p','muted',`${date(unit.presented_at,data.timezone)} · ${unit.status}`);
      const fields=append(line,'div','lead-actions');const value=append(fields,'input');value.type='number';value.placeholder='Retail comparison (US$)';value.value=unit.details_json?.retailValue||'';
      const link=append(fields,'input');link.type='url';link.placeholder='Link da página de comparativos MCS';link.value=unit.details_json?.retailUrl||'';
      button(fields,'Salvar comparativo',async()=>{await api('retail',{unitId:unit.id,value:value.value,url:link.value});await reload();});});
    if(!record.units?.length)append(history,'p','muted','Nenhuma unidade apresentada.');
    append(history,'h3','','Etapa operacional');const stage=append(history,'select');
    [['NOVO','Novo'],['RESPONDIDO','Respondido'],['EM_BUSCA','Em busca'],['DECIDINDO','Decidindo'],['QUALIFICADO','Qualificado']].forEach(([v,label])=>stage.append(new Option(label,v)));
    stage.value=record.stage||'NOVO';button(history,'Salvar etapa',async()=>{await api('manual',{panelAction:'set_funnel',payload:{value:stage.value}});await reload();});
    append(history,'h3','','Simulações da Ref');
    (order.simulations||[]).forEach((simulation)=>row(history,simulation.logicalMode==='VALOR'?'Por valor':'Carro ideal',simulation.vehicleText||'Veículo não informado',cents(simulation.budgetCents)));
    append(history,'h3','','Promessas');allPromises.forEach((promise)=>{const line=row(history,promise.promise_text,date(promise.due_at,data.timezone),({OPEN:'Aberta',FULFILLED:'Concluída',CANCELLED:'Cancelada'})[promise.status]||promise.status);if(promise.status==='OPEN')button(line,'Concluir',async()=>{await api('promise_complete',{promiseId:promise.id,kind:promise.message_id?'OLD':'NEW'});await reload();});});
    append(history,'h3','','Linha do tempo');const timeline=append(history,'ul','lead-timeline');timelineRows(data).forEach((item)=>append(timeline,'li','',`${date(item.at,data.timezone)} — ${item.text}`));
    const power=append(history,'div','lead-actions');
    if(record.enabled===false)button(power,'Ligar lead',async()=>{await api('manual',{panelAction:'toggle_journey',payload:{enabled:true}});await reload();});
    else {const reason=append(power,'select');[['','Desligar com motivo'],['MCS_PURCHASE','Comprou com a MCS'],['OTHER_PURCHASE','Comprou em outro lugar'],['GAVE_UP','Desistiu'],['NO_RESPONSE','Sem resposta']].forEach(([v,label])=>reason.append(new Option(label,v)));
      button(power,'Desligar',async()=>{if(!reason.value)return;await api('manual',{panelAction:'toggle_journey',payload:{enabled:false,reason:reason.value}});await reload();});}
    if(downloadShortlist){const matching=(data.offers||[]).map((car)=>({vehicle_json:{parsed:car}}));if(matching.length)button(history,'Baixar PDF',()=>downloadShortlist(matching,ref));}
  }
  window.MCSLead={open};
})();
