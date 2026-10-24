(function(){
  'use strict';
  var model=window.MCSFinance,contactModel=window.MCSFinanceContact,form=document.getElementById('finance-form'),answers={},attempted=false,busy=false,requestId=null,saved=null;
  var nameInput=document.getElementById('finance-name'),phoneInput=document.getElementById('finance-phone'),consentInput=document.getElementById('finance-consent');
  function contact(){return {name:nameInput.value,phone:phoneInput.value,consent:consentInput.checked};}
  [nameInput,phoneInput,consentInput].forEach(function(input){input.addEventListener('input',function(){requestId=null;document.getElementById('finance-save-error').classList.remove('on');});});
  function lang(){return document.documentElement.lang;}
  Object.keys(model.copies).forEach(function(language){var c=model.copy(language),keys={finance_gate:c.gate,finance_gate_sub:c.gate_sub};['eyebrow','title','subtitle','intro','ready','cta','fine'].forEach(function(key){keys['finance_'+key]=c[key];});Object.assign(I18N[language],keys);});
  model.fields.forEach(function(field,i){
    var group=document.createElement('fieldset');group.className='finance-question';group.dataset.financeField=field;
    group.innerHTML='<legend id="finance-label-'+field+'"></legend><p class="finance-help" id="finance-help-'+field+'"></p><div class="finance-chips"></div><p class="err" id="finance-error-'+field+'" role="alert"></p>';
    group.setAttribute('aria-describedby','finance-help-'+field+' finance-error-'+field);
    model.options[field].forEach(function(value){var label=document.createElement('label');label.className='finance-chip'+(value==='not_sure'?' finance-chip--wide':'');var input=document.createElement('input');input.type='radio';input.name=field;input.value=value;input.required=true;input.setAttribute('aria-describedby','finance-error-'+field);var span=document.createElement('span');label.append(input,span);group.querySelector('.finance-chips').appendChild(label);input.addEventListener('change',function(){answers[field]=value;requestId=null;paint();});});
    document.getElementById('finance-questions').appendChild(group);
  });
  function paint(){
    var c=model.copy(lang()),copy=contactModel.copy(lang());
    model.fields.forEach(function(field,i){var group=form.querySelector('[data-finance-field="'+field+'"]'),missing=attempted&&!answers[field];group.querySelector('legend').textContent=c.labels[i];group.querySelector('.finance-help').textContent=c.help[i];var err=group.querySelector('.err');err.textContent=c.required;err.classList.toggle('on',missing);group.setAttribute('aria-invalid',String(missing));group.querySelectorAll('input').forEach(function(input){input.nextElementSibling.textContent=model.label(field,input.value,lang());input.setAttribute('aria-invalid',String(missing));input.disabled=busy;});});
    document.getElementById('finance-ready').hidden=true;
    document.getElementById('finance-contact').hidden=!model.valid(answers);
    document.getElementById('finance-contact-title').textContent=copy.name+' · '+copy.phone;
    document.getElementById('finance-name-label').textContent=copy.name;
    document.getElementById('finance-phone-label').textContent=copy.phone;
    document.getElementById('finance-phone-help').textContent=copy.phoneHelp;
    document.getElementById('finance-consent-text').textContent=copy.consent;
    [nameInput,phoneInput,consentInput].forEach(function(input){input.disabled=busy;});
    var submit=document.getElementById('finance-submit');submit.disabled=busy;submit.textContent=busy?copy.saving:copy.save;
    form.hidden=Boolean(saved);document.getElementById('finance-result').hidden=!saved;
    if(saved){
      document.getElementById('finance-saved-title').textContent=copy.saved;
      document.getElementById('finance-saved-ref').textContent='Ref: '+saved.ref;
      document.getElementById('finance-partner-note').textContent=copy.next;
      var application=document.getElementById('finance-application');application.textContent=copy.application;application.href='/finance?lang='+encodeURIComponent(lang());
      var whatsapp=document.getElementById('finance-whatsapp');whatsapp.textContent=copy.whatsapp;whatsapp.href='https://wa.me/13055400742?text='+encodeURIComponent(model.message(saved.answers,lang(),saved.ref));
    }
  }
  new MutationObserver(function(){if(!busy)requestId=null;paint();}).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  form.addEventListener('submit',async function(event){
    event.preventDefault();if(busy)return;attempted=true;paint();if(!model.valid(answers)){form.querySelector('[aria-invalid="true"] input').focus();return;}
    var language=lang(),submitted=Object.assign({},answers),error=document.getElementById('finance-save-error');error.classList.remove('on');
    var details=contactModel.normalize(contact());
    if(!details){error.textContent=contactModel.copy(language).invalid;error.classList.add('on');if(nameInput.value.trim().length<2)nameInput.focus();else if(!contactModel.normalize({name:nameInput.value,phone:phoneInput.value,consent:true}))phoneInput.focus();else consentInput.focus();return;}
    busy=true;paint();requestId=requestId||crypto.randomUUID();var controller=new AbortController(),timer=setTimeout(function(){controller.abort();},20000);
    try{var response=await fetch('/api/finance-request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:requestId,language:language,answers:submitted,contact:details}),signal:controller.signal});var data=await response.json();if(!response.ok||!data.ok||!/^[A-HJ-NP-Z2-9]{5}$/.test(data.ref)){var failure=Error('SAVE_FAILED');failure.rate=response.status===429;throw failure;}saved={ref:data.ref,answers:submitted};paint();document.getElementById('finance-result').focus();document.getElementById('finance-result').scrollIntoView({block:'center'});
    }catch(failure){error.textContent=contactModel.copy(lang())[failure.rate?'limit':'error'];error.classList.add('on');error.focus();}finally{clearTimeout(timer);busy=false;paint();}
  });
  aplicarIdioma();paint();
}());
