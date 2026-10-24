(function(){
  'use strict';
  var destination='https://www.mymetawholesalecars.com/apply-online/';
  var authorized=false,busy=false,timer=null,copy=document.querySelector('.finance-copy'),button=document.getElementById('finance-continue'),retry=document.getElementById('finance-retry');
  var texts={
    en:{start:'Start with your financing request so MCS can follow up with you',startButton:'Start my financing request',partner:"Continue to the secure credit application on our dealer partner's site, Meta Wholesale Cars",continueButton:'Continue to application',error:'We could not verify your saved request Try again or start your financing request',retry:'Try again'},
    es:{start:'Comienza con tu solicitud de financiamiento para que MCS pueda contactarte',startButton:'Iniciar mi solicitud de financiamiento',partner:'Continúa a la solicitud de crédito segura en el sitio de nuestro dealer asociado, Meta Wholesale Cars',continueButton:'Continuar a la solicitud',error:'No pudimos verificar tu solicitud guardada Inténtalo de nuevo o inicia tu solicitud de financiamiento',retry:'Intentar de nuevo'},
    pt:{start:'Comece pelo seu pedido de financiamento para que a MCS possa acompanhar você',startButton:'Iniciar meu pedido de financiamento',partner:'Continue para o pedido de crédito seguro no site da nossa concessionária parceira, Meta Wholesale Cars',continueButton:'Continuar para o pedido',error:'Não conseguimos verificar seu pedido salvo Tente novamente ou inicie seu pedido de financiamento',retry:'Tentar novamente'}
  };
  var failed=false,lastMethod='manual';
  var departureError={en:'We could not continue to the application Please try again',es:'No pudimos continuar a la solicitud Inténtalo de nuevo',pt:'Não conseguimos continuar para o pedido Tente novamente'};
  function paint(){var lang=texts[document.documentElement.lang]?document.documentElement.lang:'en',t=texts[lang];copy.textContent=failed?(authorized?departureError[lang]:t.error):authorized?t.partner:t.start;button.textContent=authorized?t.continueButton:t.startButton;button.href=authorized?destination:'/msc-calculadora.html?start=finance&lang='+lang;button.setAttribute('aria-disabled',String(busy));retry.textContent=t.retry;retry.hidden=!failed;retry.disabled=busy;}
  async function leave(method){
    if(busy||!authorized)return;busy=true;failed=false;lastMethod=method;clearTimeout(timer);paint();
    var controller=new AbortController(),timeout=setTimeout(function(){controller.abort();},8000);
    try{
      var response=await fetch('/api/finance-handoff',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify({method:method}),signal:controller.signal});
      if(!response.ok)throw Error('HANDOFF_FAILED');var data=await response.json();
      if(data.authorized!==true||data.destination!==destination||!Number.isFinite(Date.parse(data.handedOffAt)))throw Error('HANDOFF_FAILED');
      window.location.replace(destination);
    }catch(_){failed=true;}finally{clearTimeout(timeout);busy=false;paint();}
  }
  async function verify(){
    if(busy)return;busy=true;failed=false;authorized=false;clearTimeout(timer);paint();
    var controller=new AbortController(),timeout=setTimeout(function(){controller.abort();},8000);
    try{
      var response=await fetch('/api/finance-handoff',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
      if(!response.ok)throw Error('VERIFY_FAILED');var data=await response.json();
      authorized=data.authorized===true&&data.destination===destination;
      if(authorized)timer=setTimeout(function(){leave('automatic');},3000);
    }catch(_){failed=true;}finally{clearTimeout(timeout);busy=false;paint();}
  }
  retry.addEventListener('click',function(){if(authorized)leave(lastMethod);else verify();});
  button.addEventListener('click',function(event){if(authorized){event.preventDefault();leave('manual');}});
  new MutationObserver(paint).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  paint();verify();
}());
