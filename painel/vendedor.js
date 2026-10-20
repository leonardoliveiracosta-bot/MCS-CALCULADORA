(() => {
  'use strict';
  const e=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const add=(p,tag,cls,text)=>{const n=e(tag,cls,text);p.append(n);return n;};
  const button=(p,text,run,cls='quiet small')=>{const n=add(p,'button',cls,text);n.type='button';n.addEventListener('click',run);return n;};
  const api=(request,body)=>request('/api/panel/vendedor',{method:'POST',timeoutMs:65000,body:JSON.stringify(body)});
  const labels={inconsciente:'inconsciente',problema:'consciente do problema',solucao:'consciente da solução',compra:'consciente da compra'};
  const WARNING='Fora da janela de 24 h do WhatsApp: o painel não consegue enviar. Copie e mande pelo app do celular';
  const textLines=s=>s.mensagens.map(m=>m.texto).concat(s.link?['mycarscout.net']:[]);
  function box(journeyId,{request,onSent,onConversationChange}={}) {
    const card=e('section','lead-card vendedor-card');card.setAttribute('aria-label','Resposta sugerida');
    let data=null,busy=false,closed=false,poll=null,expiry=null,polls=0,watch=null,watching=false,refreshQueued=false,lastKnownId,selected=new Set(),updateFailed=false,watchFailures=0;
    const title=add(card,'div','vendedor-title');add(title,'h3','','Resposta sugerida');
    const heat=add(title,'span','vendedor-heat');
    const body=add(card,'div','vendedor-body');
    const warn=add(card,'p','vendedor-warning',WARNING);warn.hidden=true;
    const status=add(card,'p','status vendedor-status');status.setAttribute('role','status');
    const actions=add(card,'div','vendedor-actions');
    const adjustPane=add(card,'div','vendedor-adjust');adjustPane.hidden=true;
    const adjustLabel=add(adjustPane,'label','','O que você quer mudar');
    const input=add(adjustLabel,'textarea');input.rows=3;input.maxLength=4000;input.placeholder='Escreva do seu jeito';
    add(adjustPane,'p','muted','Escreva do seu jeito. A IA reescreve seguindo a skill');
    const adjustActions=add(adjustPane,'div','vendedor-actions');
    const adjustGo=button(adjustActions,'Gerar nova sugestão',()=>{if(input.value.trim())load({adjust:input.value.trim()});},'small vendedor-primary');
    button(adjustActions,'Cancelar',()=>{adjustPane.hidden=true;});
    const indices=()=>[...selected].sort((a,b)=>a-b);
    function canSend(){return data?.send?.allowed&&!data.sentStarted&&(!data.send.openUntil||Date.parse(data.send.openUntil)>Date.now());}
    async function copy(){if(!selected.size)return;try{const all=textLines(data.suggestion);await navigator.clipboard.writeText(indices().map(i=>all[i]).join('\n'));status.textContent='Mensagens copiadas';}catch(_){status.textContent='Não consegui copiar · Tente de novo';}}
    function adjust(){adjustPane.hidden=false;input.focus();}
    function whatsapp(parent){const phone=data?.send?.phone;if(!phone)return;const a=add(parent,'a','quiet small','Abrir WhatsApp');a.href='https://wa.me/'+phone.replace(/\D/g,'');a.target='_blank';a.rel='noopener';}
    function drawActions(){
      actions.replaceChildren();if(!data?.suggestion)return;
      if(canSend()){const send=button(actions,'Enviar selecionadas ('+selected.size+')',sendSelected,'small vendedor-primary');send.disabled=busy||!selected.size;}
      const copyButton=button(actions,data.adjusted?'Copiar as mensagens':'Copiar',copy,canSend()?'quiet small':'small vendedor-primary');copyButton.disabled=!selected.size||busy;
      if(!data.sentStarted)button(actions,data.adjusted?'Ajustar de novo':'Ajustar',adjust);
      if(data.adjusted||!canSend())whatsapp(actions);
      if(busy)actions.querySelectorAll('button').forEach(b=>b.disabled=true);
    }
    function draw(){
      body.replaceChildren();if(!data?.suggestion)return;
      heat.textContent=data.suggestion.temperatura;heat.hidden=false;
      body.classList.toggle('vendedor-new',Boolean(data.adjusted));title.querySelector('h3').textContent=data.adjusted?'Nova sugestão':'Resposta sugerida';
      const all=textLines(data.suggestion);
      all.forEach((text,i)=>{
        const row=add(body,'label','vendedor-choice');
        const check=add(row,'input');check.type='checkbox';check.checked=selected.has(i);check.disabled=busy||data.sentStarted;
        const label=i<data.suggestion.mensagens.length?'Mensagem '+(i+1):'Link do site';check.setAttribute('aria-label',label);
        const content=add(row,'span','vendedor-choice-content');add(content,'span','vendedor-choice-label',label);
        add(content,'span','vendedor-bubble'+(i===data.suggestion.mensagens.length?' vendedor-link':''),text);
        if(i<data.suggestion.mensagens.length)add(content,'span','vendedor-translation',data.suggestion.mensagens[i].pt);
        check.addEventListener('change',()=>{if(check.checked)selected.add(i);else selected.delete(i);drawActions();});
      });
      const why=add(body,'p','vendedor-why');
      [['Nível',labels[data.suggestion.nivel]],['Etapa',data.suggestion.etapa],['Próximo',data.suggestion.proximo]].forEach(([label,value],i)=>{if(i)why.append(document.createTextNode(' · '));why.append(e('strong','',label+': '),document.createTextNode(value));});
      const whatsappClosed=data.send?.channel==='WHATSAPP'&&(!data.send.openUntil||Date.parse(data.send.openUntil)<=Date.now());
      warn.hidden=!whatsappClosed;drawActions();
      clearTimeout(expiry);if(data.send?.openUntil){const wait=Date.parse(data.send.openUntil)-Date.now();if(wait>0)expiry=setTimeout(()=>{if(card.isConnected)draw();},Math.min(wait+30,2147483647));}
    }
    async function sendSelected(){
      if(busy||!canSend()||!selected.size)return;
      // This click approves exactly the checked bubbles already visible with their translations
      const approved=indices(),current=data;
      busy=true;draw();status.textContent='Enviando selecionadas…';
      try{
        const result=await api(request,{action:'send',journeyId,id:current.id,fingerprint:current.fingerprint,selected:approved});
        data.sentStarted=true;status.textContent=result.simulated?'Envio simulado no preview · Nenhuma mensagem saiu':'Enviado · Aguardando resposta do cliente…';
        if(onSent)await onSent(result);
      }catch(error){
        const code=error?.code;
        if(code==='WINDOW_CLOSED'){data.send.allowed=false;data.send.openUntil=new Date().toISOString();status.textContent=WARNING;}
        else if(code==='CONVERSATION_CHANGED'||code==='SUGGESTION_CHANGED'){status.textContent='Nova mensagem recebida · Atualizando sugestão…';refreshQueued=true;}
        else{data.sentStarted=true;status.textContent='O envio não terminou · Confira a conversa antes de copiar e enviar pelo celular';}
      }finally{busy=false;draw();if(refreshQueued){refreshQueued=false;load();}}
    }
    async function load(extra={}){
      if(closed)return;if(busy){refreshQueued=true;return;}
      busy=true;adjustGo.disabled=true;
      const preserveAdjustment=!adjustPane.hidden&&!extra.adjust;
      status.textContent='Preparando sugestão…';
      try{
        const next=await api(request,{action:'suggest',journeyId,...extra});
        if(closed||!card.isConnected)return;
        if(next.skipped){lastKnownId=next.lastMessageId;if(next.from==='CUSTOMER')refreshQueued=true;card.hidden=false;body.replaceChildren();actions.replaceChildren();heat.hidden=true;warn.hidden=true;status.textContent='Aguardando resposta do cliente…';data=null;return;}
        card.hidden=false;
        const changed=!data||data.id!==next.id||data.fingerprint!==next.fingerprint;
        data=next;lastKnownId=next.lastMessageId;status.textContent='';
        if(next.pending){status.textContent='Preparando sugestão…';if(polls++<45)poll=setTimeout(()=>{if(card.isConnected)load();},2000);else retry();return;}
        polls=0;if(next.state==='ERRO'||!next.suggestion){retry();return;}
        if(changed)selected=new Set(textLines(next.suggestion).map((_,i)=>i));
        if(!preserveAdjustment)adjustPane.hidden=true;
        if(next.sentStarted)status.textContent='Envio já iniciado · Aguardando resposta do cliente…';
        busy=false;draw();
      }catch(_){retry();}
      finally{busy=false;adjustGo.disabled=false;if(refreshQueued){refreshQueued=false;load();}}
    }
    function retry(){status.textContent='Não consegui gerar agora';actions.replaceChildren();button(actions,'Tentar de novo',()=>load(input.value.trim()&&data?.suggestion?{adjust:input.value.trim()}:{retry:true}),'small');if(data?.suggestion)button(actions,'Voltar à sugestão',()=>{status.textContent='';draw();});}
    function scheduleWatch(){clearTimeout(watch);if(!closed)watch=setTimeout(checkUpdates,Math.min(5000*Math.pow(2,watchFailures),30000));}
    async function checkUpdates(){
      if(closed||!card.isConnected){card.dispose();return;}
      if(busy||watching||document.visibilityState==='hidden'||!card.parentElement?.getClientRects().length){scheduleWatch();return;}
      watching=true;
      try{
        const update=await api(request,{action:'updates',journeyId});watchFailures=0;
        if(closed||!card.isConnected)return;
        if(update.lastMessageId!==lastKnownId){
          // Refresh the thread in place, without replacing fields or moving the page
          if(onConversationChange)await onConversationChange();
          if(update.lastMessageId!==lastKnownId)await load();
        }
        if(updateFailed&&status.textContent==='Não consegui atualizar agora · Tentando novamente…')status.textContent='';updateFailed=false;
      }catch(_){watchFailures++;updateFailed=true;if(!busy)status.textContent='Não consegui atualizar agora · Tentando novamente…';}
      finally{watching=false;scheduleWatch();}
    }
    card.refresh=()=>{clearTimeout(poll);polls=0;return load();};
    card.dispose=()=>{closed=true;clearTimeout(poll);clearTimeout(expiry);clearTimeout(watch);};
    card.addEventListener('click',event=>event.stopPropagation());
    queueMicrotask(()=>{if(card.isConnected){load();scheduleWatch();}});
    return card;
  }
  async function settings(root,{request}={}){
    if(!root||root.dataset.loading==='true')return;root.dataset.loading='true';
    try{renderSettings(root,await api(request,{action:'settings'}),request);}
    catch(_){root.replaceChildren(e('h3','','Vendedor IA'),e('p','status','Não consegui carregar agora'));button(root,'Tentar de novo',()=>settings(root,{request}));}
    finally{delete root.dataset.loading;}
  }
  function renderSettings(root,data,request){
    root.replaceChildren();add(root,'h3','','Vendedor IA');
    const active=data.active;if(!active){add(root,'p','status','Instrução indisponível');return;}
    const meta=add(root,'dl','vendedor-meta');
    const date=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/New_York',dateStyle:'short',timeStyle:'short'}).format(new Date(active.criado_em));
    [['Nome',active.nome],['Atualizada em',date],['Versão',String(active.versao)],['IA','Anthropic (Claude Sonnet)']].forEach(([k,v])=>{add(meta,'dt','',k);add(meta,'dd','',v);});
    add(root,'h4','','Texto da skill');add(root,'pre','vendedor-skill',active.conteudo);
    add(root,'p','muted','Quando a skill mudar no Claude, cole o texto novo aqui. O painel passa a usar na hora');
    const status=add(root,'p','status');status.setAttribute('role','status');
    const actions=add(root,'div','vendedor-actions');
    const pane=add(root,'div','vendedor-version-pane');pane.hidden=true;
    let selected=(data.versions||[]).find(v=>v.versao<active.versao)||null;
    button(actions,'Colar versão nova',()=>{
      pane.hidden=false;pane.replaceChildren();const label=add(pane,'label','','Cole o texto inteiro da skill');const field=add(label,'textarea');field.rows=12;field.maxLength=100000;
      const controls=add(pane,'div','vendedor-actions');
      button(controls,'Salvar nova versão',async event=>{if(!field.value.trim()){status.textContent='Cole o texto da skill';return;}await save(event.currentTarget,{action:'save',content:field.value});},'small vendedor-primary');
      button(controls,'Cancelar',()=>{pane.hidden=true;});field.focus();
    },'small vendedor-primary');
    const previous=button(actions,'Ver anterior',()=>{
      pane.hidden=false;pane.replaceChildren();const label=add(pane,'label','','Versão anterior');const select=add(label,'select');
      (data.versions||[]).filter(v=>v.id!==active.id).forEach(v=>{const o=add(select,'option','','Versão '+v.versao);o.value=v.id;});
      const preview=add(pane,'pre','vendedor-skill');
      const show=()=>{selected=data.versions.find(v=>v.id===select.value);preview.textContent=selected?.conteudo||'';};select.addEventListener('change',show);show();
    });previous.disabled=!selected;
    const restore=button(actions,'Restaurar',async event=>{
      if(!selected)return;await save(event.currentTarget,{action:'restore',versionId:selected.id});
    });restore.disabled=!selected;
    async function save(control,payload){control.disabled=true;status.textContent='Salvando…';try{const next=await api(request,payload);renderSettings(root,next,request);root.querySelector('.status').textContent=payload.action==='restore'?'Versão restaurada':'Nova versão ativa';}catch(_){status.textContent='Não consegui salvar · Tente de novo';control.disabled=false;}}
  }
  window.MCSVendedor={box,settings,textLines};
})();
