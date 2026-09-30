'use strict';

// Concorrência real do teto da OpenAI na conferência Manheim: um Postgres de verdade (não o PGlite,
// que tem uma conexão só) e sessões psql separadas pedindo reserva ao mesmo tempo, em lotes
// diferentes. Prova que a trava do ambiente serializa as reservas e que o gasto projetado (gasto
// real + reservas abertas) nunca passa de US$ 50.
// Usa um banco descartável (mcs_teto_openai) no servidor indicado; nunca o banco do projeto.
// Run: PG_TEST_HOST=/caminho/do/socket PG_TEST_PORT=55432 node tests/sql/concorrencia-teto-openai.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { stubs } = require('./run');

const host = process.env.PG_TEST_HOST;
const port = process.env.PG_TEST_PORT || '5432';
const DB = 'mcs_teto_openai';
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

const ACTOR = '6f200000-0000-4000-8000-000000000001';
const upload = (n) => `6f200000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`;
const holdCall = (n, amount) => `select public.panel_manheim_audit_budget_hold('preview','${upload(n)}','k${n}',${amount})`;
const projected = () => Number(psqlSync(DB, `select public.panel_openai_spent_usd('preview') + coalesce((select sum(amount_usd) from public.manheim_audit_budget_holds where environment='preview' and status='ABERTA' and expires_at > now()),0)`));

async function main() {
  psqlSync('postgres', `drop database if exists ${DB}`);
  psqlSync('postgres', `create database ${DB}`);
  const safeStubs = stubs.replace(/create role (\w+);/g, (_, role) => `do $$ begin create role ${role}; exception when duplicate_object then null; end $$;`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-teto-openai-'));
  const setup = path.join(dir, 'setup.sql');
  const migrations = path.join(__dirname, '..', '..', 'supabase', 'migrations');
  fs.writeFileSync(setup, safeStubs + '\n' + fs.readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort().map((name) => fs.readFileSync(path.join(migrations, name), 'utf8')).join('\n;\n'));
  psqlFile(DB, setup);
  psqlSync(DB, `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','6f200000-0000-4000-8000-000000000002','c@example.test','admin',true,false)`);
  psqlSync(DB, `insert into public.manheim_uploads(id,environment,source_file_count,vehicle_count,created_by) select ('6f200000-0000-4000-8000-' || lpad((100+g)::text,12,'0'))::uuid,'preview',1,10,'${ACTOR}' from generate_series(0,9) g`);
  // Other OpenAI features already spent US$ 49.90: US$ 0.10 left for everybody.
  psqlSync(DB, `insert into public.audit_log(environment,entity_type,action,after_json) values('preview','manheim_openai','READ','{"costUsd":49.9}')`);
  const results = {};

  // A: two batches at the same time; the first keeps the environment lock for 1.5 s.
  const [a1, a2] = await Promise.all([
    session(`begin; ${holdCall(0, 0.06)}; select pg_sleep(1.5); commit;`),
    session(holdCall(1, 0.06), 300)
  ]);
  check(a1.code === 0 && a2.code === 0, `A: ${a1.err} ${a2.err}`);
  check(/"held": true/.test(a1.out) && /"held": false/.test(a2.out) && /OPENAI_LIMIT/.test(a2.out), `A: ${a1.out} | ${a2.out}`);
  check(a2.ms >= 1000, `a segunda sessão esperou a trava (${a2.ms} ms)`);
  check(projected() <= 50, `A projetado ${projected()}`);
  results.doisLotes = { primeiro: 'reservou 0.06', segundo: 'OPENAI_LIMIT', esperaDoSegundoMs: a2.ms, projetado: projected() };
  psqlSync(DB, `update public.manheim_audit_budget_holds set status='ENCERRADA', closed_at=now() where environment='preview'`);

  // B: eight batches at once, US$ 0.03 each, US$ 0.10 left: exactly three fit.
  const many = await Promise.all(Array.from({ length: 8 }, (_, index) => session(`begin; ${holdCall(2 + index, 0.03)}; select pg_sleep(0.2); commit;`)));
  check(many.every((run) => run.code === 0), many.map((run) => run.err).join(' '));
  const held = many.filter((run) => /"held": true/.test(run.out)).length;
  const refused = many.filter((run) => /OPENAI_LIMIT/.test(run.out)).length;
  const total = projected();
  check(held === 3 && refused === 5, `B: ${held} reservaram, ${refused} recusadas`);
  check(total <= 50, `B projetado ${total}`);
  const waiting = Number(psqlSync(DB, `select count(*) from public.manheim_audit_runs where environment='preview' and status='AGUARDANDO_AUTORIZACAO'`));
  check(waiting === 0, `teto da OpenAI não pede autorização (${waiting})`);
  results.oitoLotes = { reservaram: held, recusadas: refused, projetado: total, aguardandoAutorizacao: waiting };

  psqlSync('postgres', `drop database ${DB}`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('OK: concorrência real do teto da OpenAI ' + JSON.stringify(results, null, 1));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
