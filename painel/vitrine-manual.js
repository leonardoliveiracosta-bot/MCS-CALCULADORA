(() => {
  'use strict';
  const mounted=new WeakSet();
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(cents/100);
  const reasons={MANUAL_NO_BATCH:'Importe um lote antes de escolher os carros',MANUAL_VIN_INVALID:'Digite o VIN completo ou pelo menos os últimos 6 caracteres',MANUAL_PHONE_INVALID:'Confira o WhatsApp, incluindo o código do país',MANUAL_CAR_UNAVAILABLE:'Um dos carros não está mais disponível no lote. Busque o VIN novamente',MANUAL_PRICE_INVALID:'O acréscimo precisa estar entre 0 e 50%',VITRINE_LIMIT_INVALID:'Confira o limite: de US$ 1,000 a US$ 10,000,000, ou deixe em branco',MANUAL_DRAFT_CHANGED:'O conteúdo mudou. Comece uma nova apresentação',MANUAL_CARS_INVALID:'Escolha os carros antes de gerar'};
  const errorText=error=>reasons[error?.code]||'Não consegui concluir agora. Tente de novo';
  function action(text,callback,quiet=false){const b=el('button',quiet?'quiet small':'small',text);b.type='button';b.addEventListener('click',callback);return b;}
  function links(root,item){
    const url=location.origin+item.link;
    const body=el('label','','Mensagem para acompanhar o link (editável)');const message=el('textarea');message.rows=2;message.value=item.version==='V2'?'Here are the photos and details for this car':'Here are some cars worth a look';body.append(message);
    const link=el('a','small','Ver '+item.version);link.href=url;link.target='_blank';link.rel='noopener';
    const buttons=el('div','inline-actions'),status=el('p','muted');const text=()=>message.value.trim()+'\n'+url;
    buttons.append(link,action('Copiar mensagem',async()=>{try{await navigator.clipboard.writeText(text());status.textContent='Mensagem e link copiados';}catch(_){status.textContent='Não consegui copiar. Abra a apresentação e copie o link';}},true));
    if(item.phone){const wa=el('a','small','Enviar pelo WhatsApp');wa.target='_blank';wa.rel='noopener';const update=()=>{wa.href='https://wa.me/'+item.phone.replace(/\D/g,'')+'?text='+encodeURIComponent(text());};update();message.addEventListener('input',update);buttons.append(wa);}
    if(navigator.share)buttons.append(action('Compartilhar',async()=>{try{await navigator.share({text:text()});}catch(error){if(error.name!=='AbortError')status.textContent='Use Copiar mensagem para compartilhar';}},true));
    root.append(body,buttons,status);
  }
  function mount({root,version,request,resizePhoto}){
    if(!root||mounted.has(root))return;mounted.add(root);
    const top=el('div','inline-actions'),content=el('div'),past=el('div');past.hidden=true;root.append(top,content,past);let working=false;
    const setWorking=value=>{working=value;top.querySelectorAll('button').forEach(button=>button.disabled=value);};
    const release=[];const cleanup=()=>{release.splice(0).forEach(url=>URL.revokeObjectURL(url));};
    const open=()=>{
      if(working)return;cleanup();content.replaceChildren();past.hidden=true;
      const form=el('section','manual-vitrine-form'),selected=[],photos=[],uploaded=new Set();let key=crypto.randomUUID(),created=null,busy=false;
      const fields=[];const field=(text,type='text')=>{const label=el('label','',text),input=el(type==='textarea'?'textarea':'input');if(type!=='textarea')input.type=type;label.append(input);fields.push(input);form.append(label);return input;};
      form.append(el('h3','','Nova '+version),el('p','muted','Escolha os carros e gere a apresentação para compartilhar com qualquer pessoa'));
      const name=field('Nome do destinatário (opcional)');name.autocomplete='name';name.maxLength=80;
      const phone=field('WhatsApp (opcional, com código do país)','tel');phone.autocomplete='tel';phone.placeholder='+1 305 555 0100';
      const searchLine=el('div','manual-vitrine-search'),searchLabel=el('label','','VIN completo ou últimos 6 caracteres'),vin=el('input');vin.type='text';vin.maxLength=17;vin.autocomplete='off';searchLabel.append(vin);
      const found=el('div','stack'),chosen=el('div','stack'),status=el('p','muted');status.setAttribute('role','status');
      const search=action('Buscar carro',async()=>{
        if(busy||search.disabled)return;search.disabled=true;found.replaceChildren();status.textContent='Buscando no lote…';
        try{const data=await request('/api/panel/manual-vitrines?vin='+encodeURIComponent(vin.value.trim()));
          if(!form.isConnected)return;status.textContent=data.cars.length?'':'Não encontrei carro elegível com esse VIN no lote ativo';
          data.cars.forEach(car=>{const row=el('div','manual-vitrine-car');row.append(el('strong','',car.name),el('p','muted','VIN '+car.vin+' · '+money(car.referenceCents)));
            const add=action('Escolher',()=>{if(selected.some(one=>one.id===car.id))return;if(selected.length>=(version==='V2'?1:10)){status.textContent=version==='V2'?'A V2 apresenta um carro. Remova o atual para trocar':'Até 10 carros por V1';return;}selected.push({...car});found.replaceChildren();paint();status.textContent='';});fields.push(add);row.append(add);found.append(row);});
        }catch(error){if(form.isConnected)status.textContent=errorText(error);}finally{search.disabled=busy;}
      });fields.push(vin,search);searchLine.append(searchLabel,search);form.append(searchLine,found,el('h4','','Carros escolhidos'),chosen);
      function paint(){chosen.replaceChildren();selected.forEach((car,index)=>{const row=el('div','manual-vitrine-car');row.append(el('strong','',car.name),el('p','muted','VIN final '+car.vin.slice(-6)));
        const label=el('label','','Acréscimo sobre o MMR (%)'),pct=el('input');pct.type='number';pct.min='0';pct.max='50';pct.step='0.01';pct.value=car.pct;label.append(pct);fields.push(pct);const price=el('p','', 'Referência para o cliente: '+money(car.referenceCents));
        pct.addEventListener('input',()=>{car.pct=pct.value;const p=window.MCSManheimOffer.validPct(pct.value);price.textContent=Number.isNaN(p)?'Confira o acréscimo':'Referência para o cliente: '+money(window.MCSManheimOffer.priceFor(car.mmrCents,p).finalCents);});
        const remove=action('Remover',()=>{selected.splice(index,1);paint();},true);fields.push(remove);row.append(label,price,remove);chosen.append(row);});}
      let limit=null,note=null;
      if(version==='V2'){
        limit=field('Limite do cliente (US$, opcional)');limit.inputMode='decimal';
        note=field('Nota para o cliente (opcional)','textarea');note.rows=2;note.maxLength=800;
        const label=el('label','','Fotos (até 12, primeira foto como capa)'),input=el('input');input.type='file';input.accept='image/*';input.multiple=true;label.append(input);fields.push(input);const thumbs=el('div','v2-thumbs');form.append(label,thumbs);
        const paintPhotos=()=>{thumbs.replaceChildren();photos.forEach((photo,index)=>{const row=el('div','v2-thumb'),image=el('img');image.src=photo.url;image.alt='Foto '+(index+1);const remove=action('Remover',()=>{photos.splice(index,1);paintPhotos();},true);fields.push(remove);row.append(image,remove);thumbs.append(row);});};
        input.addEventListener('change',async()=>{input.disabled=true;generate.disabled=true;setWorking(true);status.textContent='Preparando fotos…';try{for(const file of input.files){if(photos.length>=12){status.textContent='Máximo de 12 fotos';break;}const blob=await resizePhoto(file);const url=URL.createObjectURL(blob);release.push(url);photos.push({blob,url});}paintPhotos();status.textContent='';}catch(_){status.textContent='Uma foto não abriu. Use JPEG ou PNG';}finally{input.value='';input.disabled=false;generate.disabled=false;setWorking(false);}});
      }
      const output=el('div','manual-vitrine-result'),generate=action('Gerar '+version,async()=>{
        if(busy)return;if(!selected.length){status.textContent='Escolha ao menos um carro';return;}if(fields.some(input=>input.checkValidity&&!input.checkValidity())){status.textContent='Confira os campos preenchidos';return;}
        busy=true;setWorking(true);generate.disabled=true;fields.forEach(input=>input.disabled=true);status.textContent='Gerando '+version+'…';
        try{
          created=created||await request('/api/panel/manual-vitrines',{method:'POST',body:JSON.stringify({version,requestKey:key,name:name.value,phone:phone.value,cars:selected.map(car=>({id:car.id,pct:car.pct})),customerLimitCents:limit?.value.trim()||null,note:note?.value||null})});
          for(let i=0;i<photos.length;i++){if(uploaded.has(photos[i].blob))continue;status.textContent='Enviando foto '+(i+1)+' de '+photos.length+'…';await request('/api/panel/vitrine-photos?vitrineId='+encodeURIComponent(created.vitrineId)+'&carId='+encodeURIComponent(created.cars[0].id),{method:'POST',headers:{'content-type':'application/octet-stream'},body:photos[i].blob});uploaded.add(photos[i].blob);}
          status.textContent=version+' pronta'+(created.name?' para '+created.name:'')+'. Escolha como compartilhar';output.replaceChildren();links(output,created);generate.textContent=version+' gerada';
        }catch(error){status.textContent=created?'Não terminei as fotos. Tente de novo para continuar na mesma V2':errorText(error);generate.disabled=false;if(!created)fields.forEach(input=>input.disabled=false);}
        finally{busy=false;setWorking(false);}
      });
      form.append(generate,status,output,action('Cancelar',()=>{if(busy)return;cleanup();content.replaceChildren();},true));content.append(form);name.focus();
    };
    top.append(action('Criar '+version,open),action('Histórico de criações',async()=>{
      if(working)return;if(!past.hidden){past.hidden=true;return;}past.hidden=false;past.replaceChildren(el('p','muted','Carregando…'));
      try{const data=await request('/api/panel/manual-vitrines?version='+version);past.replaceChildren();if(!data.items.length)past.append(el('p','muted','Nenhuma apresentação criada por aqui ainda'));
        data.items.forEach(item=>{const row=el('details','manual-vitrine-history'),head=el('summary','', [item.name||'Sem destinatário',item.phone,item.cars.map(car=>car.name).join(' · ')].filter(Boolean).join(' · '));row.append(head,el('p','muted',new Date(item.createdAt).toLocaleString('pt-BR')));row.addEventListener('toggle',()=>{if(row.open&&!row.dataset.ready){row.dataset.ready='1';if(Date.parse(item.expiresAt)<=Date.now())row.append(el('p','muted','Apresentação expirada'));else links(row,item);}});past.append(row);});
      }catch(error){past.replaceChildren(el('p','status error',errorText(error)));}
    },true));
  }
  window.MCSManualVitrines={mount};
})();
