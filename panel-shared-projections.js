'use strict';

// One boot only. Merge columns for the same complete read and exact filters;
// each caller keeps its projection, order and independent row objects.
module.exports = function createSharedProjections(read, compare) {
  const pending = new Map();
  const available = new Map();
  const stats={requests:0,loads:0,reuses:0,scopedReuses:0,fallbacks:0};
  const eligible = new Set(['messages','calc_runs','contacts','journeys','chats','contact_phones','journey_refs','journey_toggle_states','message_journeys','calculator_request_links','panel_identity_state','panel_conversation_class']);
  // Only known UUID/Ref equality filters and these exact non-date predicates.
  // Date, JSON, pattern and other operators remain in PostgreSQL.
  const scopedColumns={messages:{id:'uuid',chat_id:'uuid'},chats:{id:'uuid',contact_id:'uuid'},journeys:{id:'uuid',contact_id:'uuid',reference_code:'ref'},contacts:{id:'uuid'},contact_phones:{contact_id:'uuid'},journey_refs:{journey_id:'uuid',ref_code:'ref'},journey_toggle_states:{journey_id:'uuid'},message_journeys:{journey_id:'uuid'},calculator_request_links:{calc_ref:'ref'},panel_identity_state:{journey_id:'uuid'},panel_conversation_class:{journey_id:'uuid'}};
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const sourceKey=(table,pageSize,filters)=>JSON.stringify([table,pageSize,Object.entries(filters).sort(([a],[b])=>a.localeCompare(b))]);
  const plain = value => /^[a-z_][a-z0-9_]*$/.test(value);
  const predicate = (table,column,filter) => {
    if(table==='messages'&&column==='direction'&&['eq.CUSTOMER','eq.MCS'].includes(filter)) return row=>row.direction===filter.slice(3);
    if(table==='messages'&&column==='undone_at'&&filter==='is.null') return row=>row.undone_at===null;
    if(table==='messages'&&column==='body_text'&&filter==='like.*/v/*') return row=>typeof row.body_text==='string'&&row.body_text.includes('/v/');
    if(table==='journeys'&&column==='status'&&filter==='neq.ENCERRADO') return row=>row.status!=null&&row.status!=='ENCERRADO';
    const type=scopedColumns[table]?.[column];
    if(!type||typeof filter!=='string') return null;
    const quoted=/^in\.\("[^"(),]+"(?:,"[^"(),]+")*\)$/.test(filter);
    const unquoted=/^in\.\([^"(),]+(?:,[^"(),]+)*\)$/.test(filter);
    const values=filter.startsWith('eq.')?[filter.slice(3)]:quoted?filter.slice(4,-1).split(',').map(value=>value.slice(1,-1)):unquoted?filter.slice(4,-1).split(','):[];
    if(!values.length||!values.every(value=>type==='uuid'?uuid.test(value):/^[A-Z0-9]{5}$/.test(value))) return null;
    const wanted=new Set(values.map(value=>type==='uuid'?value.toLowerCase():value));
    return row=>row[column]!=null&&wanted.has(type==='uuid'?String(row[column]).toLowerCase():row[column]);
  };
  const project = (entry,rows) => {
    const own=entry.predicates?rows.filter(row=>entry.predicates.every(item=>item.test(row))):rows.slice();
    own.sort(compare(entry.params.order,entry.keys));
    return structuredClone(own.map(row=>{
      const projected=Object.fromEntries(entry.fields.map(field=>[field,row[field]]));
      if([...entry.fields,...entry.keys,...entry.orderColumns].includes('created_at') && row.date_unknown) projected.date_unknown=row.date_unknown;
      return projected;
    }));
  };
  const flush = async key => {
    const group = pending.get(key); pending.delete(key);
    const columns=[...new Set(group.entries.flatMap(entry=>[...entry.fields,...entry.keys,...entry.orderColumns,...(entry.predicates||[]).map(item=>item.column)]))];
    let rows;
    stats.loads+=1;
    const cached={columns,promise:read(group.table,{...group.filters,select:columns.join(',')},group.pageSize)};
    if(!available.has(key)) available.set(key,[]);
    available.get(key).push(cached);
    try { rows=await cached.promise; }
    catch(error) {
      stats.fallbacks+=1;
      available.set(key,available.get(key).filter(entry=>entry!==cached));
      if(group.entries.length===1) { group.entries[0].reject(error); return; }
      // A column unavailable to one projection must not fail unrelated callers.
      await Promise.all(group.entries.map(async entry=>{
        try { entry.resolve(await read(group.table,entry.params,group.pageSize)); }
        catch(failure) { entry.reject(failure); }
      }));
      return;
    }
    for(const entry of group.entries) {
      try {
        entry.resolve(project(entry,rows));
      } catch(error) { entry.reject(error); }
    }
  };
  return { stats, load(table,params,pageSize,metadata) {
    const {fields,keys,orderColumns}=metadata;
    if(!eligible.has(table)||!fields.length||![...fields,...orderColumns].every(plain)) return read(table,params,pageSize);
    stats.requests+=1;
    const {select,order,...filters}=params;
    const key=sourceKey(table,pageSize,filters);
    const entry={params,fields,keys,orderColumns};
    const cached=(available.get(key)||[]).find(read=>[...fields,...keys,...orderColumns].every(column=>read.columns.includes(column)));
    if(cached) { stats.reuses+=1; return cached.promise.then(rows=>project(entry,rows),()=>read(table,params,pageSize)); }
    const predicates=Object.entries(filters).map(([column,filter])=>({column,test:predicate(table,column,filter)})).filter(item=>item.test);
    // Prefer the complete opening source; also keep reuse of a source that
    // already has the other exact filters. No extra source is read to populate it.
    for(const subset of predicates.length>1?[predicates,...predicates.map(item=>[item])]:[predicates]) {
      if(subset.length) {
        const sourceFilters={...filters};subset.forEach(item=>delete sourceFilters[item.column]);
        const completeKey=sourceKey(table,pageSize,sourceFilters);
        const complete=(available.get(completeKey)||[]).find(source=>[...fields,...keys,...orderColumns,...subset.map(item=>item.column)].every(field=>source.columns.includes(field)));
        if(complete) {
          stats.reuses+=1;stats.scopedReuses+=1;
          return complete.promise.then(rows=>project({...entry,predicates:subset},rows),()=>read(table,params,pageSize));
        }
        if(pending.has(completeKey)) {
          stats.reuses+=1;stats.scopedReuses+=1;
          return new Promise((resolve,reject)=>pending.get(completeKey).entries.push({...entry,predicates:subset,resolve,reject}));
        }
      }
    }
    return new Promise((resolve,reject)=>{
      if(!pending.has(key)) { pending.set(key,{table,pageSize,filters,entries:[]}); setImmediate(()=>flush(key)); }
      pending.get(key).entries.push({params,fields,keys,orderColumns,resolve,reject});
    });
  } };
};
