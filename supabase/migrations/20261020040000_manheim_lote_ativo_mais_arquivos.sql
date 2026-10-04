-- O lote ativo pode receber arquivos acrescentados (panel_manheim_batch_append_finalize soma os arquivos de cada
-- acréscimo em source_file_count). O limite de 20 arquivos é por envio (manheim_upload_drafts e o painel continuam
-- com 20); o lote ativo, somando os acréscimos, vai até 500. Antes, 19 + 2 estourava o CHECK e a junção falhava.
alter table public.manheim_uploads
  drop constraint manheim_uploads_source_file_count_check,
  add constraint manheim_uploads_source_file_count_check check (source_file_count between 1 and 500);
