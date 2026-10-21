(function(){
  'use strict';
  const node=(parent,tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text)el.textContent=text;parent.append(el);return el;};
  function attach(parent,{request,journeyId,ref,openingId}){
    const details=node(parent,'details','lead-access');
    const summary=node(details,'summary','','Acessos · +');
    const body=node(details,'div','lead-access-body');
    const target=journeyId?{journeyId}:{ref};
    let recordingError=false,loading=false;
    const register=()=>request('/api/panel/lead-access',{method:'POST',body:JSON.stringify({...target,openingId})})
      .then(()=>{recordingError=false;},()=>{recordingError=true;})
      .then(()=>{summary.textContent='Acessos · '+(details.open?'−':'+')+(recordingError?' · registro pendente':'');});
    let recording=register();
    async function load(offset=0,until=null){
      if(loading)return;loading=true;
      if(!offset)body.replaceChildren();
      const progress=node(body,'p','muted','Consultando acessos…');
      try{
        await recording;
        if(recordingError){
          const warning=node(body,'p','status error','Não consegui registrar este acesso');
          const retry=node(warning,'button','quiet small','Tentar de novo');retry.type='button';
          retry.addEventListener('click',async()=>{if(loading)return;retry.disabled=true;recording=register();await recording;await load();});
        }
        const page=await request('/api/panel/lead-access?'+new URLSearchParams({...target,offset,...(until?{until}:{})}));
        if(!Array.isArray(page.items))throw Error('INVALID_HISTORY');
        if(!offset)node(body,'p','muted','Horário da Flórida');
        const list=body.querySelector('.lead-access-list')||node(body,'ul','lead-access-list');
        const format=new Intl.DateTimeFormat('pt-BR',{timeZone:page.timezone||'America/New_York',dateStyle:'short',timeStyle:'medium'});
        page.items.forEach(item=>{const line=node(list,'li');node(line,'strong','',item.display_name);node(line,'span','muted','LOGIN: '+item.login_email);const time=node(line,'time','',format.format(new Date(item.accessed_at)));time.dateTime=item.accessed_at;});
        if(!offset&&!page.items.length)node(body,'p','muted','Nenhum acesso registrado');
        if(page.nextOffset!==null&&page.nextOffset!==undefined){const more=node(body,'button','quiet small','Ver mais antigos');more.type='button';more.addEventListener('click',()=>{if(loading)return;more.remove();load(page.nextOffset,page.until);});}
      }catch(_){
        const message=node(body,'p','status error','Não consegui consultar os acessos');
        const retry=node(message,'button','quiet small','Tentar de novo');retry.type='button';
        retry.addEventListener('click',()=>{if(loading)return;message.remove();load(offset,until);});
      }finally{progress.remove();loading=false;}
    }
    details.addEventListener('toggle',()=>{summary.textContent='Acessos · '+(details.open?'−':'+')+(recordingError?' · registro pendente':'');if(details.open)load();});
    return details;
  }
  window.MCSLeadAccess={attach};
})();
