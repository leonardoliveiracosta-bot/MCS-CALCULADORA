'use strict';

const crypto = require('node:crypto');

const STATES = Object.freeze({
  AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California', CO:'Colorado', CT:'Connecticut', DE:'Delaware', FL:'Florida', GA:'Georgia', HI:'Hawaii', ID:'Idaho', IL:'Illinois', IN:'Indiana', IA:'Iowa', KS:'Kansas', KY:'Kentucky', LA:'Louisiana', ME:'Maine', MD:'Maryland', MA:'Massachusetts', MI:'Michigan', MN:'Minnesota', MS:'Mississippi', MO:'Missouri', MT:'Montana', NE:'Nebraska', NV:'Nevada', NH:'New Hampshire', NJ:'New Jersey', NM:'New Mexico', NY:'New York', NC:'North Carolina', ND:'North Dakota', OH:'Ohio', OK:'Oklahoma', OR:'Oregon', PA:'Pennsylvania', RI:'Rhode Island', SC:'South Carolina', SD:'South Dakota', TN:'Tennessee', TX:'Texas', UT:'Utah', VT:'Vermont', VA:'Virginia', WA:'Washington', WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming', DC:'District of Columbia'
});
const CODE_ALPHABET='23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_RE=/\bMCS-([23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4})\b/i;

function clean(value, maximum=240){ const text=String(value??'').normalize('NFC').replace(/\s+/g,' ').trim(); return text.slice(0,maximum); }
function locationState(value){ const code=clean(value,200).match(/^\s*([A-Z]{2})\s*-/i)?.[1]?.toUpperCase()||''; return STATES[code]||''; }
function publicVehicle(vehicle={}){
  const date=clean(vehicle.startsAt||vehicle.saleDate,80);
  return { year:Number(vehicle.year)||null, make:clean(vehicle.make,80), model:clean(vehicle.model,120), trim:clean(vehicle.trim,120), miles:Number(vehicle.miles)||null,
    exteriorColor:clean(vehicle.exteriorColor,80), interiorColor:clean(vehicle.interiorColor,80), drivetrain:clean(vehicle.drivetrain,80), transmission:clean(vehicle.transmission,80), engine:clean(vehicle.engine,120),
    state:locationState(vehicle.location)||clean(vehicle.state,80), startsAt:date||null, endsAt:clean(vehicle.endsAt,80)||null, averageAuctionValue:roundedMmr(vehicle.mmrCents),
    cleanTitle:vehicle.cleanTitle===true, odometerOk:vehicle.odometerOk===true };
}
function vehicleName(vehicle={}){ return clean([vehicle.year,vehicle.make,vehicle.model,vehicle.trim].filter(Boolean).join(' '),220); }
function roundedMmr(cents){ const amount=Number(cents)||0; return amount?Math.round(amount/5000)*50:null; }
function randomToken(){ return crypto.randomBytes(32).toString('base64url'); }
function randomCode(){ return 'MCS-'+[0,1,2,3].map(()=>CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join(''); }
function extractCode(text){ const hit=String(text||'').match(CODE_RE); return hit?'MCS-'+hit[1].toUpperCase():null; }
function deposit(cents){ const amount=Math.max(0,Number(cents)||0)/100; return amount<=5000?500:Math.round(amount*.1); }
// Auction date of one car in ms, or NaN when the car has no date (a missing date never means "year 2000").
function auctionTime(car){
  const vehicle=car?.vehicle_snapshot||car?.vehicle||car||{};
  const raw=clean(vehicle.endsAt||vehicle.startsAt||vehicle.saleDate,80);
  return raw?Date.parse(raw):NaN;
}
// 48 h after the latest auction. Cars without a date are ignored; if no car has a date the
// default window (48 h from now) applies, so a vitrine is never born expired.
function expiresAt(cars, now=Date.now()){
  const times=(cars||[]).map(auctionTime).filter(Number.isFinite);
  const latest=times.length?Math.max(...times):now;
  return new Date(latest+48*60*60*1000).toISOString();
}
function isExpired(vitrine, now=Date.now()){ return Date.parse(vitrine?.expires_at||'')<=now; }
// Public first name only: never a phone number, digits or the "Contato da Ref" placeholder.
function publicFirstName(value){
  const text=clean(value,80);
  if(!text||/\d/.test(text)||/^\+/.test(text)||/contato\s+da\s+ref/i.test(text))return null;
  const first=text.split(' ')[0].replace(/[^\p{L}'-]/gu,'');
  return first&&/\p{L}/u.test(first)?first.slice(0,40):null;
}
// An expired or closed vitrine only says so: no cars, no limit, no note, no photos.
// V1 never carries the customer's limit or the operator note (the link is made to be forwarded).
function publicResponse(vitrine,cars,urls=[],options={}){
  if(options.closed===true||isExpired(vitrine))return { expired:true, referenceCode:vitrine.reference_code };
  const v2=vitrine.version==='V2';
  return { token:vitrine.token, version:vitrine.version, referenceCode:vitrine.reference_code, customerName:publicFirstName(vitrine.customer_name), expired:false,
    cars:(cars||[]).map((car,index)=>{
      const output={code:car.short_code, vehicle:publicVehicle(car.vehicle_snapshot), averageAuctionValue:car.vehicle_snapshot?.averageAuctionValue||roundedMmr(car.vehicle_snapshot?.mmrCents), photos:[urls[index]||[]].flat(2).filter((url)=>typeof url==='string'&&url.length>0)};
      if(v2){ output.customerLimitCents=car.customer_limit_cents||null; output.note=clean(car.note_text,800)||null; }
      return output;
    }) };
}
module.exports={STATES,CODE_RE,clean,locationState,publicVehicle,vehicleName,roundedMmr,randomToken,randomCode,extractCode,deposit,auctionTime,expiresAt,isExpired,publicFirstName,publicResponse};
