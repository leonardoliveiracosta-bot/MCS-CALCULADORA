(function(root,factory){
  'use strict';var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.MCSFinanceMessageReturn=api;
})(typeof window!=='undefined'?window:this,function(){
  'use strict';
  var key='mcs_finance_message_return_v1',ttl=20*60*1000;
  function create(win,onReturn){
    var pending=null;
    function valid(value){return value&&/^[A-HJ-NP-Z2-9]{5}$/.test(value.ref)&&['en','es','pt'].includes(value.language)&&['SMS','WHATSAPP'].includes(value.channel)&&Number.isFinite(value.at)&&value.at<=Date.now()&&Date.now()-value.at<ttl;}
    function clear(){pending=null;try{win.sessionStorage.removeItem(key);}catch(_) {}}
    function resume(){if(!valid(pending)){clear();return;}var language=pending.language;clear();onReturn('/finance?lang='+language);}
    function arm(ref,language,channel){pending={ref:ref,language:language,channel:channel,at:Date.now(),hidden:false};if(!valid(pending)){clear();return;}try{win.sessionStorage.setItem(key,JSON.stringify(pending));}catch(_) {}}
    win.document.addEventListener('visibilitychange',function(){if(!pending)return;if(win.document.visibilityState==='hidden')pending.hidden=true;else if(pending.hidden)resume();});
    win.addEventListener('focus',function(){if(pending?.hidden&&win.document.visibilityState==='visible')resume();});
    win.addEventListener('pageshow',function(event){if(pending&&(event.persisted||pending.restored)&&win.document.visibilityState==='visible')resume();});
    try{var stored=JSON.parse(win.sessionStorage.getItem(key)||'null');if(valid(stored)){pending=stored;pending.restored=true;win.setTimeout(function(){if(pending?.restored&&win.document.visibilityState==='visible')resume();},0);}else clear();}catch(_){}
    return {arm:arm,clear:clear};
  }
  return {create:create};
});
