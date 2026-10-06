-- V1/V2: "Tirar da lista" em todo cartão. Usa a mesma marca do "Pedido atendido"
-- (vitrine_requests.treated_at), numa linha de tipo próprio (DISMISS) por vitrine, para que o
-- Desfazer (treated_at volta a null) nunca vire um pedido aberto do cliente. Só amplia os tipos
-- aceitos: nenhum dado é apagado ou alterado.
alter table public.vitrine_requests drop constraint if exists vitrine_requests_request_kind_check;
alter table public.vitrine_requests add constraint vitrine_requests_request_kind_check
  check (request_kind in ('VIEW','BID','DISMISS'));
