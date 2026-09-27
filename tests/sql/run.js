'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');

const root = path.join(__dirname, '..', '..');
const migrationDirectory = path.join(root, 'supabase', 'migrations');

const stubs = `
create extension if not exists pgcrypto;
create schema extensions;
create function extensions.digest(value text, algorithm text) returns bytea language sql as $$select public.digest(value,algorithm)$$;
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create schema storage;
create function auth.uid() returns uuid language sql as 'select null::uuid';
create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
create table storage.buckets(id text primary key, name text, public bool, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz, updated_at timestamptz, owner uuid);
create table storage.objects(id uuid default gen_random_uuid() primary key, bucket_id text, name text, owner uuid, metadata jsonb);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql as $$select string_to_array(name,'/')$$;
create table public.calc_runs(id bigserial primary key, created_at timestamptz default now(), zip text, estado text, lance numeric, pagamento text, dados jsonb);
`;

async function main() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(stubs);
    const migrations = fs.readdirSync(migrationDirectory).filter((name) => name.endsWith('.sql')).sort();
    for (const migration of migrations) {
      await db.exec(fs.readFileSync(path.join(migrationDirectory, migration), 'utf8'));
    }
    const scenarios=fs.readdirSync(__dirname).filter((name)=>/^teste-.*\.sql$/.test(name)).sort();
    for(const scenario of scenarios)await db.exec(fs.readFileSync(path.join(__dirname,scenario),'utf8'));
    console.log(`NOTICE: OK: ${scenarios.length} cenários SQL (${migrations.length} migrações)`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
