'use strict';
const {test,expect}=require('@playwright/test');
const {publicResponse}=require('../vitrine-domain');
if(process.env.CHROMIUM_PATH)test.use({launchOptions:{executablePath:process.env.CHROMIUM_PATH}});
const base='http://127.0.0.1:4173';
const payload=()=>({...publicResponse({token:'DEMO',version:'V2',reference_code:'DEMO2',customer_name:'Alex',expires_at:'2099-12-31T00:00:00Z'},[
  {short_code:'MCS-7K2Q',vehicle_snapshot:{year:2023,make:'Jeep',model:'Grand Cherokee L',trim:'Limited',miles:20000,engine:'6-cylinder',transmission:'Automatic',drivetrain:'AWD',interiorColor:'Black',exteriorColor:'White',state:'Tennessee',startsAt:'2099-10-22T15:00:00Z',estimatedMarketReference:27880,cleanTitle:true,odometerOk:true,whyChosen:'Matches your requested model and mileage'},customer_limit_cents:3000000,note_text:'Customer-facing note\nSecond line'}
],[[base+'/vehicle-photo-1',base+'/vehicle-photo-2',base+'/vehicle-photo-3']]),whatsAppNumber:'13055550100'});
async function open(page,data,posts=[]){
  await page.route('https://fonts.googleapis.com/**',r=>r.abort());
  await page.route('**/vehicle-photo-*',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#69776c"/><text x="240" y="200" fill="white" font-size="24">Photo</text></svg>'}));
  await page.route('**/api/vitrine?**',r=>{
    if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());return r.fulfill({json:{accepted:true}});}
    return r.fulfill({json:data});
  });
  await page.goto(base+'/v/index.html');
  await expect(page.locator('.v2-page .car')).toHaveCount(1);
}
for(const colorScheme of ['light','dark'])for(const width of [320,390,1280]){
  test(`V2 ${colorScheme} ${width}: same identity, clear labels, all photos and bidding details`,async({page})=>{
    await page.setViewportSize({width,height:1100});await page.emulateMedia({colorScheme});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await open(page,payload());
    await expect(page.locator('.title')).toHaveText('2023 Jeep Grand Cherokee L Limited');
    await expect(page.locator('.eyebrow')).toContainText('Ref DEMO2');
    const car=page.locator('.car');
    for(const text of ['6-cylinder','Automatic','AWD','Black','20,000 mi','Tennessee','Clean title','Odometer OK','~ $27,880','Up to $30,000','Your limit is the most we\'ll bid, not what you pay','Customer-facing note','Second line','Matches your requested model and mileage'])await expect(car).toContainText(text);
    const photos=page.locator('.gallery img');await expect(photos).toHaveCount(3);
    expect(await photos.evaluateAll(els=>els.every(el=>el.complete&&el.naturalWidth>0))).toBe(true);
    const metrics=await page.evaluate(()=>{
      const label=getComputedStyle(document.querySelector('.specs small')),value=getComputedStyle(document.querySelector('.specs>div')),title=getComputedStyle(document.querySelector('.title')),button=getComputedStyle(document.querySelector('button'));
      return {labelSize:label.fontSize,labelWeight:label.fontWeight,valueSize:value.fontSize,valueWeight:value.fontWeight,labelColor:label.color,valueColor:value.color,titleFont:title.fontFamily,titleCase:title.textTransform,buttonFont:button.fontFamily,columns:getComputedStyle(document.querySelector('.specs')).gridTemplateColumns.split(' ').length,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    expect(metrics).toMatchObject({labelSize:'16px',labelWeight:'400',valueSize:'18px',valueWeight:'600',titleCase:'none',columns:width>600?3:2,overflow:false});
    expect(metrics.labelColor).not.toBe(metrics.valueColor);expect(metrics.titleFont).toContain('Instrument Sans');expect(metrics.buttonFont).toContain('Instrument Sans');
    expect(errors).toEqual([]);
    if(width!==320)await page.screenshot({path:`/tmp/mcs-v2-${colorScheme}-${width}.png`,fullPage:true});
  });
}
test('V2 bid stays one direct click and keeps the correct car and tracking event',async({page})=>{
  const posts=[],links=[];
  await page.route('https://wa.me/**',r=>{links.push(r.request().url());return r.fulfill({body:'Mock WhatsApp'});});
  await open(page,payload(),posts);
  await expect(page.getByRole('button')).toHaveCount(1);expect(links).toEqual([]);expect(posts).toEqual([{event:'OPEN'}]);
  await page.getByRole('button',{name:'I want to bid',exact:true}).click();
  await expect.poll(()=>links.length).toBe(1);
  const url=new URL(links[0]);expect(url.pathname).toBe('/13055550100');
  expect(url.searchParams.get('text')).toBe('Hey, I want to bid on the 2023 Jeep Grand Cherokee L Limited (MCS-7K2Q)');
  expect(posts).toEqual([{event:'OPEN'},{event:'TAP',code:'MCS-7K2Q'}]);
});
test('V2 print keeps photos, limit, facts and note without buttons',async({page})=>{
  const data=payload();await open(page,data);
  await page.evaluate(data=>document.querySelector('#app').innerHTML=window.MCSVitrineRender.page(data,true),data);
  await page.emulateMedia({media:'print'});
  await expect(page.getByRole('button')).toHaveCount(0);await expect(page.locator('.gallery img')).toHaveCount(3);
  for(const text of ['6-cylinder','Up to $30,000','Customer-facing note'])await expect(page.locator('.car')).toContainText(text);
  const pdf=await page.pdf({path:'/tmp/mcs-v2-print.pdf',format:'A4',printBackground:true});expect(pdf.length).toBeGreaterThan(1000);
});
