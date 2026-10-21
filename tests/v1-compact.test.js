'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {publicResponse} = require('../vitrine-domain');
const vitrine = {version:'V1', reference_code:'DEMO2', expires_at:'2099-12-31T00:00:00Z'};
const car = {short_code:'MCS-7K2Q', vehicle_snapshot:{year:2023, make:'Jeep', model:'Grand Cherokee L', vin:'1C4RJKBG0P8004352', engine:'6-cylinder', transmission:'Automatic', drivetrain:'AWD', interiorColor:'Black', mmrCents:2500000}, customer_limit_cents:3000000, note_text:'INTERNAL'};
function render(data, print = false) {
  const context={window:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../v/vitrine-render.js'),'utf8'),context);
  return context.window.MCSVitrineRender.page(data,print);
}
test('V1 exposes only a valid VIN ending and four imported facts, never private limit, full VIN, CR or notes',()=>{
  const output=publicResponse(vitrine,[car]);
  assert.equal(output.cars[0].vinLast6,'004352');
  const html=render(output);
  for(const value of ['6-cylinder','Automatic','AWD','Black','004352']) assert.ok(html.includes(value));
  for(const text of [car.vehicle_snapshot.vin,'INTERNAL','customerLimitCents','conditionGrade']) assert.ok(!JSON.stringify(output).includes(text));
  assert.ok(!html.includes('Your limit'));
  assert.equal((html.match(/<button/g)||[]).length,1,'one direct action per car, no extra step');
  const v2=publicResponse({...vitrine,version:'V2'},[car]);
  assert.equal(v2.cars[0].vinLast6,undefined);
  assert.equal(v2.cars[0].customerLimitCents,3000000);
  assert.equal(v2.cars[0].note,'INTERNAL');
  assert.equal(publicResponse(vitrine,[{...car,vehicle_snapshot:{...car.vehicle_snapshot,vin:'invalid'}}]).cars[0].vinLast6,undefined);
});
test('V1 prints the same facts without actions, escapes imported text and omits missing price and time',()=>{
  const data=publicResponse(vitrine,[{...car,vehicle_snapshot:{...car.vehicle_snapshot,engine:'<img src=x onerror=alert(1)>',mmrCents:null,startsAt:'2099-10-01'}}]);
  const html=render(data,true);
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('Oct 1'));
  for(const absent of ['<button','onerror=alert(1)>','Auction time','Auction reference','$0']) assert.ok(!html.includes(absent),absent);
  const missing=render({...data,cars:[{...data.cars[0],vehicle:{miles:null}}]});
  assert.ok(!missing.includes('0 mi'));
  assert.ok(missing.includes('Not listed'));
  const zero=render({...data,cars:[{...data.cars[0],vehicle:{miles:0}}]});
  assert.ok(zero.includes('0 mi'));
});
