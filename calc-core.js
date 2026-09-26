(function(root, factory){
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MCSCalcCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function(){
'use strict';
const CONFIG = {


  whatsapp: "13055400742",


  taxaLeilao: [
    { ate: 2900,     valor: 300 },
    { ate: 5000,     valor: 400 },
    { ate: 7500,     valor: 490 },
    { ate: 9900,     valor: 550 },
    { ate: Infinity, valor: 600 }
  ],


  taxasFixasLeilao: [
    { nome: "Environmental Fee",  valor: 50 },
    { nome: "Title Mailing Fee",  valor: 45 }
  ],


  servico: {
    faixas: [
      { ate: 3000,  valor: 250 },
      { ate: 5000,  valor: 350 },
      { ate: 7500,  valor: 450 },
      { ate: 10000, valor: 550 },
      { ate: 15000, valor: 650 },
      { ate: 20000, valor: 800 }
    ],

    limite: 20000,
    base: 800,
    blocoAdicional: 2500,
    valorPorBloco: 50
  },


  inspecao: 165,


  documentacaoFixa: 599,


  impostoPct: 7,


  estados: [
    { nome: "Arizona",        pct: 5.6   },
    { nome: "California",     pct: 7.25  },
    { nome: "Colorado",       pct: 2.9   },
    { nome: "Connecticut",    pct: 6.35  },
    { nome: "Georgia",        pct: 7     },
    { nome: "Illinois",       pct: 6.25  },
    { nome: "Indiana",        pct: 7     },
    { nome: "Louisiana",      pct: 5     },
    { nome: "Maryland",       pct: 6     },
    { nome: "Massachusetts",  pct: 6.25  },
    { nome: "Michigan",       pct: 6     },
    { nome: "Minnesota",      pct: 6.875 },
    { nome: "Missouri",       pct: 4.225 },
    { nome: "Nevada",         pct: 6.85  },
    { nome: "New Jersey",     pct: 6.625 },
    { nome: "New York",       pct: 4     },
    { nome: "North Carolina", pct: 3     },
    { nome: "Ohio",           pct: 5.75  },
    { nome: "Oklahoma",       pct: 4.5   },
    { nome: "Pennsylvania",   pct: 6     },
    { nome: "South Carolina", pct: 5, teto: 500 },
    { nome: "Tennessee",      pct: 7     },
    { nome: "Texas",          pct: 6.25  },
    { nome: "Virginia",       pct: 4.15  },
    { nome: "Washington",     pct: 6.8   },
    { nome: "Alabama",        pct: 2     },
    { nome: "Arkansas",       pct: 6.5   },
    { nome: "Iowa",           pct: 5     },
    { nome: "Kansas",         pct: 6.5   },
    { nome: "Kentucky",       pct: 6     },
    { nome: "Mississippi",    pct: 5     },
    { nome: "New Mexico",     pct: 4     },
    { nome: "Oregon",         pct: 0     },
    { nome: "Utah",           pct: 4.85  },
    { nome: "Wisconsin",      pct: 5     },
    { nome: "Alaska",         pct: 0     },
    { nome: "Montana",        pct: 0     },
    { nome: "New Hampshire",  pct: 0     },
    { nome: "Hawaii",         pct: 4     },
    { nome: "Wyoming",        pct: 4     },
    { nome: "South Dakota",   pct: 4     },
    { nome: "Maine",          pct: 5.5   },
    { nome: "Nebraska",       pct: 5.5   },
    { nome: "North Dakota",   pct: 5     },
    { nome: "Idaho",          pct: 6     },
    { nome: "Vermont",        pct: 6     },
    { nome: "West Virginia",  pct: 6     },
    { nome: "Rhode Island",   pct: 7     }
  ],


  titulo: {
    transferencia: 350,       // transferência de placa + título + registration + tag provisória
    placaNova: 550            // placa de metal nova + título + registration + tag provisória
  },


  margemTotalPct: 0,


  depositoPct: 10,
  depositoMinimo: 500,


  diasRetirada: 6,


  lanceMinimo: 3000,
  lanceMaximo: 300000,
  financiamentoMinimo: 10000
};

const ZIP_UF = [
  ["AL",350,369],["AK",995,999],["AZ",850,865],["AR",716,729],["CA",900,961],
  ["CO",800,816],["CT",60,69],["DE",197,199],["DC",200,200],["DC",202,205],
  ["FL",320,349],["GA",300,319],["GA",398,399],["HI",967,968],["ID",832,838],
  ["IL",600,629],["IN",460,479],["IA",500,528],["KS",660,679],["KY",400,427],
  ["LA",700,714],["ME",39,49],["MD",206,219],["MA",10,27],["MA",55,55],
  ["MI",480,499],["MN",550,567],["MS",386,397],["MO",630,658],["MT",590,599],
  ["NE",680,693],["NV",889,898],["NH",30,38],["NJ",70,89],["NM",870,884],
  ["NY",5,5],["NY",100,149],["NC",270,289],["ND",580,588],["OH",430,459],
  ["OK",730,749],["OR",970,979],["PA",150,196],["PR",6,9],["RI",28,29],
  ["SC",290,299],["SD",570,577],["TN",370,385],["TX",750,799],["TX",885,885],
  ["UT",840,847],["VT",50,54],["VT",56,59],["VA",201,201],["VA",220,246],
  ["WA",980,994],["WV",247,268],["WI",530,549],["WY",820,831]
];

const UF_NOME = {
  AL:"Alabama", AK:"Alaska", AZ:"Arizona", AR:"Arkansas", CA:"California",
  CO:"Colorado", CT:"Connecticut", DE:"Delaware", DC:"District of Columbia",
  FL:"Florida", GA:"Georgia", HI:"Hawaii", ID:"Idaho", IL:"Illinois",
  IN:"Indiana", IA:"Iowa", KS:"Kansas", KY:"Kentucky", LA:"Louisiana",
  ME:"Maine", MD:"Maryland", MA:"Massachusetts", MI:"Michigan",
  MN:"Minnesota", MS:"Mississippi", MO:"Missouri", MT:"Montana",
  NE:"Nebraska", NV:"Nevada", NH:"New Hampshire", NJ:"New Jersey",
  NM:"New Mexico", NY:"New York", NC:"North Carolina", ND:"North Dakota",
  OH:"Ohio", OK:"Oklahoma", OR:"Oregon", PA:"Pennsylvania",
  PR:"Puerto Rico", RI:"Rhode Island", SC:"South Carolina",
  SD:"South Dakota", TN:"Tennessee", TX:"Texas", UT:"Utah", VT:"Vermont",
  VA:"Virginia", WA:"Washington", WV:"West Virginia", WI:"Wisconsin",
  WY:"Wyoming"
};

/* devolve { uf, nome } ou null se o ZIP nao existir */
function zipEstado(zip){
  var v = String(zip || "").replace(/\D/g, "");
  if (v.length !== 5 && v.length !== 9) return null;
  var p = parseInt(v.slice(0, 3), 10);
  for (var i = 0; i < ZIP_UF.length; i++){
    if (p >= ZIP_UF[i][1] && p <= ZIP_UF[i][2]){
      return { uf: ZIP_UF[i][0], nome: UF_NOME[ZIP_UF[i][0]] };
    }
  }
  return null;
}

function defaultParams(){
  return {
    margemPct: CONFIG.margemTotalPct, depPct: CONFIG.depositoPct,
    depMin: CONFIG.depositoMinimo, impostoPct: CONFIG.impostoPct,
    inspecao: CONFIG.inspecao, documentacaoFixa: CONFIG.documentacaoFixa,
    transferencia: CONFIG.titulo.transferencia, placaNova: CONFIG.titulo.placaNova,
    dias: CONFIG.diasRetirada, ovLeilao: null, ovServico: null
  };
}

function taxaLeilaoDe(lance, P = defaultParams()){
  if (P.ovLeilao !== null) return P.ovLeilao;
  for (const f of CONFIG.taxaLeilao){
    if (lance <= f.ate) return f.valor;
  }
  return CONFIG.taxaLeilao[CONFIG.taxaLeilao.length - 1].valor;
}

function servicoDe(lance, P = defaultParams()){
  if (P.ovServico !== null) return P.ovServico;
  for (const f of CONFIG.servico.faixas){
    if (lance <= f.ate) return f.valor;
  }
  const s = CONFIG.servico;
  const blocos = Math.ceil((lance - s.limite) / s.blocoAdicional);
  return s.base + (blocos * s.valorPorBloco);
}

function calcular(d, P = defaultParams()){
  const lance      = d.lance;
  const taxaLeilao = taxaLeilaoDe(lance, P);
  const servico    = servicoDe(lance, P);
  const inspecao   = d.inspecao ? P.inspecao : 0;
  const fixas      = CONFIG.taxasFixasLeilao;
  const totalFixas = fixas.reduce(function(a, f){ return a + f.valor; }, 0);
  const documentacaoFixa  = P.documentacaoFixa;

  /* BASE = lance + taxas do leilao + servico + valor fixo da compra.
     Inspecao e titulo/placa ficam deliberadamente fora da base. */
  const baseImposto = lance + taxaLeilao + totalFixas + servico + documentacaoFixa;

  const r = {
    lance: lance,
    taxaLeilao: taxaLeilao,
    fixas: fixas,
    totalFixas: totalFixas,
    servico: servico,
    inspecao: inspecao,
    documentacaoFixa: documentacaoFixa,
    base: baseImposto,
    florida: d.florida,
    imposto: null,
    titulo: (d.pgto === "fin" || d.placa === "nova") ? P.placaNova : P.transferencia,
    total: null,
    totalMin: null,
    totalMax: null,
    deposito: Math.max(lance * (P.depPct / 100), P.depMin)
  };

  if (d.florida){
    r.imposto = Math.round(baseImposto * (P.impostoPct / 100));
  }


  r.estadoNome = null;
  r.estadoOutro = (!d.florida && d.estado === "other");
  r.estadoPct  = null;
  r.estadoTeto = null;
  r.estadoNoTeto = false;
  r.impostoEstado = null;
  if (!d.florida && d.estado !== "" && d.estado !== "other"){
    const e = CONFIG.estados[parseInt(d.estado, 10)];
    if (e){
      r.estadoNome = e.nome;
    }
    if (e && e.pct !== null){
      r.estadoPct  = e.pct;
      r.estadoTeto = (typeof e.teto === "number") ? e.teto : null;
      r.impostoEstado = Math.round(baseImposto * (e.pct / 100));
      if (r.estadoTeto !== null && r.impostoEstado > r.estadoTeto){
        r.impostoEstado = r.estadoTeto;
        r.estadoNoTeto  = true;
      }
    }
  }

  if (!d.florida && !r.estadoNome){
    var estadoZip = zipEstado(d.zip);
    r.estadoNome = estadoZip ? estadoZip.nome : null;
  }

  const L  = Math.round(lance);
  const A  = Math.round(taxaLeilao) + fixas.reduce(function(a, f){ return a + Math.round(f.valor); }, 0);
  const S  = Math.round(servico);
  const I  = Math.round(inspecao);
  const TI = Math.round(r.titulo);
  const D  = Math.round(documentacaoFixa);
  const TAX = d.florida ? r.imposto : r.impostoEstado;
  const caso = d.florida ? (d.pgto === "fin" ? 2 : 1)
                         : (d.pgto === "fin" ? 4 : 3);
  const G = caso === 3 ? D : (D + TI + (TAX !== null ? TAX : 0));

  r.gCarro  = L;
  r.gLeilao = A;
  r.dCarro   = L;
  r.dLeilao  = A;
  r.dMcs     = S + I;
  r.gMcs    = S + I;
  r.gImposto = TAX;
  r.gGrupo   = G;
  r.gTaxReg  = G;
  r.caso     = caso;
  r.taxDesconhecido = (caso === 4 && TAX === null);
  r.acimaLance = A + G + S + I;
  r.totalProjetado = L + r.acimaLance;

  /* Caso 3: o envio do titulo sai do leilao e vai para "Purchase & title".
     So muda a exibicao; base, acima do lance e total ficam iguais.      */
  r.fixasLeilao = fixas;
  if (caso === 3){
    var tm = fixas.filter(function(f){ return f.nome === "Title Mailing Fee"; })
                  .reduce(function(a, f){ return a + Math.round(f.valor); }, 0);
    r.fixasLeilao = fixas.filter(function(f){ return f.nome !== "Title Mailing Fee"; });
    r.dLeilao = A - tm;
    r.gLeilao = A - tm;
    r.gGrupo  = G + tm;
    r.gTaxReg = G + tm;
  }

  if (d.pgto === "cash"){
    r.total = r.totalProjetado;
    const m = P.margemPct / 100;
    r.totalMin = r.total * (1 - m);
    r.totalMax = r.total * (1 + m);
  }
  return r;
}

return { CONFIG, defaultParams, taxaLeilaoDe, servicoDe, calcular, zipEstado };
});
