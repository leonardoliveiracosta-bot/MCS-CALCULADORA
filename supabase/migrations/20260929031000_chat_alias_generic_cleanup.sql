-- Audit C4: iPhone exports are always "_chat.txt", so "_chat" was stored as a chat alias and
-- the next iPhone ZIP of another customer could be attached to that chat automatically.
-- The panel no longer stores or matches generic titles; this removes the generic aliases that
-- already exist (production had 1: "_chat"). Only chat_aliases rows are touched; chats,
-- messages and contacts stay as they are.

delete from public.chat_aliases
where btrim(alias_text) ~ '^_'
   or lower(btrim(regexp_replace(alias_text, '\.(txt|zip)$', '', 'i'))) in (
     '', 'chat', 'whatsapp', 'whatsapp chat', 'conversa', 'conversa do whatsapp',
     'mensagens', 'messages', 'export', 'exportar', 'txt'
   );
