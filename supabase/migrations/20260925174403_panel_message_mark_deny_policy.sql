-- Keep message marking server-only while making the deny rule explicit to the RLS linter.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'message_fact_marks'
      and policyname = 'message_fact_marks_deny_direct'
  ) then
    create policy message_fact_marks_deny_direct
      on public.message_fact_marks
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end
$$;
