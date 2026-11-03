(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.MCSPurchasePlan=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const copies={
    en:{hello:"Hello! I'd like to buy through My Car Scout",name:'Name',vehicle:'Vehicle',years:'Model years',trim:'Trim',anyTrim:'No specific trim',miles:'Maximum mileage',bid:'Your target vehicle price',payment:'Payment method',cash:'Cash',fin:'Financing',zip:'ZIP code',when:'Planning to buy',now:'Ready to buy now','30d':'Within 30 days','3mo':'Within 3 months',none:'No set date yet'},
    es:{hello:'Hola, quiero comprar un auto con My Car Scout',name:'Nombre',vehicle:'Vehículo',years:'Años deseados',trim:'Versión',anyTrim:'Sin versión específica',miles:'Máximo de millas',bid:'Precio deseado para el vehículo',payment:'Forma de pago',cash:'Contado',fin:'Financiamiento',zip:'ZIP code',when:'Pienso comprar',now:'Listo para comprar ahora','30d':'En 30 días','3mo':'En 3 meses',none:'Sin fecha definida'},
    pt:{hello:'Olá, quero comprar um carro com a My Car Scout',name:'Nome',vehicle:'Veículo',years:'Anos desejados',trim:'Versão',anyTrim:'Sem versão específica',miles:'Milhas máximas',bid:'Preço pretendido para o veículo',payment:'Forma de pagamento',cash:'À vista',fin:'Financiamento',zip:'ZIP code',when:'Pretendo comprar',now:'Pronto para comprar agora','30d':'Em até 30 dias','3mo':'Em até 3 meses',none:'Sem data definida'}
  };
  function copy(lang){return copies[lang]||copies.en;}
  function numbers(result){return {bid:Math.round(result.lance),auction:Math.round(result.taxaLeilao)+Math.round(result.totalFixas),service:Math.round(result.servico)};}
  function validDetails(data,maxYear=new Date().getFullYear()+1){
    return Number.isInteger(data.anoDe)&&data.anoDe>=1995&&Number.isInteger(data.anoAte)&&data.anoAte>=data.anoDe&&data.anoAte<=maxYear
      &&Number.isInteger(data.milhasAte)&&data.milhasAte>0&&data.milhasAte<=1000000
      &&Boolean(data.trimSemCerteza||String(data.trim||'').trim())&&String(data.nome||'').trim().length>=2;
  }
  const clean=value=>String(value??'').replace(/[\r\n]+/g,' ').trim();
  const money=value=>'$'+Number(value).toLocaleString('en-US',{minimumFractionDigits:Number(value)%1?2:0,maximumFractionDigits:2});
  const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  function summary(data,lang){
    const c=copy(lang),rows=[];
    const add=(key,label,value)=>{if(value)rows.push({key,label,value:clean(value)});};
    add('name',c.name,data.nome);
    add('vehicle',c.vehicle,[data.marca,data.modelo].filter(Boolean).join(' '));
    add('years',c.years,data.anoDe&&data.anoAte?data.anoDe+'-'+data.anoAte:'');
    add('trim',c.trim,data.trimSemCerteza?c.anyTrim:data.trim);
    add('miles',c.miles,data.milhasAte>0?Number(data.milhasAte).toLocaleString('en-US'):'');
    add('target',c.bid,data.lance>0?money(data.lance):'');
    add('payment',c.payment,data.pgto==='cash'?c.cash:data.pgto==='fin'?c.fin:'');
    add('zip',c.zip,data.zip?clean(data.zip)+(data.estadoNome?' · '+clean(data.estadoNome):''):'');
    add('when',c.when,c[data.prazo]||'');
    return rows;
  }
  function triage(data,lang){
    const timing={now:'NOW','30d':'30D','3mo':'3MO',none:'NO DATE'};
    const parts=[copies[lang]?lang.toUpperCase():'EN'];
    if(timing[data.prazo])parts.push(timing[data.prazo]);
    parts.push('$'+Math.round(Number(data.lance)||0).toLocaleString('en-US'));
    const car=[data.marca,data.modelo].filter(value=>value&&value!=='Other brand'&&value!=='Other model').map(clean).join(' ');
    if(car)parts.push(car);
    return parts.join(' · ');
  }
  function message(data,result,lang){
    const rows=[triage(data,lang),copy(lang).hello,''];
    summary(data,lang).filter(row=>row.key!=='trim'||!data.trimSemCerteza).forEach(row=>rows.push(row.label+': '+row.value));
    rows.push('Ref: '+clean(data.ref));
    return rows.join('\n');
  }
  return {copy,numbers,validDetails,message,summary,triage,escapeHtml};
});
