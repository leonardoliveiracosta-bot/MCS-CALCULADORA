/* Contact details stay on MCS and are never included in the partner URL. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.MCSFinanceContact=factory();}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var copies={
    en:{name:'Your name',phone:'Phone number',phoneHelp:'US number or include your country code',consent:'MCS may contact me about this financing request',invalid:'Enter your name and a valid phone number, then allow MCS to contact you',save:'Save my request',saving:'Saving your request',saved:'Your request is saved',next:'Continue with our dealer partner, Meta Wholesale Cars',application:'Continue to application',whatsapp:'Talk to MCS on WhatsApp',error:'Could not save your request Please try again',limit:'Please wait before trying again'},
    es:{name:'Tu nombre',phone:'Número de teléfono',phoneHelp:'Número de EE UU o incluye el código de país',consent:'MCS puede contactarme sobre esta solicitud de financiamiento',invalid:'Ingresa tu nombre y un teléfono válido y permite que MCS te contacte',save:'Guardar mi solicitud',saving:'Guardando tu solicitud',saved:'Tu solicitud está guardada',next:'Continúa con nuestro dealer asociado, Meta Wholesale Cars',application:'Continuar a la solicitud',whatsapp:'Hablar con MCS por WhatsApp',error:'No pudimos guardar tu solicitud Inténtalo de nuevo',limit:'Espera antes de volver a intentarlo'},
    pt:{name:'Seu nome',phone:'Telefone',phoneHelp:'Número dos EUA ou inclua o código do país',consent:'A MCS pode entrar em contato sobre este pedido de financiamento',invalid:'Informe seu nome e um telefone válido e permita o contato da MCS',save:'Salvar meu pedido',saving:'Salvando seu pedido',saved:'Seu pedido está salvo',next:'Continue com nossa concessionária parceira, Meta Wholesale Cars',application:'Continuar para a aplicação',whatsapp:'Falar com a MCS pelo WhatsApp',error:'Não conseguimos salvar seu pedido Tente novamente',limit:'Aguarde antes de tentar novamente'}
  };
  function normalize(contact){
    if(!contact||typeof contact!=='object'||Array.isArray(contact)||contact.consent!==true)return null;
    var name=typeof contact.name==='string'?contact.name.normalize('NFC').replace(/\s+/g,' ').trim():'';
    var raw=typeof contact.phone==='string'?contact.phone.trim():'';
    var digits=raw.replace(/\D/g,'');
    if(name.length<2||name.length>80||/[\u0000-\u001f<>]/.test(name)||!/^\+?[\d\s().-]+$/.test(raw))return null;
    if(!raw.startsWith('+')&&!(digits.length===10||digits.length===11&&digits[0]==='1'))return null;
    if(digits.length===10&&!raw.startsWith('+'))digits='1'+digits;
    if(!/^[1-9]\d{7,14}$/.test(digits))return null;
    return {name:name,phone:'+'+digits,consent:true};
  }
  return {normalize:normalize,copy:function(lang){return copies[lang]||copies.en;}};
}));
