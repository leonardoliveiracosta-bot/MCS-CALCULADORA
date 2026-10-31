(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.MCSPurchasePlan=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const copies={
    en:{hello:"Hello! I'd like to buy through My Car Scout",name:'Name',vehicle:'Vehicle',years:'Model years',trim:'Trim',miles:'Maximum mileage',bid:'Maximum bid',auction:'Auction fee (estimated)',service:'MCS service fee',payment:'Payment method',cash:'Cash',fin:'Financing',zip:'ZIP code',when:'Planning to buy',now:'Ready to buy now','30d':'Within 30 days','3mo':'Within 3 months',none:'No set date yet'},
    es:{hello:'Hola, quiero comprar un auto con My Car Scout',name:'Nombre',vehicle:'Vehículo',years:'Años deseados',trim:'Versión',miles:'Máximo de millas',bid:'Oferta máxima',auction:'Tarifa de subasta (estimada)',service:'Tarifa de servicio MCS',payment:'Forma de pago',cash:'Contado',fin:'Financiamiento',zip:'ZIP code',when:'Pienso comprar',now:'Listo para comprar ahora','30d':'En 30 días','3mo':'En 3 meses',none:'Sin fecha definida'},
    pt:{hello:'Olá, quero comprar um carro com a My Car Scout',name:'Nome',vehicle:'Veículo',years:'Anos desejados',trim:'Versão',miles:'Milhas máximas',bid:'Lance máximo',auction:'Taxa do leilão (estimativa)',service:'Taxa de serviço MCS',payment:'Forma de pagamento',cash:'À vista',fin:'Financiamento',zip:'ZIP code',when:'Pretendo comprar',now:'Pronto para comprar agora','30d':'Em até 30 dias','3mo':'Em até 3 meses',none:'Sem data definida'}
  };
  function copy(lang){return copies[lang]||copies.en;}
  function numbers(result){return {bid:Math.round(result.lance),auction:Math.round(result.taxaLeilao)+Math.round(result.totalFixas),service:Math.round(result.servico)};}
  function validDetails(data,maxYear=new Date().getFullYear()+1){
    return Number.isInteger(data.anoDe)&&data.anoDe>=1995&&Number.isInteger(data.anoAte)&&data.anoAte>=data.anoDe&&data.anoAte<=maxYear
      &&Number.isInteger(data.milhasAte)&&data.milhasAte>0&&data.milhasAte<=1000000
      &&Boolean(data.trimSemCerteza||String(data.trim||'').trim())&&String(data.nome||'').trim().length>=2;
  }
  function message(data,result,lang){
    const c=copy(lang),n=numbers(result),money=value=>'$'+value.toLocaleString('en-US');
    const clean=value=>String(value??'').replace(/[\r\n]+/g,' ').trim();
    const rows=[c.hello,'',c.name+': '+clean(data.nome),c.vehicle+': '+clean(data.marca)+' '+clean(data.modelo),
      c.years+': '+data.anoDe+'-'+data.anoAte];
    if(!data.trimSemCerteza&&data.trim)rows.push(c.trim+': '+clean(data.trim));
    rows.push(c.miles+': '+Number(data.milhasAte).toLocaleString('en-US'),c.bid+': '+money(n.bid),
      c.auction+': '+money(n.auction),c.service+': '+money(n.service),c.payment+': '+(data.pgto==='fin'?c.fin:c.cash),
      c.zip+': '+clean(data.zip)+(data.estadoNome?' · '+clean(data.estadoNome):''),c.when+': '+(c[data.prazo]||clean(data.prazo)),
      'Ref: '+clean(data.ref));
    return rows.join('\n');
  }
  return {copy,numbers,validDetails,message};
});
