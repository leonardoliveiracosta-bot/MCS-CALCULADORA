(function () {
  'use strict';
  var copy = {
    en: { button:'Have us contact you', title:'Have us contact you', name:'Your name', phone:'Phone number', country:'Outside the US, include your country code.', how:'How would you like to talk?', call:'Call', consent:'By submitting, you agree to be contacted about your car search.', submit:'CONTACT ME', sending:'SENDING…', success:'Request received. Our team will contact you.', error:'Could not send your request. Please try again.', invalid:'Check your name and phone number.', rate:'Please wait a few minutes and try again.', close:'Close' },
    pt: { button:'Prefiro que me chamem', title:'Prefiro que me chamem', name:'Seu nome', phone:'Telefone', country:'Fora dos EUA, inclua o código do país.', how:'Como prefere falar?', call:'Ligação', consent:'Ao enviar, você autoriza nosso contato sobre sua busca.', submit:'QUERO RECEBER CONTATO', sending:'ENVIANDO…', success:'Pedido recebido. Nossa equipe entrará em contato.', error:'Não conseguimos enviar seu pedido. Tente novamente.', invalid:'Confira seu nome e telefone.', rate:'Aguarde alguns minutos e tente novamente.', close:'Fechar' },
    es: { button:'Prefiero que me contacten', title:'Prefiero que me contacten', name:'Tu nombre', phone:'Teléfono', country:'Fuera de EE. UU., incluye el código de país.', how:'¿Cómo prefieres hablar?', call:'Llamada', consent:'Al enviar, autorizas nuestro contacto sobre tu búsqueda.', submit:'QUIERO QUE ME CONTACTEN', sending:'ENVIANDO…', success:'Solicitud recibida. Nuestro equipo te contactará.', error:'No pudimos enviar tu solicitud. Intenta de nuevo.', invalid:'Revisa tu nombre y teléfono.', rate:'Espera unos minutos e intenta de nuevo.', close:'Cerrar' }
  };
  var dialog, form, message, submit, source, language, pending=false, sent=false, requestId='', fingerprint='';
  function lang(){return (document.documentElement.lang || 'en').split('-')[0];}
  function current(){return copy[language || lang()] || copy.en;}
  function uuid(){return crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,function(c){return (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16);});}
  function translate(){
    var text=current();
    document.querySelectorAll('[data-mcs-contact-request]').forEach(function(b){b.textContent=(copy[lang()]||copy.en).button;});
    if(!dialog)return;
    dialog.querySelectorAll('[data-contact-copy]').forEach(function(el){el.textContent=text[el.dataset.contactCopy];});
    dialog.querySelector('.mcs-contact-close').setAttribute('aria-label',text.close);
    submit.textContent=pending?text.sending:text.submit;
    if(sent)message.textContent=text.success;
  }
  function create(){
    dialog=document.createElement('dialog');dialog.className='mcs-contact-dialog';dialog.setAttribute('aria-labelledby','mcs-contact-title');
    dialog.innerHTML='<button type="button" class="mcs-contact-close">×</button><h2 id="mcs-contact-title" data-contact-copy="title"></h2><form><label><span data-contact-copy="name"></span><input name="name" autocomplete="name" required minlength="2" maxlength="80"></label><label><span data-contact-copy="phone"></span><input name="phone" type="tel" autocomplete="tel" required maxlength="25" placeholder="+1 (___) ___-____"><small data-contact-copy="country"></small></label><fieldset><legend data-contact-copy="how"></legend><div class="mcs-contact-channels"><label><input type="radio" name="channel" value="SMS">SMS</label><label><input type="radio" name="channel" value="WHATSAPP" checked>WhatsApp</label><label><input type="radio" name="channel" value="CALL"><span data-contact-copy="call"></span></label></div></fieldset><div class="mcs-contact-trap" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div><p class="mcs-contact-consent" data-contact-copy="consent"></p><button type="submit" class="mcs-contact-submit" data-contact-copy="submit"></button></form><p class="mcs-contact-message" role="status" aria-live="polite"></p>';
    document.body.appendChild(dialog);form=dialog.querySelector('form');message=dialog.querySelector('.mcs-contact-message');submit=dialog.querySelector('[type=submit]');
    dialog.querySelector('.mcs-contact-close').addEventListener('click',function(){dialog.close();});
    form.addEventListener('submit',async function(event){
      event.preventDefault();if(pending||sent)return;
      var data=new FormData(form), name=String(data.get('name')||'').trim(),phone=String(data.get('phone')||'').trim(),digits=phone.replace(/\D/g,'');
      if(name.length<2||/[<>\u0000-\u001f]/.test(name)||!/^[+\d\s().-]+$/.test(phone)||digits.length<8||digits.length>15||(!phone.startsWith('+')&&digits.length!==10&&!(digits.length===11&&digits[0]==='1'))){message.setAttribute('role','alert');message.textContent=current().invalid;return;}
      var body={name:name,phone:phone,channel:data.get('channel'),language:language,source:source,consent:true,website:String(data.get('website')||'')};
      var next=JSON.stringify(body);if(next!==fingerprint){requestId=uuid();fingerprint=next;}body.requestId=requestId;
      pending=true;submit.disabled=true;message.textContent='';translate();
      var controller=new AbortController(),timer=setTimeout(function(){controller.abort();},20000);
      try{
        var response=await fetch('/api/contact-request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
        var result=await response.json();
        if(!response.ok||result.ok!==true){if(response.status===409)fingerprint='';throw {rate:response.status===429};}
        sent=true;form.hidden=true;message.setAttribute('role','status');message.textContent=current().success;
      }catch(error){message.setAttribute('role','alert');message.textContent=error.rate?current().rate:current().error;}
      finally{clearTimeout(timer);pending=false;submit.disabled=false;translate();}
    });
  }
  document.querySelectorAll('[data-mcs-contact-request]').forEach(function(button){
    button.addEventListener('click',function(){
      source=button.dataset.mcsContactRequest;language=lang();if(!copy[language])language='en';if(!dialog)create();
      if(sent){form.reset();form.hidden=false;sent=false;requestId='';fingerprint='';}
      message.textContent='';translate();dialog.showModal();
    });
  });
  translate();new MutationObserver(translate).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
})();
