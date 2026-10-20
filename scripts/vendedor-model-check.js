'use strict';
// Explicit deployment check only: no customer messages, no credentials in logs
const vendedor=require('../panel-vendedor');
const server=require('../panel-server');
async function main(){
  const model=await vendedor.sonnetModel();
  console.log('MCS_VENDEDOR_SONNET='+model);
  if(!process.argv.includes('--smoke'))return;
  if(process.env.VERCEL_ENV!=='preview')throw Error('PREVIEW_REQUIRED');
  const ctx={environment:'preview',config:server.configuration()};
  if(!ctx.config)throw Error('CONFIGURATION_MISSING');
  const [instruction]=await server.rows(ctx,'ia_instrucoes',{select:'conteudo,versao',environment:'eq.preview',ativa:'is.true',nome:'eq.mcs-vendedor',limit:'1'});
  if(!instruction)throw Error('INSTRUCTION_MISSING');
  const user=JSON.stringify({conversa:[{quem:'cliente',dataHora:new Date().toISOString(),canal:'WHATSAPP',texto:'Hi, looking for a 2020 BMW X3, cash, Florida, this month'}],pedidosCalculadora:[{modo:'CARRO',marca:'BMW',modelo:'X3',ano:2020,pagamento:'cash',estado:'Florida',prazo:'30d'}],testeInterno:'Lead fictício para validação. Não existe contato ou envio'});
  const out=await vendedor.generate(ctx,instruction.conteudo+'\n'+vendedor.FIXED+'\n'+vendedor.CONTRACT,user,'SMOKE_FICTICIO');
  console.log('MCS_VENDEDOR_SMOKE_OK='+JSON.stringify({model:out.model,messages:out.response.mensagens.length,version:instruction.versao}));
}
main().catch(error=>{console.error('MCS_VENDEDOR_CHECK_FAILED='+String(error.code||error.message||'UNAVAILABLE').replace(/[^A-Z_]/g,'').slice(0,80));process.exitCode=1;});
