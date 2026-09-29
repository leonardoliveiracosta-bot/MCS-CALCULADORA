'use strict';

// Concorrência real do bloco do Manheim: um Postgres de verdade (não o PGlite, que tem uma conexão
// só) e sessões psql separadas chamando o mesmo bloco ao mesmo tempo. Prova que a trava do lote
// serializa as chamadas: o mesmo bloco grava uma vez, o conflitante espera e é recusado sem gravar.
// Usa um banco descartável (mcs_concorrencia) no servidor indicado; nunca o banco do projeto.
// Run: PG_TEST_HOST=/caminho/do/socket PG_TEST_PORT=55432 node tests/sql/concorrencia-bloco.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { stubs } = require('./run');

const host = process.env.PG_TEST_HOST;
const port = process.env.PG_TEST_PORT || '5432';
const DB = 'mcs_concorrencia';
if (!host) { console.log('PULADO: defina PG_TEST_HOST (Postgres local descartável)'); process.exit(0); }

const args = (database) => ['-h', host, '-p', port, '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-tAq'];
function psqlSync(database, sql) {
  const run = spawnSync('psql', [...args(database), '-c', sql], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
}
function psqlFile(database, file) {
  const run = spawnSync('psql', [...args(database), '-f', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(run.stderr.slice(0, 2000));
}
// A session in its own process; resolves with its output, its error and how long it took.
function session(sql, delayMs = 0) {
  return new Promise((resolve) => setTimeout(() => {
    const started = Date.now();
    const child = spawn('psql', [...args(DB), '-c', sql]);
    let out = '', err = '';
    child.stdout.on('data', (data) => { out += data; });
    child.stderr.on('data', (data) => { err += data; });
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim(), ms: Date.now() - started }));
  }, delayMs));
}
const check = (condition, message) => { if (!condition) throw new Error('FALHA: ' + message); };

const ACTOR = '6f100000-0000-4000-8000-000000000001';
const H = (digit) => digit.repeat(64);
const car = (vin) => `jsonb_build_object('fingerprint','vin:${vin}','makeKey','honda','mmrCents',2500000,'vehicle','{"year":2021,"make":"Honda","model":"CR-V"}'::jsonb)`;
const block = (vins) => `jsonb_build_array(${vins.map(car).join(',')})`;
const chunkCall = (upload, hash, vins) => `select public.panel_manheim_batch_chunk('preview','${ACTOR}','${upload}',0,0,'${hash}',${vins.length},${block(vins)},'[]')`;
function startBatch(key, hash, count) {
  const files = JSON.stringify([{ name: 'C.csv', chunkCount: 1, vehicleCount: count, chunks: [{ count, hash }] }]);
  return JSON.parse(psqlSync(DB, `select public.panel_manheim_batch_start('preview','${ACTOR}','${key}',${count},'[["Vin"]]','{}','${files}','${H('e')}','[]','0123456789abcdef')`)).uploadId;
}
const counts = (upload) => JSON.parse(psqlSync(DB, `select json_build_object('vehicles',(select count(*) from public.manheim_vehicles where upload_id='${upload}'),'chunks',(select count(*) from public.manheim_upload_chunks where upload_id='${upload}'),'stored',(select coalesce(sum(stored_vehicle_count),0) from public.manheim_upload_chunks where upload_id='${upload}'))`));

async function main() {
  psqlSync('postgres', `drop database if exists ${DB}`);
  psqlSync('postgres', `create database ${DB}`);
  // Roles are per server: create them only when missing.
  const safeStubs = stubs.replace(/create role (\w+);/g, (_, role) => `do $$ begin create role ${role}; exception when duplicate_object then null; end $$;`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-concorrencia-'));
  const setup = path.join(dir, 'setup.sql');
  const migrations = path.join(__dirname, '..', '..', 'supabase', 'migrations');
  fs.writeFileSync(setup, safeStubs + '\n' + fs.readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort().map((name) => fs.readFileSync(path.join(migrations, name), 'utf8')).join('\n;\n'));
  psqlFile(DB, setup);
  psqlSync(DB, `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','6f100000-0000-4000-8000-000000000002','c@example.test','admin',true,false)`);
  const results = {};

  // A: the same block in two sessions; the first holds the batch lock for 1.5 s.
  const a = startBatch('a'.repeat(32), H('1'), 2);
  const [a1, a2] = await Promise.all([
    session(`begin; ${chunkCall(a, H('1'), ['VINCONC0000000001', 'VINCONC0000000002'])}; select pg_sleep(1.5); commit;`),
    session(chunkCall(a, H('1'), ['VINCONC0000000001', 'VINCONC0000000002']), 300)
  ]);
  check(a1.code === 0 && a2.code === 0, `sessões A: ${a1.err} ${a2.err}`);
  check(/"duplicate": false/.test(a1.out) && /"duplicate": true/.test(a2.out), `A: ${a1.out} | ${a2.out}`);
  check(a2.ms >= 1000, `a segunda sessão esperou a trava (${a2.ms} ms)`);
  const aCounts = counts(a);
  check(aCounts.vehicles === 2 && aCounts.chunks === 1 && aCounts.stored === 2, `A gravou uma vez: ${JSON.stringify(aCounts)}`);
  results.mesmoBloco = { primeira: 'gravou', segunda: 'duplicate=true', esperaDaSegundaMs: a2.ms, ...aCounts };

  // B: same index, other content, at the same time: waits, then refused, nothing written.
  const b = startBatch('b'.repeat(32), H('2'), 2);
  const [b1, b2] = await Promise.all([
    session(`begin; ${chunkCall(b, H('2'), ['VINCONC0000000011', 'VINCONC0000000012'])}; select pg_sleep(1.5); commit;`),
    session(chunkCall(b, H('3'), ['VINCONC0000000091', 'VINCONC0000000092']), 300)
  ]);
  check(b1.code === 0, `B1: ${b1.err}`);
  check(b2.code !== 0 && /MANHEIM_CHUNK_CONFLICT/.test(b2.err), `B2 recusado: ${b2.err}`);
  const bCounts = counts(b);
  const foreign = Number(psqlSync(DB, `select count(*) from public.manheim_vehicles where row_fingerprint in ('vin:VINCONC0000000091','vin:VINCONC0000000092')`));
  check(bCounts.vehicles === 2 && bCounts.chunks === 1 && foreign === 0, `B: ${JSON.stringify(bCounts)} estranhos=${foreign}`);
  results.conflitoSimultaneo = { primeira: 'gravou', segunda: 'MANHEIM_CHUNK_CONFLICT', esperaDaSegundaMs: b2.ms, ...bCounts, carrosDaRecusada: foreign };

  // C: eight sessions with the same block at once: one write, seven duplicates.
  const c = startBatch('c'.repeat(32), H('4'), 3);
  const many = await Promise.all(Array.from({ length: 8 }, () => session(chunkCall(c, H('4'), ['VINCONC0000000021', 'VINCONC0000000022', 'VINCONC0000000023']))));
  check(many.every((run) => run.code === 0), many.map((run) => run.err).join(' '));
  const wrote = many.filter((run) => /"duplicate": false/.test(run.out)).length;
  const cCounts = counts(c);
  check(wrote === 1 && cCounts.vehicles === 3 && cCounts.chunks === 1 && cCounts.stored === 3, `C: ${wrote} ${JSON.stringify(cCounts)}`);
  results.oitoSessoes = { gravaram: wrote, duplicate: 8 - wrote, ...cCounts };

  psqlSync('postgres', `drop database ${DB}`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('OK: concorrência real do bloco ' + JSON.stringify(results, null, 1));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
