'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');

const root=path.resolve(__dirname,'../..');

async function main(){
  const db=new PGlite({extensions:{pgcrypto}});
  try{
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema auth;
      create schema storage;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text,name text);
      create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name,'/') $$;
      alter table storage.objects enable row level security;
      create table public.calc_runs(id uuid primary key default gen_random_uuid(),dados jsonb not null default '{}'::jsonb);
    `);
    const migrationDir=path.join(root,'supabase/migrations');
    const migrations=fs.readdirSync(migrationDir).filter((name)=>name.endsWith('.sql')).sort();
    for(const name of migrations)await db.exec(fs.readFileSync(path.join(migrationDir,name),'utf8'));
    const tests=fs.readdirSync(__dirname).filter((name)=>name.endsWith('.sql')).sort();
    for(const name of tests)await db.exec(fs.readFileSync(path.join(__dirname,name),'utf8'));
    console.log(`SQL tests passed: ${tests.length}; migrations applied: ${migrations.length}`);
  }finally{
    await db.close();
  }
}

main().catch((error)=>{console.error(error);process.exitCode=1;});
