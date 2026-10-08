'use strict';

// One boot only. Merge columns for the same complete read and exact filters;
// each caller keeps its projection, order and independent row objects.
module.exports = function createSharedProjections(read, compare) {
  const pending = new Map();
  const available = new Map();
  const eligible = new Set(['messages','calc_runs','contacts','journeys','chats','contact_phones','journey_refs','journey_toggle_states']);
  const plain = value => /^[a-z_][a-z0-9_]*$/.test(value);
  const project = (entry,rows) => {
    const own=structuredClone(rows);
    own.sort(compare(entry.params.order,entry.keys));
    return own.map(row=>{
      const projected=Object.fromEntries(entry.fields.map(field=>[field,row[field]]));
      if([...entry.fields,...entry.keys,...entry.orderColumns].includes('created_at') && row.date_unknown) projected.date_unknown=row.date_unknown;
      return projected;
    });
  };
  const flush = async key => {
    const group = pending.get(key); pending.delete(key);
    if (group.entries.length === 1) {
      const entry=group.entries[0];
      try { entry.resolve(await read(group.table,entry.params,group.pageSize)); }
      catch(error) { entry.reject(error); }
      return;
    }
    const columns=[...new Set(group.entries.flatMap(entry=>[...entry.fields,...entry.keys,...entry.orderColumns]))];
    let rows;
    const cached={columns,promise:read(group.table,{...group.filters,select:columns.join(',')},group.pageSize)};
    if(!available.has(key)) available.set(key,[]);
    available.get(key).push(cached);
    try { rows=await cached.promise; }
    catch(error) {
      available.set(key,available.get(key).filter(entry=>entry!==cached));
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
  return { load(table,params,pageSize,metadata) {
    const {fields,keys,orderColumns}=metadata;
    if(!eligible.has(table)||!fields.length||![...fields,...orderColumns].every(plain)) return read(table,params,pageSize);
    const {select,order,...filters}=params;
    const key=JSON.stringify([table,pageSize,Object.entries(filters).sort(([a],[b])=>a.localeCompare(b))]);
    const entry={params,fields,keys,orderColumns};
    const cached=(available.get(key)||[]).find(read=>[...fields,...keys,...orderColumns].every(column=>read.columns.includes(column)));
    if(cached) return cached.promise.then(rows=>project(entry,rows),()=>read(table,params,pageSize));
    return new Promise((resolve,reject)=>{
      if(!pending.has(key)) { pending.set(key,{table,pageSize,filters,entries:[]}); setImmediate(()=>flush(key)); }
      pending.get(key).entries.push({params,fields,keys,orderColumns,resolve,reject});
    });
  } };
};
