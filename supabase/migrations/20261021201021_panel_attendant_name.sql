-- Display identity only. Authentication, passwords, roles and sessions are unchanged.
alter table public.panel_users add column if not exists display_name text;
comment on column public.panel_users.display_name is 'Nome exibido do titular do login, usado na autoria dos atendimentos';
