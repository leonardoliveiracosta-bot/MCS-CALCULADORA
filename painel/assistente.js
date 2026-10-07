// Assistente do painel: conversa sempre à mão, sem sair da tela e sem travar o painel.
// - MCSAssistantLog: memória no navegador das últimas 20 ações (cliques, chamadas ao servidor,
//   trocas de tela e erros). Só sai daqui junto de uma pergunta ou de um "Não funcionou".
// - A janela: pergunta → resposta; ação → cartão de proposta. Nada executa sem o toque em
//   "Autorizar" (azul: só tela; laranja "Autorizar e gravar": grava). A ação roda pelo mesmo
//   caminho do botão normal (MCSPanelBridge). Desfazer para seleção. Dado desatualizado: não
//   executa e pede nova proposta.
// - "Seus chamados" em Configurações, com "Copiar chamados abertos".
(() => {
  const MAX = 20;
  const buffer = [];
  const push = (entry) => { buffer.push({ ...entry, at: Date.now() }); if (buffer.length > MAX) buffer.shift(); };
  const bridge = () => window.MCSPanelBridge || null;
  const viewNow = () => (bridge() ? bridge().currentView() : null);
  // Rótulo estável dos botões principais (data-action quando há; senão pelo texto conhecido).
  const KNOWN = [[/^Gerar V1/i, 'v1-generate'], [/^Abrir ficha/i, 'ficha-open'], [/^Montar V2/i, 'v2-build'], [/^Enviar/i, 'v1-send'], [/^Selecionar/i, 'select'], [/^Remover/i, 'remove'], [/^Buscar/i, 'search'], [/Importar|CSV/i, 'import-csv'], [/^Atualizar/i, 'refresh']];
  const EXPECT = { 'v1-generate': 'gerar a V1 e abrir o WhatsApp', 'ficha-open': 'abrir a ficha do cliente', 'v2-build': 'abrir a montagem da V2', 'v1-send': ���q�^