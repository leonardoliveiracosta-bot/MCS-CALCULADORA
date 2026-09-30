'use strict';

// Conferência Manheim com o teto compartilhado da OpenAI (migração 20261008010000): o lote passa de
// US$ 2 quando ainda cabe em US$ 50, nenhuma reserva leva o gasto projetado acima de US$ 50, o lote
// ABERTO antigo passa a usar e mostrar US$ 50 sem perder gasto, reservas ou histórico, e a
// conferência PENDENTE por AUDIT_DEADLINE com 3 tentativas não é repetida sozinha.
// PGlite com as migrações; OpenAI simulada. A concorrência entre sessões reais do Postgres está em
// tests/sql/concorrencia-teto-openai.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { migratedDatabase } = require('./sql/run');

const NEW = '20261008010000';
const MIGRATION = path.join(__dirname, '..', 'supabase', 'migrations', `${NEW}_panel_manheim_audit_teto_openai.sql`);
const id = (n) => `6d300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), UPLOAD = id(2), OTHER = id(3);
const hash = (n) => String(n).padStart(64, '0').replace(/[^0-9a-f]/g, 'a');
const seed = (env = 'production') => `
  insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','${env}','6d300000-0000-4000-8000-00000000a001','t@example.test','admin',true,false);
  insert into public.manheim_uploads(id,environment,source_file_count,vehicle_count,created_by) values('${UPLOAD}','${env}',1,10,'${ACTOR}'),('${OTHER}','${env}',1,10,'${ACTOR}');`;
const audit = (upload, n, status, cost, extra = '') => `insert into public.manheim_match_audits(environment,upload_id,demand_key,content_hash,rule_version,status,cost_usd,attempts,error_code)
  values('production','${upload}','journey:${id(100 + n)}:CARRO','${hash(n)}','conferencia-v1','${status}',${cost},${extra || "1,null"});`;
const hold = (db, amount, upload = UPLOAD, env = 'production') => db.query(`select public.panel_manheim_audit_budget_hold('${env}','${upload}','k',${amount}) r`).then((res) => res.rows[0].r);
const one = async (db, sql) => (await db.query(sql)).rows[0];

test('lote ABERTO antigo: limite passa de US$ 2 para US$ 50, gasto, reservas e histórico ficam', async () => {
  const { db } = await migratedDatabase({ before: NEW });
  // The production state found on 2026-09-30: batch ABERTO, limit 2, spent 0.015108 in 6 audits;
  // one PENDENTE by AUDIT_DEADLINE with 3 attempts and 0.009014; 9 closed holds.
  await db.exec(seed() + `
    insert into public.manheim_audit_runs(environment,upload_id,status,estimate_usd,limit_usd,spent_usd) values('production','${UPLOAD}','ABERTO',0.003878,2,0.015108);
    insert into public.manheim_audit_runs(environment,upload_id,status,estimate_usd,limit_usd,spent_usd) values('production','${OTHER}','AGUARDANDO_AUTORIZACAO',2.4,2,0);
    ${audit(UPLOAD, 1, 'PENDENTE', 0.009014, "3,'AUDIT_DEADLINE'")}
    ${audit(UPLOAD, 2, 'REVISAR', 0.003129, "2,null")}
    ${audit(UPLOAD, 3, 'CONFERIDO', 0.001000)} ${audit(UPLOAD, 4, 'CONFERIDO', 0.001000)}
    ${audit(UPLOAD, 5, 'CONFERIDO', 0.000500)} ${audit(UPLOAD, 6, 'CONFERIDO', 0.000465)}
    insert into public.manheim_audit_budget_holds(environment,upload_id,demand_key,amount_usd,status,expires_at,closed_at)
      select 'production','${UPLOAD}','k'||g,0.005098,'ENCERRADA',now(),now() from generate_series(1,9) g;`);
  const audits = (await db.query('select * from public.manheim_match_audits order by content_hash')).rows;
  const holds = (await db.query('select * from public.manheim_audit_budget_holds order by demand_key')).rows;
  // Before the migration the database stops the batch at US$ 2.
  const old = await hold(db, 2);
  assert.equal(old.held, false);
  assert.equal(Number(old.limit), 2);
  await db.query("update public.manheim_audit_runs set status='ABERTO' where upload_id=$1", [UPLOAD]);

  await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
  const run = await one(db, `select status,estimate_usd,limit_usd,spent_usd from public.manheim_audit_runs where upload_id='${UPLOAD}'`);
  assert.deepEqual([run.status, Number(run.estimate_usd), Number(run.limit_usd), Number(run.spent_usd)], ['ABERTO', 0.003878, 50, 0.015108]);
  assert.deepEqual((await db.query('select * from public.manheim_match_audits order by content_hash')).rows, audits, 'conferências intactas');
  assert.deepEqual((await db.query('select * from public.manheim_audit_budget_holds order by demand_key')).rows, holds, 'reservas intactas');
  const log = (await db.query(`select action,before_json,after_json from public.audit_log where entity_type='manheim_audit_run' and entity_id=(select id from public.manheim_audit_runs where upload_id='${UPLOAD}')`)).rows;
  const waited = await one(db, `select r.status,r.limit_usd,r.estimate_usd,l.before_json->>'status' b from public.manheim_audit_runs r join public.audit_log l on l.entity_id=r.id where r.upload_id='${OTHER}'`);
  assert.deepEqual([waited.status, Number(waited.limit_usd), Number(waited.estimate_usd), waited.b], ['ABERTO', 50, 2.4, 'AGUARDANDO_AUTORIZACAO'], 'lote que só esperava pelo limite antigo volta a ABERTO');
  assert.deepEqual(log.map((row) => [row.action, Number(row.before_json.limit_usd), row.before_json.status, row.after_json.limit_usd, row.after_json.status]), [['OPENAI_LIMIT_SYNC', 2, 'ABERTO', 50, 'ABERTO']]);
  assert.equal(Number((await one(db, "select column_default d from information_schema.columns where table_name='manheim_audit_runs' and column_name='limit_usd'")).d), 50);
  // The pending audit stays as it was: 3 attempts, AUDIT_DEADLINE, 0.009014.
  const pending = await one(db, "select status,error_code,attempts,cost_usd from public.manheim_match_audits where status='PENDENTE'");
  assert.deepEqual([pending.error_code, pending.attempts, Number(pending.cost_usd)], ['AUDIT_DEADLINE', 3, 0.009014]);
  // The same batch now holds above US$ 2.
  const now = await hold(db, 2);
  assert.equal(now.held, true);
  assert.equal(Number(now.limit), 50);
  await db.close();
});

test('lote passa de US$ 2 enquanto cabe no teto global; nunca acima de US$ 50 projetado', async () => {
  const { db } = await migratedDatabase();
  await db.exec(seed() + audit(UPLOAD, 1, 'CONFERIDO', 3.5));
  // US$ 3.50 already spent by this batch: the old function would have refused anything.
  const first = await hold(db, 1);
  assert.equal(first.held, true, 'passa de US$ 2');
  assert.equal(Number(first.limit), 50);
  // Other OpenAI features count against the same US$ 50 (here, the Manheim CSV reading).
  await db.query(`insert into public.audit_log(environment,entity_type,action,after_json) values('production','manheim_openai','READ','{"costUsd":44.5}')`);
  // Projected: 3.5 + 44.5 + 1 (open hold) = 49; 1.000001 more would be 50.000001.
  const over = await hold(db, 1.000001, OTHER);
  assert.deepEqual([over.held, over.reason, Number(over.limit), Number(over.remaining)], [false, 'OPENAI_LIMIT', 50, 1]);
  const run = await one(db, `select status from public.manheim_audit_runs where upload_id='${OTHER}'`);
  assert.equal(run.status, 'ABERTO', 'teto da OpenAI não vira "aguardando autorização"');
  const exact = await hold(db, 1, OTHER);
  assert.equal(exact.held, true, 'exatamente US$ 50 projetado ainda cabe');
  assert.equal(Number(exact.remaining), 0);
  const tiny = await hold(db, 0.000001, OTHER);
  assert.deepEqual([tiny.held, tiny.reason], [false, 'OPENAI_LIMIT']);
  const projected = Number((await one(db, "select public.panel_openai_spent_usd('production') + (select sum(amount_usd) from public.manheim_audit_budget_holds where status='ABERTA') p")).p);
  assert.equal(projected, 50);
  // An expired hold stops counting; a closed one too (its real cost is on the audit row).
  await db.query("update public.manheim_audit_budget_holds set status='ENCERRADA', closed_at=now() where upload_id=$1", [OTHER]);
  assert.equal((await hold(db, 0.5, OTHER)).held, true);
  // Spending of the other environment never counts here.
  await db.query(`insert into public.audit_log(environment,entity_type,action,after_json) values('preview','manheim_openai','READ','{"costUsd":49}')`);
  assert.equal(Number(await one(db, "select public.panel_openai_spent_usd('production') s").then((row) => row.s)), 48);
  await db.close();
});

test('fontes do gasto são as mesmas do panel-openai-budget.js', async () => {
  const { db } = await migratedDatabase();
  await db.exec(seed() + audit(UPLOAD, 1, 'CONFERIDO', 0.25) + `
    insert into public.audit_log(environment,entity_type,action,after_json) values
      ('production','manheim_openai','READ','{"costUsd":0.5}'),('production','manheim_openai','READ','{"costUsd":"x"}'),('production','outra','READ','{"costUsd":9}');`);
  assert.equal(Number((await one(db, "select public.panel_openai_spent_usd('production') s")).s), 0.75);
  const source = fs.readFileSync(path.join(__dirname, '..', 'panel-openai-budget.js'), 'utf8');
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  for (const table of ['vehicle_request_runs', 'vehicle_request_batches', 'conversation_triage', 'manheim_match_audits', 'audit_log']) {
    assert.ok(source.includes(`'${table}'`) && sql.includes(`public.${table}`), table);
  }
  assert.ok(/conversations: 'eq\.0'/.test(source) && /conversations = 0/.test(sql));
  assert.ok(/entity_type: 'eq\.manheim_openai'/.test(source) && /entity_type = 'manheim_openai'/.test(sql));
  await db.close();
});

test('código: limite de US$ 50 no lote e sem repetição automática além de 3 tentativas', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'panel-manheim-audit.js'), 'utf8');
  const auditModule = require('../panel-manheim-audit');
  assert.equal(auditModule.LIMIT_USD, 50);
  assert.equal(auditModule.MAX_ATTEMPTS, 3);
  assert.ok(!/least\([^)]*,\s*2\)/.test(fs.readFileSync(MIGRATION, 'utf8')), 'sem least(..., 2)');
  assert.ok(/row\.attempts < MAX_ATTEMPTS/.test(code));
});
