'use strict';

// Cartão 5 "REALIDADE · SÓ PARA VOCÊ": a lista de opções do lote dentro dos filtros, determinística (sem IA).
// Cada linha: ano + modelo (como vem no CSV) + terceira coluna:
//  1. lance máximo informado (> 0)                          → milhas
//  2. sem lance e sem teto de milhas                        → quatro colunas: ano, modelo, milhas, MMR
//  3. sem lance, todas as linhas com MMR e mais de um valor → MMR (o rótulo diz que é MMR)
//  4. sem lance e (MMR igual em todas ou alguma sem MMR)    → milhas; o veredito traz o MMR típico
// Ordem: ano decrescente, depois milhas crescente. MMR da linha = MMR do próprio carro (sem ele, o típico do
// ano/modelo, mediana do lote). Um carro por VIN: o mesmo VIN em Lane/Run e em Buy Now é uma linha só.
// A lista mostra até 80 carros; o veredito conta todos.
const fold = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
function median(values) {
  const sorted = values.map(Number).filter((value) => value > 0).sort((a, b) => a - b);
  return sorted.length ? Math.round((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2) : null;
}
const keyOf = (car) => fold(car.make) + '|' + fold(car.model) + '|' + String(car.year || '');
const MAX_ROWS = 80;
// The same car (VIN) is one option, whatever the sale (Lane/Run, Buy Now) or the CSV row it came from.
const carKey = (car) => { const vin = String(car.vin || '').trim().toUpperCase(); return vin ? 'vin:' + vin : car.rowFingerprint || keyOf(car) + '|' + car.miles; };

function realityList({ options = [], reference = [], maxBidCents = null, milesCap = false, typicalCents = [] }) {
  const byKey = new Map();
  reference.forEach((car) => { const key = keyOf(car); if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(car.mmrCents); });
  const seen = new Set();
  const rows = options.filter((car) => { const id = carKey(car); if (seen.has(id)) return false; seen.add(id); return true; })
    .map((car) => ({ year: Number(car.year) || null, model: String(car.model || '').trim(), miles: car.miles === null || car.miles === undefined || car.miles === '' ? null : Number(car.miles), mmrCents: Number(car.mmrCents) > 0 ? Number(car.mmrCents) : median(byKey.get(keyOf(car)) || []) }))
    .sort((a, b) => (b.year || 0) - (a.year || 0) || (a.miles ?? Infinity) - (b.miles ?? Infinity));
  const hasBid = Number(maxBidCents) > 0;
  const allMmr = rows.length > 0 && rows.every((row) => row.mmrCents > 0);
  const distinct = new Set(rows.map((row) => row.mmrCents).filter((value) => value > 0)).size;
  const column = hasBid ? 'MILHAS' : !milesCap ? 'MILHAS_MMR' : allMmr && distinct > 1 ? 'MMR' : 'MILHAS';
  const typical = median(typicalCents);
  const filters = [hasBid ? 'dentro do teto' : null, milesCap ? 'dentro das milhas' : null].filter(Boolean);
  const count = rows.length;
  const verdict = count ? `${count} ${count === 1 ? 'opção' : 'opções'} ${filters.length ? filters.join(' e ').replace('dentro do teto e dentro das milhas', 'dentro do teto e das milhas') : 'no lote'}` : 'Nenhuma opção no lote dentro dos filtros';
  const label = column === 'MMR' ? 'Valor de mercado (MMR)' : column === 'MILHAS_MMR' ? 'Opções no lote' : hasBid ? 'Dentro do teto' : 'Dentro das milhas';
  return { column, verdict, typicalCents: column === 'MMR' || column === 'MILHAS_MMR' ? null : typical, label: count ? label + ' · ' + count + (count > MAX_ROWS ? ` (mostrando ${MAX_ROWS})` : '') : null, rows: rows.slice(0, MAX_ROWS) };
}

module.exports = { realityList, median, fold, carKey };
