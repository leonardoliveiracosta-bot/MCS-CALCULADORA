-- Avoid thousands of indexed probes over the complete lot; only this private reader changes its plan.
alter function panel_internal.manheim_score_candidates(public.panel_environment,uuid) set enable_nestloop=off;
