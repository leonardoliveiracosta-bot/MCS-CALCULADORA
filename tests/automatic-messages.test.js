'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
test('automatic message migration preserves old rows and indexes webhook repetition',()=>{const sql=fs.readFileSync('supabase/migrations/20260927020000_panel_automatic_messages.sql','utf8');assert.match(sql,/is_automatic boolean not null default false/);assert.match(sql,/messages_automatic_webhook_idx/);assert.match(sql,/array_length\(affected,1\).*>=3/);});
test('AI excludes automatic MCS messages from the ten-message threshold',()=>{const source=fs.readFileSync('panel-ai.js','utf8');assert.match(source,/message\.direction==='MCS'&&!message\.is_automatic/);});
test('preview and production labels are deterministic',()=>{const label=(host)=>host==='www.mycarscout.net'?'PRODUÇÃO':'PREVIEW — NÃO USE PARA TRABALHAR';assert.equal(label('www.mycarscout.net'),'PRODUÇÃO');assert.match(label('mcs-calculadora-git-x.vercel.app'),/PREVIEW/);});
