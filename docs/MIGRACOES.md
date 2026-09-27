# Migrações do banco

1. Toda mudança de banco deve ser uma migração nova e aditiva. Nunca edite uma migração antiga.
2. Depois de aplicar uma migração pelo MCP ou por outra ferramenta, confira no mesmo trabalho se `supabase_migrations.schema_migrations.version` corresponde exatamente à versão no nome do arquivo. Se a ferramenta registrar a hora da aplicação, corrija somente `version` para a versão do arquivo e preserve `statements` e os demais campos.
3. Nunca execute `supabase db push`, `supabase db reset` ou `supabase migration repair` em massa contra produção.
4. O backup `supabase_migrations.schema_migrations_backup_20260927` deve permanecer guardado.
