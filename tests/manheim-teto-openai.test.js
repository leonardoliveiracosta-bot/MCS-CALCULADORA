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

const reserve = (db, amount, feature = 'ENTRADA', env = 'production') => db.query(`select public.panel_openai_budget_hold('${env}','${feature}','s','gpt-6-luna',${amount}) r`).then((res) => res.rows[0].r);
const settle = (db, holdId, status, actual = null, env = 'production') => db.query(`select public.panel_openai_budget_settle('${env}','${holdId}','${status}',${actual === null ? 'null' : actual}) r`).then((res) => res.rows[0].r);
const projected = async (db, env = 'production') => Number((await one(db, `select public.panel_openai_budget_state('${env}')->>'projected' p`)).p);

test('sem limite por lote; o crédito pré-pago de US$ 50 é o teto único, exato por ambiente, contando todo o gasto (migrações 20261014040000/050000)', async () => {
  const { db } = await migratedDatabase();
  await db.exec(seed() + audit(UPLOAD, 1, 'CONFERIDO', 3.5));
  // US$ 3.50 already spent by this batch: no limit per batch, any amount is held for the batch.
  const lot = await hold(db, 100);
  assert.deepEqual([lot.held, lot.limit], [true, null], 'sem limite por lote');
  // The batch's recorded spend counts in the US$ 50 (everything since the start).
  assert.equal(await projected(db), 3.5);
  // Other OpenAI features count against the same US$ 50 (here, the Manheim CSV reading).
  await db.query(`insert into public.audit_log(environment,entity_type,action,after_json) values('production','manheim_openai','READ','{"costUsd":44.5}')`);
  assert.equal(await projected(db), 48);
  const first = await reserve(db, 1.5, 'PESQUISAS');
  assert.equal(first.held, true);
  // 48 + 1.5 = 49.5; 0.500001 more would be 50.000001.
  const over = await reserve(db, 0.500001, 'MANHEIM_AUDIT');
  assert.deepEqual([over.held, over.reason, Number(over.remaining)], [false, 'SALDO_INSUFICIENTE', 0.5]);
  const exact = await reserve(db, 0.5, 'MANHEIM_AUDIT');
  assert.deepEqual([exact.held, Number(exact.remaining)], [true, 0.5], 'exatamente US$ 50 ainda cabe');
  assert.equal((await reserve(db, 0.000001, 'MODELO_TESTE')).held, false);
  assert.equal(await projected(db), 50);
  // Answered: the reservation holds the real cost (0.02) until the feature writes it.
  assert.equal((await settle(db, first.id, 'PAGA', 0.02)).settled, true);
  assert.equal(await projected(db), 48.52);
  // Refused by the provider: nothing counts.
  assert.equal((await settle(db, exact.id, 'LIBERADA')).settled, true);
  assert.equal(await projected(db), 48.02);
  // Written to the feature's table: the reservation stops counting (the table counts it).
  await db.query(`insert into public.audit_log(environment,entity_type,action,after_json) values('production','manheim_openai','READ','{"costUsd":0.02}')`);
  assert.equal(await projected(db), 48.04, 'contado duas vezes até marcar REGISTRADA: nunca a menos');
  assert.equal((await settle(db, first.id, 'REGISTRADA')).settled, true);
  assert.equal(await projected(db), 48.02);
  // Warning from US$ 40.
  const state = (await one(db, "select public.panel_ai_balance_state('production','OPENAI') s")).s;
  assert.deepEqual([Number(state.balance), state.warn, Number(state.warnAt)], [50, true, 40]);
  // Transitions only go forward.
  assert.equal((await settle(db, first.id, 'PAGA', 0.01)).settled, false);
  assert.equal((await settle(db, exact.id, 'REGISTRADA')).settled, false);
  // Another environment never counts here.
  await db.query(`insert into public.audit_log(environment,entity_type,action,after_json) values('preview','manheim_openai','READ','{"costUsd":49}')`);
  assert.equal(await projected(db), 48.02);
  assert.equal((await reserve(db, 1.5, 'ENTRADA', 'preview')).held, false);
  // An abandoned reservation (the function died) keeps counting at its full amount.
  const lost = await reserve(db, 1.9, 'ENTRADA');
  assert.equal(lost.held, true);
  await db.query("update public.openai_budget_holds set created_at = now() - interval '2 days' where id = $1", [lost.id]);
  assert.equal(await projected(db), 49.92);
  // A recharge: the owner informs the new total loaded (US$ 70).
  await db.query("select public.panel_ai_set_balance('production','OPENAI',70,null)");
  assert.equal(Number((await one(db, "select public.panel_ai_balance_state('production','OPENAI')->>'remaining' r")).r), 20.08);
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

test('código: sem limite por lote, 3 tentativas e uma a mais só para tempo esgotado', () => {
  const auditModule = require('../panel-manheim-audit');
  assert.equal(auditModule.LIMIT_USD, undefined, 'sem limite por lote');
  assert.equal(auditModule.MAX_ATTEMPTS, 3);
  assert.equal(auditModule.DEADLINE_ATTEMPTS, 4);
  const code = fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
  assert.ok(!/least\([^)]*,\s*2\)/.test(code), 'sem least(..., 2) no código da migração');
  const pending = (error, attempts) => ({ status: 'PENDENTE', error_code: error, attempts });
  assert.equal(auditModule.retryAllowed(pending('AUDIT_DEADLINE', 3)), true, 'uma tentativa a mais');
  assert.equal(auditModule.retryAllowed(pending('AUDIT_DEADLINE', 4)), false);
  assert.equal(auditModule.retryAllowed(pending('AUDIT_DEADLINE', 4), true), true, 'pelo botão sempre: nunca travado sem saída');
  assert.equal(auditModule.retryAllowed(pending('OPENAI_TIMEOUT', 3)), false);
  assert.equal(auditModule.retryAllowed(pending('OPENAI_BUDGET_LIMIT', 1)), true, 'sem saldo não gasta tentativa');
});
