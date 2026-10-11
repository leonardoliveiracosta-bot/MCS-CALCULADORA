'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { listingURL, publicIPv4, readPublicPage, parseListing } = require('../listing-reference-server');
const ld = object => '<script type="application/ld+json">' + JSON.stringify(object) + '</script>';

test('reads exact structured vehicle, never listing price, mileage or VIN into criteria', () => {
  assert.deepEqual(parseListing(ld({ '@type':'Car', brand:{name:'BMW'}, model:'X3', vehicleModelDate:'2021', vehicleConfiguration:'xDrive30i', mileageFromOdometer:{value:35000}, vehicleIdentificationNumber:'private', offers:{price:26771} })), {make:'BMW',model:'X3',year:2021,trim:'xDrive30i'});
});
test('recognizes a single vehicle title, and leaves unspecified trim/year absent', () => {
  assert.deepEqual(parseListing('<title>Used 2021 BMW X3 for Sale</title>'), {make:'BMW',model:'X3',year:2021});
  assert.deepEqual(parseListing('<title>BMW X3 for Sale</title>'), {make:'BMW',model:'X3'});
  assert.equal(parseListing('<title>Browse cars under $20,000</title>'), null);
});
test('multiple vehicles cannot silently pick the first car', () => {
  assert.equal(parseListing(ld([{ '@type':'Car',name:'2021 BMW X3' }, { '@type':'Car',name:'2022 Tesla Model 3' }]) + '<title>2021 BMW X3</title>'), null);
});
test('contradictory metadata cannot fall back to a plausible title', () => {
  assert.equal(parseListing(ld({'@type':'Car',brand:'Tesla',model:'Model 3',name:'2021 BMW X3'})+'<title>2021 BMW X3</title>'),null);
  assert.equal(parseListing(ld({'@type':'Car',name:'2021 BMW X3',vehicleModelDate:2022})+'<title>2021 BMW X3</title>'),null);
});
test('structured graph identity, no invented range or dealer data', () => {
  assert.deepEqual(parseListing(ld({'@graph':[{'@type':'Organization',name:'Dealer'}, {'@type':'Vehicle',name:'2022 Tesla Model 3'}]})), {make:'Tesla',model:'Model 3',year:2022});
  assert.equal(parseListing(ld({'@type':'Product',name:'Floor mats for BMW'})), null);
});
test('URL rejects credentials, IP literals, local names, custom ports and non-https', () => {
  for (const value of ['file:///etc/passwd','http://example.com/car','https://127.0.0.1/car','https://[::1]/','https://user:secret@example.com/car','https://example.com:8443/car','https://test.local/car','https://localhost/car','https://0x7f000001/car','https://2130706433/']) assert.throws(() => listingURL(value), /INVALID_URL/);
  assert.equal(listingURL('https://example.com/car?id=1#photos').href,'https://example.com/car?id=1');
});
test('public DNS gate excludes internal and metadata networks', () => {
  for (const ip of ['127.0.0.1','10.1.2.3','172.16.0.1','172.31.255.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','224.1.1.1']) assert.equal(publicIPv4(ip),false,ip);
  assert.equal(publicIPv4('8.8.8.8'),true);
});
function requestMock(responses, calls) {
  return (url, options, done) => {
    calls.push({url:url.href,options});
    const request = new EventEmitter();
    request.destroy = error => { request.emit('error',error); request.emit('close'); };
    request.end = () => queueMicrotask(() => {
      const value = responses.shift(); const res = new EventEmitter();
      res.statusCode = value.status || 200; res.headers = { 'content-type':'text/html', ...value.headers };
      res.resume = () => request.emit('close'); done(res);
      if (res.statusCode === 200) { res.emit('data',Buffer.from(value.html || '')); res.emit('end'); request.emit('close'); }
    });
    return request;
  };
}
test('one page read pins the validated DNS address into the connection', async () => {
  const calls=[];
  const html = await readPublicPage('https://example.com/car', {lookup:async()=>[{address:'8.8.8.8',family:4}],request:requestMock([{html:'<title>2021 BMW X3</title>'}],calls)});
  assert.match(html,/BMW X3/);assert.equal(calls.length,1);
  calls[0].options.lookup('example.com',{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);});
});
test('private DNS and redirect target are rejected before requesting them', async () => {
  let calls=0;
  await assert.rejects(readPublicPage('https://example.com/car',{lookup:async()=>[{address:'127.0.0.1',family:4}],request:()=>{calls++;}}),/INVALID_URL/);
  assert.equal(calls,0);
  const requests=[];
  await assert.rejects(readPublicPage('https://example.com/car',{lookup:async()=>[{address:'8.8.8.8',family:4}],request:requestMock([{status:302,headers:{location:'https://169.254.169.254/'}}],requests)}),/INVALID_URL/);
  assert.equal(requests.length,1);
});
test('API rejects invalid URL/method with explicit error rather than empty success', async () => {
  const handler=require('../api/listing-reference');
  for (const [req, expected] of [[{method:'POST'},405],[{method:'GET',query:{url:'https://127.0.0.1'}},400]]) {
    let status,body;
    const res={setHeader(){},status(code){status=code;return this;},json(value){body=value;return this;}};
    await handler(req,res);assert.equal(status,expected);assert.ok(body.error);assert.equal(body.vehicle,undefined);
  }
});
