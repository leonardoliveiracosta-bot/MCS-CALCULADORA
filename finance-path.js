(function(){
  'use strict';
  var model=window.MCSFinance,form=document.getElementById('finance-form'),answers={},attempted=false,busy=false,requestId=null;
  function lang(){return document.documentElement.lang;}
  Object.keys(model.copies).forEach(function(language){var c=model.copy(language),keys={finance_gate:c.gate,finance_gate_sub:c.gate_sub};['eyebrow','title','subtitle','intro','ready','cta','fine'].forEach(function(key){keys['finance_'+key]=c[key];});Object.assign(I18N[language],keys);});
  model.fields.forEach(function(field,i){
    var group=document.createElement('fieldset');group.className='finance-question';group.dataset.financeField=field;
    group.innerHTML='<legend id="finance-label-'+field+'"></legend><p class="finance-help" id="finance-help-'+field+'"></p><div class="finance-chips"></div><p class="err" id="finance-error-'+field+'" role="alert"></p>';
    group.setAttribute('aria-describedby','finance-help-'+field+' finance-error-'+field);
    model.options[field].forEach(function(value){var label=document.createElement('label');label.className='finance-chip'+(value==='not_sure'?' finance-chip--wide':'');var input=document.createElement('input');input.type='radio';input.name=field;input.value=value;input.required=true;input.setAttribute('aria-describedby','finance-error-'+field);var span=document.createElement('span');label.append(input,span);group.querySelector('.finance-chips').appendChild(label);input.addEventListener('change',function(){answers[field]=value;requestId=null;paint();});});
    document.getElementById('finance-questions').appendChild(group);
  });
  function paint(){var c=model.copy(lang());model.fields.forEach(function(field,i){var group=form.querySelector('[data-finance-field="'+field+'"]'),missing=attempted&&!answers[field];group.querySelector('legend').textContent=c.labels[i];group.querySelector('.finance-help').textContent=c.help[i];var err=group.querySelector('.err');err.textContent=c.required;err.classList.toggle('on',missing);group.setAttribute('aria-invalid',String(missing));group.querySelectorAll('input').forEach(function(input){input.nextElementSibling.textContent=model.label(field,input.value,lang());input.setAttribute('aria-invalid',String(missing));input.disabled=busy;});});document.getElementById('finance-ready').hidden=!model.valid(answers);document.getElementById('finance-submit').disabled=busy;}
  new MutationObserver(function(){if(!busy)requestId=null;paint();}).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  form.addEventListener('submit',async function(event){
    event.preventDefault();if(busy)return;attempted=true;paint();if(!model.valid(answers)){form.querySelector('[aria-invalid="true"] input').focus();return;}
    var language=lang(),submitted=Object.assign({},answers),error=document.getElementById('finance-save-error');error.classList.remove('on');
    // Open during the tap so mobile browsers do not block WhatsApp after the save.
    var popup=window.open('about:blank','_blank');if(popup)popup.opener=null;
    busy=true;paint();requestId=requestId||crypto.randomUUID();var controller=new AbortController(),timer=setTimeout(function(){controller.abort();},20000);
    try{var response=await fetch('/api/finance-request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:requestId,language:language,answers:submitted}),signal:controller.signal});var data=await response.json();if(!response.ok||!data.ok||!/^[A-HJ-NP-Z2-9]{5}$/.test(data.ref))throw Error('SAVE_FAILED');var url='https://wa.me/13055400742?text='+encodeURIComponent(model.message(submitted,language,data.ref));if(popup&&!popup.closed)popup.location.replace(url);else window.location.assign(url);
    }catch(_){if(popup&&!popup.closed)popup.close();error.textContent=model.copy(lang()).error;error.classList.add('on');error.focus();}finally{clearTimeout(timer);busy=false;paint();}
  });
  aplicarIdioma();paint();
}());
