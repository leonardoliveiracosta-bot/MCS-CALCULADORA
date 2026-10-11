(function(root){
  'use strict';
  let sequence=0,epoch=0,items=[],recent=[],nextOffset=null,request=null,busy=new Set(),visibleLimit=50;
  const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
  const channelName={SMS:'SMS',WHATSAPP:'WhatsApp',CALL:'Ligação'};
  const date=value=>{try{return new Date(value).toLocaleString('pt-BR',{timeZone:'America/New_York',dateStyle:'short',timeStyle:'short'});}catch(_){return '';}};
  const box=()=>document.getElementById('site-contact-requests');
  function note(text,error=false){const node=box()?.querySelector('.site-contact-state');if(node){node.textContent=text;node.className='site-contact-state '+(error?'error':'muted');}}
  function link(text,url){const a=el('a','quiet small',text);a.href=url;return a;}
  function card(item,closed=false){
    const row=el('article','queue-item site-contact-item');row.dataset.requestId=item.id;
    const head=el('header','');head.append(el('strong','',item.name),el('span','badge',closed?(item.status==='CONTACTED'?'Contatado':'Arquivado'):'Pediu contato · '+channelName[item.channel]));
    row.append(head,el('p','muted',item.phone_e164+' · '+date(item.created_at)+' · '+({pt:'Português',es:'Espanhol',en:'Inglês'}[item.language]||item.language)));
    const actions=el('div','inline-actions');
    if(!closed){
      let contact;
      if(item.channel==='CALL')contact=link('Ligar','tel:'+item.phone_e164);
      else if(item.channel==='SMS'){
        contact=link('Abrir SMS',root.MCSWaHandoff?.smsUrl(item.phone_e164,'')||'sms:'+item.phone_e164);
        contact.addEventListener('click',event=>{if(root.MCSWaHandoff&&!root.MCSWaHandoff.isPhone()){event.preventDefault();root.MCSWaHandoff.openModal(contact.href,request,{sms:true});}});
      }else{
        contact=link('Abrir WhatsApp','https://wa.me/'+item.phone_e164.replace(/\D/g,''));contact.target='_blank';contact.rel='noopener';
      }
      actions.append(contact);
      if(item.channel==='WHATSAPP')root.MCSWaHandoff?.attach(contact,{request});
      const copy=el('button','quiet small','Copiar telefone');copy.type='button';copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(item.phone_e164);note('Telefone copiado');}catch(_){note('Não consegui copiar · selecione o telefone acima',true);}});actions.append(copy);
    }
    (closed?[['Desfazer','OPEN']]:[['Marcar como contatado','CONTACTED'],['Arquivar','ARCHIVED']]).forEach(([label,status])=>{
      const button=el('button','quiet small',label);button.type='button';button.disabled=busy.has(item.id);
      button.addEventListener('click',async()=>{
        if(busy.has(item.id))return;const owner=epoch;busy.add(item.id);row.querySelectorAll('button').forEach(b=>b.disabled=true);note('Salvando…');
        try{await request('/api/panel/contact-requests',{method:'POST',body:JSON.stringify({id:item.id,status,expectedStatus:item.status})});
          if(owner!==epoch)return;busy.delete(item.id);const updated={...item,status};items=items.filter(x=>x.id!==item.id);recent=recent.filter(x=>x.id!==item.id);
          if(status==='OPEN')items.unshift(updated);else recent.unshift(updated);
          render();const refreshed=await load(request);if(owner!==epoch)return;if(refreshed)note(status==='OPEN'?'Pedido retomado':status==='CONTACTED'?'Marcado como contatado':'Pedido arquivado');else note('Pedido salvo · não consegui atualizar a lista · tente novamente',true);
        }catch(_){if(owner!==epoch)return;note('Não consegui salvar · tente novamente',true);row.querySelectorAll('button').forEach(b=>b.disabled=false);}
        finally{busy.delete(item.id);row.querySelectorAll('button').forEach(b=>b.disabled=false);}
      });actions.append(button);
    });
    row.append(actions);return row;
  }
  function render(){
    const host=box();if(!host)return;host.classList.toggle('hidden',!items.length&&!recent.length);const list=host.querySelector('.site-contact-list');list.replaceChildren();items.slice(0,visibleLimit).forEach(item=>list.append(card(item)));
    const more=host.querySelector('.site-contact-more');more.hidden=!nextOffset;more.disabled=false;
    const done=host.querySelector('.site-contact-recent');done.hidden=!recent.length;done.querySelector('summary').textContent='Já resolvidos · últimos 7 dias';const resolved=done.querySelector('.site-contact-resolved');resolved.replaceChildren();recent.slice(0,20).forEach(item=>resolved.append(card(item,true)));
  }
  async function load(fetcher){
    request=fetcher;const seq=++sequence;
    try{const data=await request('/api/panel/contact-requests');if(seq!==sequence)return;
      if(!Array.isArray(data.items)||!Array.isArray(data.recent))throw Error('INVALID_RESPONSE');
      if(busy.size)return;items=data.items;recent=data.recent;nextOffset=data.nextOffset;visibleLimit=50;render();note('');return true;
    }catch(_){if(seq!==sequence)return;box()?.classList.remove('hidden');note('Não consegui carregar os pedidos de contato · tente novamente',true);return false;}
  }
  function clear(){sequence++;epoch++;items=[];recent=[];nextOffset=null;busy.clear();render();note('');}
  const host=box();if(host){
    host.querySelector('.site-contact-retry').addEventListener('click',()=>request&&load(request));
    host.querySelector('.site-contact-more').addEventListener('click',async function(){
      if(nextOffset===null||!request)return;const seq=sequence,offset=nextOffset;this.disabled=true;
      try{const data=await request('/api/panel/contact-requests?offset='+offset);if(seq!==sequence)return;if(!Array.isArray(data.items))throw Error('INVALID_RESPONSE');const map=new Map(items.map(x=>[x.id,x]));data.items.forEach(x=>map.set(x.id,x));items=[...map.values()];visibleLimit=items.length;nextOffset=data.nextOffset;render();note('');}
      catch(_){if(seq===sequence)note('Não consegui carregar mais pedidos · tente novamente',true);}finally{this.disabled=false;}
    });
  }
  root.MCSSiteRequests={load,clear};
})(window);
