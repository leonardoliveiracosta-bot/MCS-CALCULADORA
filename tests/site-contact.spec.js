'use strict';
const {test,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {migratedDatabase}=require('./sql/run');
const root=path.join(__dirname,'..'),base='http://127.0.0.1:4173';
let db,publicHandler,staffHandler,actor=crypto.randomUUID();
test.describe.configure({mode:'serial'});
function load(file,server){const module={exports:{}};new Function('require','module','exports',fs.readFileSync(path.join(root,file),'utf8'))(name=>name.endsWith('panel-server')?server:require(name.startsWith('.')?path.resolve(path.dirname(path.join(root,file)),name):name),module,module.exports);return module.exports;}
test.beforeAll(async()=>{
  test.setTimeout(90000);({db}=await migratedDatabase());
  await db.query('insert into public.panel_users(id,environment,auth_user_id,email) values($1,\'production\',$2,\'site-example@example.test\')',[actor,crypto.randomUUID()]);
  const server={SERVER_ENVIRONMENT:'production',configuration:()=>({url:'local-database',secretKey:'local-secret'}),isUuid:require('../panel-server').isUuid,jsonBody:async r=>r.body,requirePanel:async req=>req.headers.authorization==='Bearer token-test'?{environment:'production',panel:{id:actor},config:{url:'local-database',secretKey:'local-secret'}}:null,send:(r,c,p)=>r.status(c).json(p),
    rows:async(_ctx,table,f)=>{expect(table).toBe('site_contact_requests');const done=f.status==='neq.OPEN';const result=await db.query(`select ${f.select} from public.site_contact_requests where environment=$1 and status ${done?'<>':'='} 'OPEN' ${done?'and handled_at>=now()-interval \'7 days\'':''} order by ${done?'handled_at':'created_at'} desc,id desc limit $2 offset $3`,['production',Number(f.limit),Number(f.offset||0)]);return result.rows;},
    supabase:async(_u,_k,url,o)=>{const p=JSON.parse(o.body);try{if(url.endsWith('site_contact_request_create'))return (await db.query('select public.site_contact_request_create($1,$2,$3,$4,$5,$6,$7,$8)',Object.values(p))).rows;return (await db.query('select public.site_contact_request_status($1,$2,$3,$4,$5)',Object.values(p))).rows;}catch(e){e.code=e.message;throw e;}}
  };publicHandler=load('api/contact-request.js',server);staffHandler=load('api/panel/contact-requests.js',server);
});
test.afterAll(async()=>{await db?.close();});
test.beforeEach(async()=>{await db.exec('delete from public.site_contact_requests;');});
async function routes(page,options={}){
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());if(!url.href.startsWith(base))return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
    const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname==='/api/contact-request'||url.pathname==='/api/panel/contact-requests'){
      if(options.fail)return json({error:'TEST_UNAVAILABLE'},503);
      const res={code:0,payload:null,setHeader(){},status(c){this.code=c;return this;},json(p){this.payload=p;return p;}};
      const req={method:request.method(),query:Object.fromEntries(url.searchParams),headers:{...request.headers(),origin:'https://www.mycarscout.net','x-forwarded-for':'192.0.2.1'},body:request.postData()?JSON.parse(request.postData()):null};
      await (url.pathname==='/api/contact-request'?publicHandler:staffHandler)(req,res);
      if(options.loseResponse&&url.pathname==='/api/contact-request'){options.loseResponse=false;return json({error:'TEST_RESPONSE_LOST'},503);}
      return json(res.payload,res.code);
    }
    if(url.pathname==='/api/panel/config')return json({url:base+'/mock',publishableKey:'public-test'});
    if(url.pathname==='/api/panel/session')return json({email:'site-example@example.test',role:'admin',mustChangePassword:false});
    return json({items:[],orders:[],contacts:[],journeys:[],matches:[],groups:[],chats:[],reviews:[],requests:[],demands:[],v1:{},v2:{},meta:{},suggestions:[],triage:[],parts:{}});
  });
}
async function openSite(page,options={}){await page.setViewportSize({width:390,height:844});await page.addInitScript(()=>localStorage.setItem('mcs_lang','pt'));await routes(page,options);await page.goto(base+'/');await page.locator('[data-mcs-contact-request="footer"]').click();await expect(page.locator('.mcs-contact-dialog')).toBeVisible();}
async function fill(page,channel='SMS'){const f=page.locator('.mcs-contact-dialog');await f.locator('[name=name]').fill('Alex Example');await f.locator('[name=phone]').fill('3055550199');await f.locator('[value='+channel+']').check();return f;}
test('site → API → real local database → panel, with contact result and undo',async({page})=>{
  await openSite(page);const f=await fill(page);await f.getByRole('button',{name:'QUERO RECEBER CONTATO'}).click();await expect(f).toContainText('Pedido recebido. Nossa equipe entrará em contato.');
  const records=await db.query('select * from public.site_contact_requests');expect(records.rows).toHaveLength(1);expect(records.rows[0]).toMatchObject({name:'Alex Example',phone_e164:'+13055550199',channel:'SMS',status:'OPEN',source:'footer'});
  for(const table of ['contacts','journeys','chats','messages','calc_runs'])expect((await db.query('select count(*)::int as n from public.'+table)).rows[0].n).toBe(0);
  await page.addInitScript(()=>localStorage.setItem('mcs_panel_session',JSON.stringify({accessToken:'token-test',refreshToken:'refresh-test',accessExpiresAt:Date.now()+3600000})));
  await page.goto(base+'/painel/');const block=page.locator('#site-contact-requests');await expect(block).toBeVisible();await expect(block).toContainText('Alex Example');await expect(block).toContainText('+13055550199');
  await block.getByRole('link',{name:'Abrir SMS'}).click();await expect(page.locator('.wa-handoff-dialog')).toBeVisible();await expect(page.locator('.wa-handoff-qr svg')).toBeVisible();await page.locator('.wa-handoff-dialog').getByRole('button',{name:'Fechar'}).click();
  await block.getByRole('button',{name:'Marcar como contatado'}).click();await expect(block.locator('.site-contact-list .site-contact-item')).toHaveCount(0);await block.locator('.site-contact-recent summary').click();await block.getByRole('button',{name:'Desfazer'}).click();await expect(block.locator('.site-contact-list .site-contact-item')).toHaveCount(1);
  await block.getByRole('button',{name:'Arquivar',exact:true}).click();await expect(block.locator('.site-contact-list .site-contact-item')).toHaveCount(0);
  expect((await db.query('select status from public.site_contact_requests')).rows[0].status).toBe('ARCHIVED');
  expect((await db.query('select count(*)::int as n from public.messages')).rows[0].n).toBe(0);
  await page.getByRole('button',{name:'Sair',exact:true}).click();await expect(block).toBeHidden();await expect(block).not.toContainText('Alex Example');
});
test('lost confirmation retries the same request without duplicating or losing entered data',async({page})=>{
  await openSite(page,{loseResponse:true});const f=await fill(page,'CALL');await f.getByRole('button',{name:'QUERO RECEBER CONTATO'}).click();await expect(f).toContainText('Não conseguimos enviar seu pedido');await expect(f.locator('[name=phone]')).toHaveValue('3055550199');
  await f.getByRole('button',{name:'QUERO RECEBER CONTATO'}).click();await expect(f).toContainText('Pedido recebido');expect((await db.query('select count(*)::int as n from public.site_contact_requests')).rows[0].n).toBe(1);
});
test('service failure stays an error, close/reopen preserves the draft, and invalid phone does not submit',async({page})=>{
  await openSite(page,{fail:true});const f=await fill(page);await f.locator('[name=phone]').fill('123');await f.getByRole('button',{name:'QUERO RECEBER CONTATO'}).click();await expect(f).toContainText('Confira seu nome e telefone');
  await f.locator('[name=phone]').fill('3055550199');await f.getByRole('button',{name:'QUERO RECEBER CONTATO'}).click();await expect(f).toContainText('Não conseguimos enviar seu pedido');await f.getByRole('button',{name:'Fechar',exact:true}).click();await page.locator('[data-mcs-contact-request="footer"]').click();await expect(f.locator('[name=name]')).toHaveValue('Alex Example');
  expect((await db.query('select count(*)::int as n from public.site_contact_requests')).rows[0].n).toBe(0);
});
test('contact menu and all three languages share the form, search and direct WhatsApp remain distinct',async({page})=>{
  await routes(page);await page.goto(base+'/');const original=page.locator('#comecar .ready-btn');await expect(original).toHaveAttribute('href','#calculadora-widget');
  for(const [lang,label,title] of [['en','Have us contact you','Your name'],['es','Prefiero que me contacten','Tu nombre'],['pt','Prefiro que me chamem','Seu nome']]){
    await page.locator('#btn-lang').click();await page.locator('#sheet-lang [data-set-lang="'+lang+'"]').click();await expect(page.locator('[data-mcs-contact-request="footer"]')).toHaveText(label);await page.locator('#btn-fone').click();await page.locator('[data-mcs-contact-request="contact-menu"]').click();await expect(page.locator('.mcs-contact-dialog')).toContainText(title);await page.locator('.mcs-contact-close').click();await page.keyboard.press('Escape');
  }
  await expect(original).toHaveAttribute('href','#calculadora-widget');await expect(page.locator('#comecar .ready-whatsapp')).toHaveAttribute('href','https://wa.me/13055400742');expect((await db.query('select count(*)::int as n from public.site_contact_requests')).rows[0].n).toBe(0);
});
