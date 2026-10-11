(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document) api.attach(root);
}(typeof globalThis === 'object' ? globalThis : window, function () {
  'use strict';
  function options(data, make, model, from, to) {
    from=Number(from);to=Number(to);
    if (data?.schema!==1 || data.market!=='US' || !make || !model || !Number.isInteger(from) || !Number.isInteger(to) || from<1995 || to<from || to>new Date().getFullYear()+1) return [];
    const years=Object.hasOwn(data.vehicles||{},make)&&Object.hasOwn(data.vehicles[make],model)?data.vehicles[make][model]:null;
    if(!years)return [];
    const found=new Map();
    for(let year=from;year<=to;year++) for(const label of (Array.isArray(years[year])?years[year]:[])) {
      if(typeof label==='string'&&label.length<=90&&!/[<>\u0000-\u001f]/.test(label))found.set(label.toLowerCase(),label);
    }
    return [...found.values()].sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));
  }
  function attach(win) {
    const document=win.document,input=document.getElementById('find-trim'),unsure=document.getElementById('find-trim-unsure');
    if(!input||!unsure)return;
    const list=document.createElement('datalist');list.id='find-trim-options';input.after(list);
    const status=document.createElement('p');status.className='vehicle-trims-state';status.hidden=true;status.setAttribute('role','status');list.after(status);
    let data=null,loading=null,sequence=0,failed=false;
    const copy={en:'Could not load versions. You can type one or choose No specific trim.',pt:'Não foi possível carregar as versões. Você pode escrever ou marcar Sem versão específica.',es:'No se pudieron cargar las versiones. Puedes escribir o marcar Sin versión específica.'};
    function paintError(){status.textContent=copy[document.documentElement.lang]||copy.en;status.hidden=!failed;}
    function load(){
      if(data)return Promise.resolve(data);if(loading)return loading;
      loading=win.fetch('/vehicle-trims.json?v=20261011a',{headers:{accept:'application/json'}}).then(response=>{if(!response.ok)throw Error('CATALOG_UNAVAILABLE');return response.json();}).then(value=>{if(value?.schema!==1||value.market!=='US'||!value.vehicles)throw Error('CATALOG_INVALID');data=value;return data;}).finally(()=>{loading=null;});
      return loading;
    }
    function context(){return {make:document.getElementById('find-marca').value,model:document.getElementById('find-modelo').value,from:document.getElementById('find-year-from').value,to:document.getElementById('find-year-to').value};}
    async function update(){
      const owner=++sequence,c=context();list.replaceChildren();input.removeAttribute('list');failed=false;paintError();
      if(unsure.checked||!c.make||!c.model||!c.from||!c.to||c.make==='Other brand'||c.model==='Other model'||Number(c.to)<Number(c.from))return;
      try{
        const catalog=await load();if(owner!==sequence)return;
        const labels=options(catalog,c.make,c.model,c.from,c.to);
        labels.forEach(label=>{const option=document.createElement('option');option.value=label;list.append(option);});
        if(labels.length)input.setAttribute('list',list.id);
      }catch(_){if(owner!==sequence)return;failed=true;paintError();}
    }
    ['find-marca','find-modelo','find-year-from','find-year-to','find-trim-unsure'].forEach(id=>document.getElementById(id)?.addEventListener('change',update));
    new win.MutationObserver(paintError).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
    update();
  }
  return {options,attach};
}));
