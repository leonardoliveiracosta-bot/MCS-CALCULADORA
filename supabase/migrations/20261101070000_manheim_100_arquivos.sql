-- Importação do Manheim: até 100 arquivos .csv por envio e até 100 no lote ativo (era 50).
-- Só o número muda: as duas funções são reescritas a partir da definição que está no banco, trocando
-- apenas o limite (falha se o trecho não estiver lá exatamente uma vez). O teto de 250.000 carros por lote,
-- o de 2.000 blocos por envio e os lotes já gravados não mudam.
alter table public.manheim_uploads drop constraint manheim_uploads_source_file_count_check;
alter table public.manheim_uploads add constraint manheim_uploads_source_file_count_check check (source_file_count between 1 and 100);
alter table public.manheim_upload_drafts drop constraint manheim_upload_drafts_source_file_count_check;
alter table public.manheim_upload_drafts add constraint manheim_upload_drafts_source_file_count_check check (source_file_count between 1 and 100);
alter table public.manheim_upload_chunks drop constraint manheim_upload_chunks_file_index_check;
alter table public.manheim_upload_chunks add constraint manheim_upload_chunks_file_index_check check (file_index between 0 and 99);

do $migration$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  v_old := 'jsonb_array_length(p_files) between 1 and 50';
  v_new := 'jsonb_array_length(p_files) between 1 and 100';
  v_def := pg_get_functiondef('public.panel_manheim_manifest_valid(jsonb,integer)'::regprocedure);
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then raise exception 'MANIFEST_LIMIT_NOT_FOUND'; end if;
  execute replace(v_def, v_old, v_new);

  v_old := 'jsonb_array_length(v_upload.files_json)>50 then raise exception ''MANHEIM_BATCH_LIMIT''';
  v_new := 'jsonb_array_length(v_upload.files_json)>100 then raise exception ''MANHEIM_BATCH_LIMIT''';
  v_def := pg_get_functiondef('public.panel_manheim_batch_append_finalize(public.panel_environment,uuid,uuid)'::regprocedure);
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then raise exception 'APPEND_LIMIT_NOT_FOUND'; end if;
  execute replace(v_def, v_old, v_new);
end
$migration$;
