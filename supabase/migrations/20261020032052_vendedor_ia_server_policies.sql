-- Explicit server-only policies, in addition to revoked browser grants
create policy ia_instrucoes_server_only on public.ia_instrucoes for all to service_role using (true) with check (true);
create policy ia_sugestoes_server_only on public.ia_sugestoes for all to service_role using (true) with check (true);
