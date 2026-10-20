(() => {
  'use strict';
  const e=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const add=(p,tag,cls,text)=>{const n=e(tag,cls,text);p.append(n);return n;};
  const button=(p,text,run,cls='quiet small')=>{const n=add(p,'button',cls,text);n.type='button';n.addEventListener('click',run);return n;};
  const api=(request,body)=>request('/api/panel/vendedor',{method:'POST',timeoutMs:65000,body:JSON.stringify(body)});
  const labels={inconsciente:'inconsciente',problema:'consciente do problema',solucao:'consciente da solução',compra:'consciente da compra'};
  const WARNING='Fora da janela de 24 h do WhatsApp: o painel não consegue enviar. Copie e mande pelo app do celular';
  const textLines=s=>s.mensagens.map(m=>m.texto).concat(s.link?['mycarscout.net']:[]);
  function box(journeyId,{request,onSent}={}) {
    const card=e('section','lead-card vendedor-card');card.setAttribute('aria-label','Resposta sugerida');
    let data=null,busy=false,closed=false,poll=null,expiry=null,polls=0;
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
    function canSend(){return data?.send?.allowed&&!data.sentStarted&&(!data.send.openUntil||Date.parse(data.send.openUntil)>Date.now());}
    async function copy(){try{await navigator.clipboard.writeText(textLines(data.suggestion).join('\n'));status.textContent='Mensagens copiadas';}catch(_){status.textContent='Não consegui copiar · Tente de novo';}}
    function adjust(){adjustPane.hidden=false;input.focus();}
    function whatsapp(parent){const phone=data?.send?.phone;if(!phone)return;const a=add(parent,'a','quiet small','Abrir WhatsApp');a.href='https://wa.me/'+phone.replace(/\D/g,'');a.target='_blank';a.rel='noopener';}
    function draw(){
      body.replaceChildren();actions.replaceChildren();
      if(!data?.suggestion)return;
      heat.textContent=data.suggestion.temperatura;heat.hidden=false;
      body.classList.toggle('vendedor-new',Boolean(data.adjusted));title.querySelector('h3').textContent=data.adjusted?'Nova sugestão':'Resposta sugerida';
      data.suggestion.mensagens.forEach(m=>{add(body,'p','vendedor-bubble',m.texto);add(body,'p','vendedor-translation',m.pt);});
      if(data.suggestion.link)add(body,'p','vendedor-bubble vendedor-link','mycarscout.net');
      const why=add(body,'p','vendedor-why');
      [['Nível',labels[data.suggestion.nivel]],['Etapa',data.suggestion.etapa],['Próximo',data.suggestion.proximo]].forEach(([label,value],i)=>{if(i)why.append(document.createTextNode(' · '));why.append(e('strong','',label+': '),document.createTextNode(value));});
      const whatsappClosed=data.send?.channel==='WHATSAPP'&&(!data.send.openUntil||Date.parse(data.send.openUntil)<=Date.now());
      warn.hidden=!whatsappClosed;
      if(data.adjusted){
        button(actions,'Copiar as mensagens',copy,'small vendedor-primary');
        button(actions,'Ajustar de novo',adjust);whatsapp(actions);
        if(canSend())button(actions,'Revisar e enviar',review);
      }else{
        button(actions,canSend()?'Revisar e enviar':'Copiar',canSend()?review:copy,'small vendedor-primary');
        button(actions,'Ajustar',adjust);
        if(canSend())button(actions,'Copiar',copy);else whatsapp(actions);
      }
      if(data.sentStarted){actions.querySelectorAll('button').forEach(b=>{if(/Ajustar|Revisar/.test(b.textContent))b.hidden=true;});status.textContent='Envio já iniciado nesta sugestão · Confira a conversa antes de mandar pelo app';}
      clearTimeout(expiry);
      if(data.send?.openUntil){const wait=Date.parse(data.send.openUntil)-Date.now();if(wait>0)expiry=setTimeout(()=>{if(card.isConnected)draw();},Math.min(wait+30,2147483647));}
    }
    async function review(){
      if(busy||!canSend())return;
      busy=true;status.textContent='Conferindo a janela…';
      try{const fresh=await api(request,{action:'window',journeyId});data.send=fresh.send;draw();}
      catch(_){status.textContent='Não consegui verificar o envio agora';busy=false;return;}
      busy=false;if(!canSend()){status.textContent='';return;}status.textContent='';
      const modal=add(card,'dialog','vendedor-review');
      add(modal,'h3','','Revisar e enviar');add(modal,'p','muted','Para '+(data.send.name||'')+' · '+(data.send.phone||''));
      data.suggestion.mensagens.forEach(m=>{add(modal,'p','vendedor-bubble',m.texto);add(modal,'p','vendedor-translation',m.pt);});
      if(data.suggestion.link)add(modal,'p','vendedor-bubble','mycarscout.net');
      const note=add(modal,'p','status');note.setAttribute('role','status');
      const buttons=add(modal,'div','vendedor-actions');let sending=false;
      const cancel=button(buttons,'Voltar',()=>modal.close());
      const send=button(buttons,'Enviar as mensagens',async()=>{
        if(sending||!canSend())return;
        sending=true;send.disabled=true;cancel.disabled=true;note.textContent='Enviando uma mensagem de cada vez…';
        try{
          const result=await api(request,{action:'send',journeyId,id:data.id,fingerprint:data.fingerprint});
          data.sentStarted=true;status.textContent=result.simulated?'Envio simulado no preview · Nenhuma mensagem saiu':'Mensagens enviadas';
          modal.close();draw();status.textContent=result.simulated?'Envio simulado no preview · Nenhuma mensagem saiu':'Mensagens enviadas';if(onSent)onSent(result);
        }catch(error){
          const code=error?.code;
          note.textContent=code==='WINDOW_CLOSED'?WARNING:code==='CONVERSATION_CHANGED'||code==='SUGGESTION_CHANGED'?'A conversa mudou · Feche e abra o lead para revisar novamente':'O envio não terminou · Confira a conversa antes de copiar e enviar pelo celular';
          // No blind retry after a partial send, timeout, or response lost in transit
          data.sentStarted=true;draw();send.hidden=true;cancel.disabled=false;cancel.textContent='Fechar';
        }finally{sending=false;}
      },'small vendedor-primary');
      modal.addEventListener('cancel',event=>{if(sending)event.preventDefault();});
      modal.addEventListener('close',()=>modal.remove(),{once:true});modal.showModal();
    }
    async function load(extra={}){
      if(busy||closed)return;busy=true;adjustGo.disabled=true;status.textContent='Preparando sugestão…';
      try{
        const next=await api(request,{action:'suggest',journeyId,...extra});
        if(closed||!card.isConnected)return;
        if(next.skipped){card.hidden=true;return;}
        card.hidden=false;data=next;status.textContent='';
        if(next.pending){
          status.textContent='Preparando sugestão…';
          if(polls++<45)poll=setTimeout(()=>{if(card.isConnected)load();},2000);
          else retry();
          return;
        }
        polls=0;
        if(next.state==='ERRO'||!next.suggestion){retry();return;}
        adjustPane.hidden=true;draw();
      }catch(_){retry();}
      finally{busy=false;adjustGo.disabled=false;}
    }
    function retry(){status.textContent='Não consegui gerar agora';actions.replaceChildren();button(actions,'Tentar de novo',()=>load(input.value.trim()&&data?.suggestion?{adjust:input.value.trim()}:{retry:true}),'small');if(data?.suggestion)button(actions,'Voltar à sugestão',()=>{status.textContent='';draw();});}
    card.refresh=()=>{clearTimeout(poll);polls=0;load();};
    card.dispose=()=>{closed=true;clearTimeout(poll);clearTimeout(expiry);};
    card.addEventListener('click',event=>event.stopPropagation());
    // Mounts are synchronous; start only after the caller attaches the card
    queueMicrotask(()=>{if(card.isConnected)load();});
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
