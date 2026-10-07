'use strict';
// Assistente do painel (api/panel/assistant.js): conversa com leitura livre do painel, aÃ§Ã£o sÃ³ como
// proposta (nada executa no servidor), "NÃ£o funcionou" com regras fixas + chamado, e a OpenAI fora
// do ar nunca trava nada. OpenAI e banco simulados.
process.env.VERCEL_ENV = 'preview';
process.env.OPENAI_API_KEY = 'sk-chave-secreta-teste';
process.env.SUPABASE_SECRET_KEY = 'sb-secreta-teste';
const test = require('node:test');
const assert = require('node:assert/strict');
const assistant = require('../api/panel/assistant');

const ids = { journey: '11111111-1111-4111-8111-111111111111', contact: '22222222-2222-4222-8222-222222222222', match: '33333333-3333-4333-8333-333333333333', upload: '44444444-4444-4444-8444-444444444444' };
const ctx = { environment: 'preview', panel: { id: '55555555-5555-4555-8555-555555555555' } };
const tables = {
  contacts: [{ id: ids.contact, display_name: 'Maria Souza', is_lead: true }],
  contact_phones: [{ contact_id: ids.contact, phone_e164: '+13055550199', phone_raw: '+13055550199', is_current: true }],
  journeys: [{ id: ids.journey, contact_id: ids.contact, reference_code: 'ABCDE', status: 'ATIVO', stage: 'RESPONDIDO', budget_cents: 3000000, criteria_json: { wishlists: [{ make: 'Jeep', model: 'Wrangler' }] } }],
  calc_runs: [{ id: 1, created_at: '2026-10-01T10:00:00Z', zip: '33101', estado: 'FL', lance: 30000, total: 34000, pagamento: 'cash', idioma: 'pt', dados: { ref: 'ABCDE' } }],
  manheim_matches: [{ id: ids.match¶»§q«^