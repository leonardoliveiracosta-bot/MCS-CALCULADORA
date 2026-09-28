-- Audit C4: iPhone exports are always "_chat.txt", so "_chat" was stored as a chat alias and
-- the next iPhone ZIP of another customer could be attached to that chat automatically.
-- The panel no longer stores or matches generic titles; this removes only the known generic
-- aliases that already exist (production had 1: "_chat"). A real name that starts with "_" is
-- kept. Only chat_aliases rows are touched; chats, messages and contacts stay as they are.
--
-- Rows that would be removed (run before applying):
--   select id, chat_id, alias_text from public.chat_aliases
--   where lower(btrim(regexp_replace(alias_text, '\.(txt|zip)$', '', 'i'))) in
--     ('_chat', 'whatsapp chat', 'chat', 'conversa', 'conversa do whatsapp', 'mensagens', 'messages', 'export');

delete from public.chat_aliases
where lower(btrim(regexp_replace(alias_text, '\.(txt|zip)$', '', 'i'))) in (
  '_chat', 'whatsapp chat', 'chat', 'conversa', 'conversa do whatsapp', 'mensagens', 'messages', 'export'
);
