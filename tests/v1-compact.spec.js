'use strict';
const {test, expect}=require('@playwright/test');
const {publicResponse}=require('../vitrine-domain');
if(process.env.CHROMIUM_PATH) test.use({launchOptions:{executablePath:process.env.CHROMIUM_PATH}});
const base='http://127.0.0.1:4173';
const payload=()=>({...publicResponse({token:'DEMO',version:'V1',reference_code:'DEMO2',customer_name:'Alex',expires_at:'2099-12-31T00:00:00Z'},[
  {short_code:'MCS-7K2Q',vehicle_snapshot:{year:2023,make:'Jeep',model:'Grand Cherokee L',trim:'Limited',vin:'1C4RJKBG0P8004352',miles:20000,engine:'6-cylinder',transmission:'Automatic',drivetrain:'AWD',interiorColor:'Black',exteriorColor:'White',state:'Tennessee',startsAt:'2099-10-22T15:00:00Z',estimatedMarketReference:27880,cleanTitle:true,odometerOk:true}},
  {short_code:'MCS-8K2Q',vehicle_snapshot:{year:2023,make:'Jeep',model:'Grand Cherokee L',trim:'Limited',vin:'1C4RJKBG0P8009012',miles:26500,estimatedMarketReference:29100}}
]),whatsAppNumber:'13055550100'});
async function open(page,data,posts=[]){
  await page.route('https://fonts.googleapis.com/**',r=>r.abort());
  await page.route('**/api/vitrine?**',r=>{
    if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());return r.fulfill({json:{accepted:true}});}
    return r.fulfill({json:data});
  });
  await page.goto(base+'/v/index.html');
  await expect(page.locator('.mcs-car')).toHaveCount(data.cars.length);
}
for(const colorScheme of ['light','dark']) for(const width of [320,390,1280]){
  test(`V1 ${colorScheme} at ${width}: readable hierarchy, compact facts, no overflow`,async({page})=>{
    await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await open(page,payload());
    const car=page.locator('.mcs-car').first();
    for(const text of ['6-cylinder','Automatic','AWD','Black','004352','$27,880']) await expect(car).toContainText(text);
    await expect(car).not.toContainText('1C4RJKBG0P8');
    const metrics=await car.evaluate(el=>{
      const label=getComputedStyle(el.querySelector('dt')),value=getComputedStyle(el.querySelector('dd'));
      return {labelSize:label.fontSize,valueSize:value.fontSize,labelWeight:label.fontWeight,valueWeight:value.fontWeight,labelColor:label.color,valueColor:value.color,columns:getComputedStyle(el.querySelector('dl')).gridTemplateColumns.split(' ').length,height:el.getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    expect(metrics).toMatchObject({labelSize:'16px',valueSize:'18px',labelWeight:'400',valueWeight:'600',columns:width>600?3:2,overflow:false});
    expect(metrics.labelColor).not.toBe(metrics.valueColor);
    if(width>600)expect(metrics.height).toBeLessThan(420);
    expect(errors).toEqual([]);
    if(width===390||width===1280)await page.screenshot({path:`/tmp/mcs-v1-${colorScheme}-${width}.png`,fullPage:true});
  });
}
test('V1 selection keeps the selected car code, sends TAP, and opens WhatsApp only after a click',async({page})=>{
  const posts=[],links=[];
  await page.route('https://wa.me/**',r=>{links.push(r.request().url());return r.fulfill({body:'Mock WhatsApp'});});
  await open(page,payload(),posts);
  expect(posts).toEqual([{event:'OPEN'}]);expect(links).toEqual([]);
  await page.locator('.mcs-car').nth(1).getByRole('button',{name:'Show me this car',exact:true}).click();
  await expect.poll(()=>links.length).toBe(1);
  const url=new URL(links[0]);expect(url.pathname).toBe('/13055550100');
  expect(url.searchParams.get('text')).toBe("Hey, I'd like to see the 2023 Jeep Grand Cherokee L Limited (MCS-8K2Q)");
  expect(posts).toEqual([{event:'OPEN'},{event:'TAP',code:'MCS-8K2Q'}]);
});
test('V1 print preserves facts and omits buttons',async({page})=>{
  await open(page,payload());await page.evaluate(data=>{document.querySelector('#app').innerHTML=window.MCSVitrineRender.page(data,true);},payload());
  await page.emulateMedia({media:'print'});
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.locator('.mcs-car').first()).toContainText('6-cylinder');
  const pdf=await page.pdf({path:'/tmp/mcs-v1-print.pdf',format:'A4',printBackground:true});expect(pdf.length).toBeGreaterThan(1000);
});
