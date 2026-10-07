'use strict';

// Claude dentro do painel, sem ninguém abrir uma aba. Um ciclo só, com um prazo único (a função morre aos 60 s):
//  0. destino de toda mensagem da calculadora (Ref -> telefone -> ficha nova -> fila; determinístico e sem custo);
//  1. prints de SMS guardados e não salvos (relê o que falhou por motivo passageiro, salva o que a Ref prova);
//  2. identidade por Ref de todas as fichas (determinística e sem custo);
//  3. classificação paga de assunto removida do cron; as classificações existentes são preservadas.
// Mesmo segredo e mesma regra do ai-cron; o saldo pré-pago do Claude e as reservas são os de sempre.
const crypto=require('node:crypto');
const {configuration,SERVER_ENVIRONMENT,send}=require('../../panel-server');
const {reconcileIdentity}=require('../../panel-identity');
const {resumePrints}=require('../../panel-print-resume');
const {equalSecret}=require('./ai-cron');
const {routeCalculatorMessages}=require('../../panel-calc-route');

const CYCLE_MS=45000;

module.exports=async(req,res)=>{
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  if(!process.env.CRON_SECRET)return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  if(!equalSecret(req.headers?.authorization,'Bearer '+process.env.CRON_SECRET))return send(res,401,{error:'UNAUTHORIZED'});
  const config=configuration();
  if(!config||SERVER_ENVIRONMENT!=='production')return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  const startedAt=Date.now(),deadlineA���q�^