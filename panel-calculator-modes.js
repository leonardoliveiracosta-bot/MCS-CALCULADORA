'use strict';
const {isDeepStrictEqual}=require('node:util');
const {consolidateCalcRuns}=require('./panel-domain');

// The same input is consolidated once per authenticated opening. Each consumer
// receives independent objects; no derived data survives into another request.
module.exports=function calculatorModes(ctx,rows=[],links=[],compute=consolidateCalcRuns) {
  if(!ctx?.calculatorModesCache) return compute(rows,links);
  const input=[rows,links],key=JSON.stringify(input),cache=ctx.calculatorModesCache;
  const entries=cache.get(key)||[];
  const hit=entries.find(entry=>entry.compute===compute&&isDeepStrictEqual(entry.input,input));
  if(hit) {if(ctx.calculatorModesStats)ctx.calculatorModesStats.reuses++;return structuredClone(hit.output);}
  const started=Date.now(),output=compute(rows,links);
  if(ctx.calculatorModesStats){ctx.calculatorModesStats.loads++;ctx.calculatorModesStats.compute+=Date.now()-started;}
  entries.push({compute,input:structuredClone(input),output:structuredClone(output)});cache.set(key,entries);
  return output;
};
