'use strict';

// Auditoria "tem algo quebrado?": o que o servidor sabe (erros das funções da Vercel pelo dreno de
// logs, rotas lentas ou com erro, falhas vistas no navegador, chamados abertos) e o relatório técnico
// pronto para colar no Claude/GPT. O teste ativo dos botões roda no navegador (painel/assistente.js),
// com gravação e envio em modo simulação; o resultado dele entra no mesmo relatório.
const { allRows } = require('./panel-server');
const D = require('./panel-assistant-data');

const env = (ctx) => 'eq.' + ctx.environment;
const SLOW_NORMAL_MS = 3000;
const percentile = (list, p) => { if (!list.length) return null; const sorted = list.slice().sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]; };

async function serverFindings(ctx, now = Date.now()) {
  const since = new Date(now - 24 * 3600e3).toISOString();
  const [logs, requests, incidents] = await Promise.all([
    allRows(ctx, 'panel_server_logs', { select: 'id,logged_at,received_at,level,status_code,path,message,request_id', environment: env(ctx), received_at: 'gte.' + since }).catch(() => null),
    allRows(ctx, 'panel_request_log', { select: 'id,created_at,source,path,method,status,ms,code,detail', environment: env(ctx), created_at: 'gte.' + since }).catch(() => []),
    allRows(ctx, 'panel_incidents', { select: 'id,fingerprint,severity,status,count,last_seen_at,diagnosis', environment: env(ctx), status: 'in.(ABERTO,EM_CORRECAO)' }).catch(() => [])
  ]);
  const server = new Map();
  (logs || []).forEach((row) => {
    const key = (row.path || 'sem rota') + ' · ' + (row.status_code || row.level || 'erro');
    const entry = server.get(key) || { rota: row.path || null, status: row.status_code || null, vezes: 0, ultima: null, mensagem: null };
    entry.vezes += 1;
    const at = row.logged_at || row.received_at;
    if (!entry.ultima || at > entry.ultima) { entry.ultima = at; entry.mensagem = row.message || null; }
    server.set(key, entry);
  });
  const own = requests.filter((r) => r.source === 'server' && !(r.detail && r.detail.dryRun));
  const errors = new Map(), slow = new Map();
  own.forEach((r) => {
    if (Number(r.status) >= 500) { const key = r.method + ' ' + r.path; const e = errors.get(key) || { rota: r.path, metodo: r.method, vezes: 0, codigo: r.code || null, ultima: null }; e.vezes += 1; if (!e.ultima || r.created_at > e.ultima) { e.ultima = r.created_at; e.codigo = r.code || e.codigo; } errors.set(key, e); }
    if (Number(r.ms) >= SLOW_NORMAL_MS) { const key = r.method + ' ' + r.path; const e = slow.get(key) || { rota: r.path, metodo: r.method, tempos: [], ultima: null }; e.tempos.push(Number(r.ms)); if (!e.ultima || r.created_at > e.ultima) e.ultima = r.created_at; slow.set(key, e); }
  });
  const client = new Map();
  requests.filter((r) => r.source === 'client').forEach((r) => {
    const d = r.detail || {};
    const key = (d.kind === 'error' ? 'erro de tela: ' + (d.message || '') : (r.method || 'GET') + ' ' + (r.path || '') + ' ' + (r.status || r.code || '')).slice(0, 160);
    const e = client.get(key) || { o_que: key, tela: d.view || null, botao: d.label || null, vezes: 0, ultima: null };
    e.vezes += 1; if (!e.ultima || r.created_at > e.ultima) e.ultima = r.created_at;
    client.set(key, e);
  });
  return {
    janela: 'últimas 24 h',
    logs_da_vercel: logs === null ? 'indisponível' : 'ok',
    erros_do_servidor: [...server.values()].sort((a, b) => b.vezes - a.vezes).slice(0, 20).map((e) => ({ ...e, ultima: D.nyText(e.ultima) })),
    rotas_com_erro: [...errors.values()].sort((a, b) => b.vezes - a.vezes).slice(0, 20).map((e) => ({ ...e, ultima: D.nyText(e.ultima) })),
    rotas_lentas: [...slow.values()].map((e) => ({ rota: e.rota, metodo: e.metodo, vezes: e.tempos.length, mediana_s: Math.round(percentile(e.tempos, 0.5) / 100) / 10, pior_s: Math.round(Math.max(...e.tempos) / 100) / 10, normal_ate_s: SLOW_NORMAL_MS / 1000, ultima: D.nyText(e.ultima) })).sort((a, b) => b.vezes - a.vezes).slice(0, 15),
    falhas_no_navegador: [...client.values()].sort((a, b) => b.vezes - a.vezes).slice(0, 20).map((e) => ({ ...e, ultima: D.nyText(e.ultima) })),
    chamados_abertos: incidents.map((i) => ({ gravidade: i.severity, onde: i.fingerprint, vezes: i.count, ultima: D.nyText(i.last_seen_at), diagnostico: (i.diagnosis && i.diagnosis.texto) || null }))
  };
}

// Texto técnico para colar no Claude/GPT: rota, erro, horário e passos para reproduzir.
function reportText(server, buttons, version) {
  const lines = ['# Relatório de defeitos do painel My Car Scout', `Gerado em ${D.nyText(new Date().toISOString())} (Nova York)${version ? ' · versão do painel ' + version : ''}`, 'Projeto: mycarscout.net/painel (Vercel mcs-calculadora, Supabase wwmakfaqahlbjzqvzgbr)', ''];
  const broken = (buttons && Array.isArray(buttons.results) ? buttons.results : []).filter((b) => b.status === 'quebrado' || b.status === 'lento');
  if (broken.length) {
    lines.push('## Botões com defeito (teste ativo; gravação e envio em simulação, nada foi gravado nem enviado)');
    broken.forEach((b, i) => {
      lines.push(`${i + 1}. [${b.status}] Aba ${b.view} · botão "${b.label}"`);
      if (b.request) lines.push(`   Pedido: ${b.request.method || 'GET'} ${b.request.path} → ${b.request.status || b.request.code || 'sem resposta'} em ${b.request.ms ?? '?'} ms`);
      if (b.error) lines.push(`   Erro na tela: ${b.error}`);
      lines.push(`   Reproduzir: abra o painel, aba ${b.view}, clique em "${b.label}"${b.request ? ' e veja a resposta de ' + b.request.path : ''}`);
    });
    lines.push('');
  }
  const s = server || {};
  if ((s.erros_do_servidor || []).length || (s.rotas_com_erro || []).length) {
    lines.push('## Erros do servidor (24 h)');
    (s.erros_do_servidor || []).forEach((e) => lines.push(`- ${e.rota || 'sem rota'} · HTTP ${e.status || '?'} · ${e.vezes}x · última ${e.ultima || '?'}${e.mensagem ? ' · ' + e.mensagem : ''}`));
    (s.rotas_com_erro || []).forEach((e) => lines.push(`- ${e.metodo} ${e.rota} · 5xx · ${e.vezes}x · código ${e.codigo || '—'} · última ${e.ultima || '?'}`));
    lines.push('');
  }
  if ((s.rotas_lentas || []).length) {
    lines.push('## Lentidão por rota (24 h, acima de 3 s)');
    s.rotas_lentas.forEach((e) => lines.push(`- ${e.metodo} ${e.rota} · ${e.vezes}x · mediana ${e.mediana_s} s · pior ${e.pior_s} s · normal até ${e.normal_ate_s} s`));
    lines.push('');
  }
  if ((s.falhas_no_navegador || []).length) {
    lines.push('## Falhas vistas no navegador (24 h)');
    s.falhas_no_navegador.forEach((e) => lines.push(`- ${e.o_que} · ${e.vezes}x${e.tela ? ' · aba ' + e.tela : ''}${e.botao ? ' · botão "' + e.botao + '"' : ''} · última ${e.ultima || '?'}`));
    lines.push('');
  }
  if ((s.chamados_abertos || []).length) {
    lines.push('## Chamados abertos ("Não funcionou")');
    s.chamados_abertos.forEach((e) => lines.push(`- ${e.gravidade} · ${e.onde} · ${e.vezes}x · última ${e.ultima || '?'}${e.diagnostico ? ' · ' + e.diagnostico : ''}`));
    lines.push('');
  }
  if (lines.length <= 4) lines.push('Nenhum defeito encontrado nas últimas 24 h.');
  return lines.join('\n');
}

module.exports = { serverFindings, reportText, SLOW_NORMAL_MS };
