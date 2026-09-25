(function attachVehicleCatalog(root, factory) {
  'use strict';
  const api = factory();
  if (root) root.MCSVehicleCatalog = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
  'use strict';

  // Keep this catalog aligned with MARCAS in msc-calculadora.html.
  const MODELS_BY_MAKE = Object.freeze({
    'Acura': ['ILX','Integra','TLX','TSX','TL','RLX','RL','RDX','MDX','ZDX','NSX'],
    'Alfa Romeo': ['Stelvio','Giulia'],
    'Aston Martin': ['DBX','Vantage'],
    'Audi': ['A3','A4','A5','A6','A7','A8','Allroad','Q3','Q4 e-tron','Q5','Q7','Q8','e-tron','e-tron GT','TT','R8'],
    'BMW': ['2 Series','3 Series','4 Series','5 Series','6 Series','7 Series','8 Series','X1','X2','X3','X4','X5','X6','X7','Z4','i3','i4','i5','i7','iX','M2','M3','M4','M5'],
    'Bentley': ['Bentayga','Continental GT'],
    'Buick': ['Enclave','Encore','Encore GX','Envision','Envista','LaCrosse','Lucerne','Regal','Regal TourX','Verano','Cascada','Rendezvous','Rainier','Terraza','Century'],
    'Cadillac': ['ATS','CT4','CT5','CT6','CTS','DTS','Escalade','Escalade ESV','ELR','LYRIQ','SRX','STS','XT4','XT5','XT6','XTS','XLR'],
    'Chevrolet': ['Silverado 1500','Silverado 2500HD','Silverado 3500HD','Colorado','Equinox','Traverse','Tahoe','Suburban','Blazer','Trailblazer','Trax','Malibu','Impala','Cruze','Sonic','Spark','Camaro','Corvette','Bolt EV','Bolt EUV','Express','Avalanche','HHR','Captiva Sport','Volt'],
    'Chrysler': ['300','200','Pacifica','Voyager','Town and Country','Sebring','PT Cruiser','Aspen','Crossfire','300M'],
    'Dodge': ['Charger','Challenger','Durango','Journey','Grand Caravan','Caravan','Dart','Avenger','Caliber','Nitro','Magnum','Viper','Hornet','Dakota','Ram 1500'],
    'Ferrari': ['488','California'],
    'Fiat': ['500','500X'],
    'Ford': ['F-150','F-250 Super Duty','F-350 Super Duty','F-150 Lightning','Ranger','Maverick','Escape','Explorer','Edge','Expedition','Bronco','Bronco Sport','EcoSport','Flex','Fusion','Focus','Fiesta','Taurus','Mustang','Mustang Mach-E','Transit','Transit Connect','C-Max','Five Hundred','Freestyle'],
    'Genesis': ['G70','G80','G90','GV60','GV70','GV80','GV80 Coupe'],
    'GMC': ['Sierra 1500','Sierra 2500HD','Sierra 3500HD','Canyon','Terrain','Acadia','Yukon','Yukon XL','Savana','Hummer EV','Envoy','Sonoma'],
    'Honda': ['Accord','Civic','CR-V','HR-V','Pilot','Passport','Odyssey','Ridgeline','Fit','Insight','Element','CR-Z','Crosstour','Prologue'],
    'Hummer': ['H1','H2','H3','H3T'],
    'Hyundai': ['Elantra','Sonata','Accent','Veloster','Azera','Genesis','Equus','Tucson','Santa Fe','Santa Fe Sport','Santa Cruz','Kona','Palisade','Venue','Veracruz','Ioniq','Ioniq 5','Ioniq 6','Nexo'],
    'Infiniti': ['Q50','Q60','Q70','QX50','QX55','QX60','QX70','QX80','G35','G37','M35','M37','EX35','FX35','JX35'],
    'Jaguar': ['F-PACE','F-TYPE'],
    'Jeep': ['Wrangler','Grand Cherokee','Grand Cherokee L','Cherokee','Compass','Renegade','Gladiator','Patriot','Liberty','Commander','Wagoneer','Grand Wagoneer'],
    'Kia': ['Forte','Optima','K5','Rio','Soul','Soul EV','Sorento','Sportage','Telluride','Seltos','Carnival','Sedona','Cadenza','Stinger','Niro','EV6','EV9','Amanti','Rondo','Borrego'],
    'Land Rover': ['Range Rover','Range Rover Sport','Range Rover Velar','Range Rover Evoque','Discovery','Discovery Sport','Defender','LR2','LR3','LR4','Freelander'],
    'Lamborghini': ['Urus','Huracan'],
    'Lexus': ['ES','IS','GS','LS','RC','LC','CT','HS','UX','NX','RX','GX','LX','TX','RZ','SC'],
    'Lincoln': ['Navigator','Aviator','Corsair','Nautilus','Continental','MKZ','MKX','MKC','MKS','MKT','Town Car','Mark LT'],
    'Lotus': ['Evora','Emira'],
    'Lucid': ['Air','Gravity'],
    'Mazda': ['Mazda3','Mazda6','Mazda5','Mazda2','CX-3','CX-30','CX-5','CX-50','CX-7','CX-9','CX-70','CX-90','MX-5 Miata','MX-30','Tribute'],
    'Mercedes-Benz': ['A-Class','C-Class','E-Class','S-Class','CLA','CLS','GLA','GLB','GLC','GLE','GLS','G-Class','ML-Class','GL-Class','GLK-Class','SLK','SL','AMG GT','EQB','EQE','EQS','Sprinter','Metris','Maybach S-Class'],
    'Maserati': ['Levante','Ghibli'],
    'McLaren': ['570S','720S'],
    'Mercury': ['Grand Marquis','Milan','Mariner','Mountaineer','Sable','Montego','Monterey','Marauder','Villager'],
    'MINI': ['Cooper Hardtop','Cooper Convertible','Clubman','Countryman','Paceman','Coupe','Roadster','Cooper SE','John Cooper Works'],
    'Mitsubishi': ['Outlander','Outlander Sport','Outlander PHEV','Eclipse Cross','Mirage','Mirage G4','Lancer','Lancer Evolution','Galant','Endeavor','Eclipse','Montero','Raider','i-MiEV'],
    'Nissan': ['Altima','Sentra','Versa','Versa Note','Maxima','Rogue','Rogue Sport','Murano','Pathfinder','Armada','Frontier','Titan','Titan XD','Kicks','Juke','Leaf','Ariya','370Z','350Z','Z','GT-R','Quest','Xterra','Cube','NV200'],
    'Pontiac': ['G6','G5','G8','G3','Grand Prix','Grand Am','Vibe','Torrent','Solstice','Montana','Aztek','GTO','Bonneville','Sunfire'],
    'Polestar': ['2','3'],
    'Porsche': ['911','Cayenne','Macan','Panamera','Taycan','718 Cayman','718 Boxster','Cayman','Boxster'],
    'Ram': ['1500','1500 Classic','2500','3500','ProMaster','ProMaster City','Dakota'],
    'Rivian': ['R1S','R1T'],
    'Rolls-Royce': ['Cullinan','Ghost'],
    'Saab': ['9-3','9-5','9-7X','9-2X','9-4X'],
    'Saturn': ['Vue','Ion','Aura','Outlook','Sky','Astra','L300','Relay'],
    'Scion': ['tC','xB','xA','xD','iA','iM','iQ','FR-S'],
    'Subaru': ['Outback','Forester','Crosstrek','Impreza','WRX','WRX STI','Legacy','Ascent','BRZ','Solterra','Tribeca','Baja','XV Crosstrek'],
    'Suzuki': ['Grand Vitara','SX4','Kizashi','Forenza','Reno','Aerio','XL7','Verona','Equator','Vitara'],
    'Tesla': ['Model 3','Model Y','Model S','Model X','Cybertruck','Roadster'],
    'Toyota': ['Camry','Corolla','Corolla Cross','RAV4','Highlander','Grand Highlander','4Runner','Tacoma','Tundra','Sequoia','Land Cruiser','Sienna','Prius','Prius C','Prius V','Avalon','Venza','C-HR','Yaris','Matrix','FJ Cruiser','Supra','GR86','bZ4X','Crown'],
    'Volkswagen': ['Jetta','Passat','Golf','Golf GTI','Tiguan','Atlas','Atlas Cross Sport','Taos','ID.4','Beetle','CC','Arteon','Touareg','Routan','Eos','Rabbit'],
    'VinFast': ['VF 8','VF 9'],
    'Volvo': ['XC90','XC60','XC40','S60','S80','S90','V60','V90','V70','XC70','C30','C70','S40','V50','EX30','EX90']
  });

  function clean(value) { return String(value === null || value === undefined ? '' : value).normalize('NFC').trim(); }
  function fold(value) { return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function withoutSequence(tokens, sequence) {
    if (!sequence.length || sequence.length > tokens.length) return tokens;
    for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
      if (sequence.every((token, offset) => tokens[index + offset] === token)) return tokens.slice(0, index).concat(tokens.slice(index + sequence.length));
    }
    return tokens;
  }
  function modelTokens(value, make) {
    let tokens = fold(value).split(' ').filter(Boolean).filter((token) => token !== 'class');
    tokens = withoutSequence(tokens, fold(make).split(' ').filter(Boolean));
    return tokens;
  }
  function containsWords(longer, shorter) {
    if (!shorter.length || shorter.length > longer.length) return false;
    for (let index = 0; index <= longer.length - shorter.length; index += 1) {
      if (shorter.every((token, offset) => longer[index + offset] === token)) return true;
    }
    return false;
  }
  function modelsMatch(left, right, leftMake, rightMake) {
    const a = modelTokens(left, leftMake);
    const b = modelTokens(right, rightMake);
    if (!a.length || !b.length) return false;
    return containsWords(a, b) || containsWords(b, a);
  }
  function inferMake(model) {
    const matches = Object.entries(MODELS_BY_MAKE).filter(([make, models]) => models.some((candidate) => modelsMatch(model, candidate, '', make))).map(([make]) => make);
    return { make: matches.length === 1 ? matches[0] : '', ambiguous: matches.length > 1, candidates: matches };
  }
  function readableLocation(value) {
    const source = clean(value);
    const match = source.match(/^([A-Za-z]{2})\s*-\s*(.+)$/);
    if (!match) return source;
    const city = match[2].toLocaleLowerCase('en-US').replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase('en-US'));
    return `${city}, ${match[1].toUpperCase()}`;
  }

  return { MODELS_BY_MAKE, clean, fold, inferMake, modelTokens, modelsMatch, readableLocation };
}));
