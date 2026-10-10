# IG-001 Rascunho do Executor

Identificador: IG-001
Papel: Nível 1 Executor, setor instagram
Data: 2026-10-10
Etapa: rascunho do executor; revisão cega (Nível 2) e decisão (Nível 3) ainda não feitas
Arquivos fora do repositório: vídeos, quadros e script ficam no diretório de rascunho do executor (caminhos na seção 5)

## 1. Resumo para a Leo

- O vídeo original tem bons primeiros segundos (o carro vindo na direção da câmera), mas o preço só fica legível perto de 1 segundo, o texto principal fica na parte de baixo que a legenda e o nome da conta cobrem no Instagram, e o pedido de ação aparece no meio do vídeo e some antes do fim
- O preço de $5,200 aparece como "SOLD at AUCTION" sem avisar que faltam taxas; isso vai contra o limite do pedido
- Há rostos de terceiros identificáveis, o número do lote e telas do leilão com dados do lote; o nome do leilão não ficou legível em nenhum quadro que conferi
- Fiz um vídeo novo de 6,07 segundos só com as imagens deste vídeo: preço legível no primeiro quadro junto com o aviso de taxas, textos fora das áreas cobertas, rostos e etiquetas de lote borrados, fim sem tela preta
- Criei um script que gera o mesmo formato para qualquer carro trocando só ano, marca, modelo, milhas, preço e situação do título
- Duas coisas precisam ser confirmadas antes de postar: se $5,200 foi mesmo o valor final (a tela do leilão no próprio vídeo mostra "NEXT BID $5,200" e "HIGH BID $5,000" naquele momento) e se o título é mesmo limpo

## 2. Como analisei

- Extraí quadros do original a 4 e a 10 por segundo, recortes em resolução cheia (1440x2560) e quadros com grade para medir posições
- Medi o arquivo: 7,67 s, 1440x2560, 30 quadros por segundo, HEVC 10 bits em HDR (formato HLG com Dolby Vision, padrão do iPhone), áudio AAC estéreo
- Áudio: medi volume, silêncio, espectro, regularidade de batida e modulação típica de fala
- Não consegui transcrever o áudio: não há ferramenta de transcrição neste ambiente
- As páginas da web não abriram diretamente aqui (falha de acesso do ambiente); as fontes da seção 9 vêm dos resumos da busca, e marquei quando a fonte é secundária
- Legenda das colunas: E = evidência medida ou vista nos quadros; O = opinião ou boa prática de mercado

## 3. Análise do vídeo original, segundo a segundo

| Tempo | O que aparece | Efeito na pessoa | Tipo |
|---|---|---|---|
| 0,0 a 0,5 s | Carro ao longe vindo pela pista; caixa "2021 TESLA MODEL 3" já aparece, mas milhas e preço ainda estão sendo digitados ("138k", "$") | O motivo para parar (o preço baixo) não está no primeiro quadro, que também vira a capa | E (quadros 0,0 e 0,5) e O |
| 0,5 s | Erros de animação: "138kmiles" sem espaço e "SOLD atAUCTION" sem espaço | Parece amador por um instante | E |
| 0,6 a 2,7 s | "EXCLUSIVE ACCESS / EXCLUSIVE PRICE" digitado letra a letra, com pedaços como "EXCL", "ACCES", "PRIC"; letra fina branca sobre parede branca; o texto passa sobre uma TV | Baixo contraste e palavras incompletas cansam a leitura; "preço exclusivo" sugere que o cliente pagaria esse valor | E (contraste e cortes) e O |
| 1,0 a 7,27 s | Caixa fixa com modelo, milhas, preço e "MYCARSCOUT.NET" entre 67% e 85% da altura da tela | Essa faixa fica sob a legenda, o nome da conta e o nome do áudio no Instagram; o preço fica em cerca de 77% a 82% da altura | E (posição medida) e E de terceiros (áreas cobertas, seção 9) |
| 1,0 a 7,27 s | "MYCARSCOUT.NET" com cerca de 15 px de altura numa tela de 1080 de largura | Ilegível no celular | E |
| 2,4 a 2,9 s | "CLEAN TITLE" pequeno, amarelo, em itálico, sobre o capô, por meio segundo | Informação forte com pouca leitura | E |
| 2,8 a 4,5 s | Pedido de ação "COMMENT / WANT THIS ACCESS / "SCOUT"" digitado; completo só de 3,6 a 4,5 s | Cerca de 0,9 s com a frase inteira; ordem de leitura confusa (comentar o quê?) e aparece no meio, não no fim | E (tempo) e O (clareza) |
| 3,4 a 4,5 s | Homem de camisa vermelha e óculos em close, plateia sentada, telas do leilão com número do lote 6-97, linhas de dados do lote e lances | Rosto identificável de terceiro; dados do lote | E |
| 3,9 s | A caixa de preço reanima: "$5," em amarelo e "200" em branco | Falha visível de animação | E |
| 4,6 a 6,3 s | Câmera passa rápido pelo teto, borrão de movimento, céu estourado | Nenhuma informação nova; ponto provável de saída | E (borrão) e O (saída) |
| 6,3 a 7,27 s | Traseira do carro, muito clara, etiqueta do lote no vidro traseiro, suporte de placa vazio | Bom ângulo do carro, mas estourado | E |
| 7,27 a 7,67 s | Tela preta e silêncio | Fim morto de 0,4 s; atrapalha a repetição contínua do vídeo | E (quadros pretos e silencedetect de 7,27 a 7,68 s) |
| Áudio, 0 a 7,27 s | Volume médio de -18,4 dB e pico de -2,5 dB; sem batida regular (autocorrelação 0,15), espectro largo, pouca modulação de fala (0,11) | Parece som ambiente do galpão, sem música; pode haver vozes ao fundo; não deu para transcrever | E (medidas) e O (interpretação) |
| Todo o vídeo | Arquivo em HDR de iPhone | Textos e cores podem mudar de aparência depois da conversão do Instagram; mais seguro entregar em SDR comum | E (formato) e O (risco) |

### O que prende (evidência e opinião)

- O carro vindo direto para a câmera, com faróis acesos e o envelopamento que muda de cor, é a melhor imagem do vídeo (O)
- O preço de $5,200 para um Tesla 2021 é o gancho mais forte, porque contraria o que a pessoa espera (O)

### O que perde a pessoa

- Preço ilegível no primeiro quadro (E)
- Texto em letra fina, digitado letra a letra, com baixo contraste (E)
- Segunda metade sem informação nova, borrada e estourada (E), com tela preta no fim (E)

### Privacidade

- Rostos: homem andando (0 a 1,8 s), plateia sentada, pessoa de colete amarelo, pessoas atrás do carro e o homem de camisa vermelha em close (3,4 a 4,5 s) (E)
- Motorista do Tesla: usa chapéu e cobertura no rosto, não identificável (E)
- Placas: o Tesla não tem placa (suporte traseiro vazio, sem placa dianteira); placas de outros carros aparecem pequenas e ilegíveis (E)
- VIN: não encontrei VIN legível; as telas do leilão mostram linhas de dados do lote que não consegui ler (E)
- Número do lote 6-97 na etiqueta do para-brisa, no vidro traseiro e nas telas (E)
- Nome do leilão: não legível em nenhum quadro conferido (E); logotipo das telas e o prédio podem ser reconhecidos por quem conhece o lugar (O)

### Afirmações que podem enganar

- "SOLD at AUCTION: $5,200" sem taxas, ao lado de "EXCLUSIVE PRICE", faz parecer que esse é o preço para o cliente; o pedido proíbe isso (E: texto do vídeo; regra do pedido)
- Contexto: em março de 2026 a FTC (órgão de defesa do consumidor dos EUA) mandou cartas a 97 grupos de concessionárias dizendo que o preço anunciado deve incluir todas as taxas obrigatórias, exceto impostos (E de terceiros, seção 9); a My Car Scout não é concessionária anunciando estoque, mas o princípio é o mesmo (O)
- Conflito no próprio vídeo: por volta de 4,1 s, a tela do leilão mostra "NEXT BID $5,200" e "HIGH BID $5,000" (leitura difícil, imagem borrada) (E); naquele momento $5,200 era o próximo lance pedido, não um valor vendido confirmado; precisa do registro de venda do leilão antes de postar (pendência)
- "CLEAN TITLE": não dá para confirmar pelo vídeo; o para-brisa tem "Repo" escrito (carro retomado), o que não impede título limpo, mas reforça a necessidade de conferir o documento (E e pendência)
- 138k milhas: o hodômetro não aparece no vídeo (E e pendência)
- Se o leilão é exclusivo para revendedores: não dá para confirmar pelo vídeo; o vídeo novo não afirma isso sobre este leilão (E)

### O pedido de ação funciona?

- "Comment SCOUT" só funciona se alguém, ou uma ferramenta de resposta automática, mandar a mensagem prometida para cada pessoa que comentar (O)
- Não encontrei no repositório nenhuma automação de comentário para mensagem direta (E, limitado ao repositório)
- Ferramentas que usam a API oficial da Meta podem responder em privado a quem comentou; o prazo citado varia entre fontes (7 dias ou 24 horas) e precisa ser conferido na documentação da Meta (E de terceiros, divergente)
- Pedir comentário com palavra-chave em troca de algo é comum; a regra de "isca de engajamento" que conheço é de 2017 e do Facebook, e não confirmei como se aplica hoje ao Instagram (E de terceiros, antiga)

## 4. Decisões do vídeo corrigido, segundo a segundo

Arquivo final: /tmp/claude-0/-home-user-MCS-CALCULADORA/879d293b-da99-5ce0-bd31-b1d31a9bad96/scratchpad/insta/exec/IG-001-executor.mp4

| Tempo no vídeo novo | Imagem usada do original | Texto na tela | Motivo |
|---|---|---|---|
| 0,00 a 2,35 s | 0,00 a 2,35 s (carro vindo para a câmera) | Painel no alto: "2021 TESLA MODEL 3", "$5,200" grande em dourado, "Winning bid at auction", "Auction fees, tax and title not included"; abaixo, etiquetas "138K MILES" e "CLEAN TITLE" | Gancho completo e legível desde o primeiro quadro, que também serve de capa; o aviso de taxas está no mesmo painel do preço, então o preço nunca aparece sozinho |
| 2,35 a 3,04 s | 6,55 a 7,24 s (traseira), cor corrigida | "That's just the bid" e "Auction fees, tax and title come on top" | Corte direto para outro ângulo renova a atenção (O) e reforça a verdade sobre o preço, criando a pergunta "quanto eu pagaria" |
| 3,04 a 3,60 s | Quadro parado em 7,23 s | Mesmo texto | Tempo de leitura para a frase completa |
| 3,60 a 6,07 s | Quadro parado em 7,23 s | "Want your real total?", botão dourado "Comment SCOUT", "We'll DM you our cost calculator", "mycarscout.net" | Pedido de ação no fim, por 2,5 s, com o que a pessoa ganha ao comentar; liga direto à calculadora do site |

Correções técnicas aplicadas

- Formato: 1080x1920, 30 quadros por segundo, H.264 perfil High, AAC 48 kHz estéreo 192 kbps, início rápido para reprodução na web, 2,6 MB, 6,07 s
- Cor: convertido de HDR do iPhone para cor comum (SDR BT.709) com ajuste de tons; a traseira estourada recebeu mais contraste e menos brilho
- Textos antigos gravados na imagem: o recorte para antes da caixa de preço antiga (que começa a 1700 px de altura); "EXCLUSIVE ACCESS" fica sob o painel novo, que tem fundo desfocado e escuro; "CLEAN TITLE" e o pedido de ação antigos ficaram de fora pela escolha dos trechos
- Faixa de baixo (345 px): versão desfocada e escurecida da própria imagem, sem informação, porque essa área fica sob a legenda do Instagram
- Privacidade: borrão com bordas suaves acompanhando o homem andando e a plateia à direita, as pessoas atrás do carro, as pessoas à esquerda, a etiqueta do lote no para-brisa e no vidro traseiro; o close do homem de camisa vermelha e as telas do leilão ficaram fora porque esse trecho não foi usado
- Fim: sem tela preta; o vídeo termina no pedido de ação e recomeça no carro chegando
- Áudio: som ambiente original, sem música, normalizado para -16,7 LUFS (volume integrado medido no arquivo final), com entrada e saída suaves

Conferência feita com quadros do resultado (lidos um a um)

- Quadros 0, 18, 36, 54, 69, 70, 71 a 78, 82, 90, 100, 107, 120 e 180 conferidos
- Textos conferidos letra a letra: "2021 TESLA MODEL 3", "$5,200", "Winning bid at auction", "Auction fees, tax and title not included", "138K MILES", "CLEAN TITLE", "That's just the bid", "Auction fees, tax and title come on top", "Want your real total?", "Comment SCOUT", "We'll DM you our cost calculator", "mycarscout.net"; sem erro de digitação
- Posições: painéis entre 290 e 862 px de altura, etiquetas entre 1110 e 1202 px; nada acima de 290 px (área do topo, cerca de 14%), nada abaixo de 1400 px, etiquetas terminam em 745 px de largura, longe da coluna de botões da direita
- Menor texto: 36 px de altura de fonte numa tela de 1080 px
- Nenhum resto dos textos antigos visível nos quadros conferidos
- Limites que continuam: nos quadros 71 a 78 a borda da etiqueta traseira aparece sob o borrão, mas o número não é legível; pessoas muito distantes (rosto com menos de 20 px) não têm borrão próprio fora das áreas acima; a área exata coberta pelos botões varia por aparelho, então vale olhar a pré-visualização no aplicativo antes de postar

## 5. Arquivos gerados (fora do repositório)

- Vídeo final: /tmp/claude-0/-home-user-MCS-CALCULADORA/879d293b-da99-5ce0-bd31-b1d31a9bad96/scratchpad/insta/exec/IG-001-executor.mp4
- Script do modelo: /tmp/claude-0/-home-user-MCS-CALCULADORA/879d293b-da99-5ce0-bd31-b1d31a9bad96/scratchpad/insta/exec/gerar_video.py
- Ajustes só deste vídeo (cortes, recorte, borrões, cor): /tmp/claude-0/-home-user-MCS-CALCULADORA/879d293b-da99-5ce0-bd31-b1d31a9bad96/scratchpad/insta/exec/tesla_edit.json
- Teste do caminho comum: /tmp/claude-0/-home-user-MCS-CALCULADORA/879d293b-da99-5ce0-bd31-b1d31a9bad96/scratchpad/insta/exec/teste/teste_padrao.mp4
- Quadros de conferência: pastas chk, orig, tm e teste dentro de .../insta/exec/

## 6. Modelo para todos os carros

### O que fica fixo

- Duração de cerca de 6 a 7 s em três partes: gancho com preço (cerca de 2,4 s), aviso "That's just the bid" (cerca de 1,3 s), pedido de ação no último quadro (cerca de 2,5 s)
- Textos fixos em inglês, cores da marca (fundo escuro e dourado), fonte Inter, posições dentro da área segura
- Aviso de taxas sempre junto do preço
- Palavra do comentário (SCOUT) e o site
- Saída 1080x1920, H.264 e AAC, sem tela preta no fim

### O que muda por carro

- Ano, marca, modelo, milhas, preço (lance vencedor, antes das taxas) e situação do título
- Nomes longos diminuem a fonte sozinhos (testado com "2021 MERCEDES-BENZ GLA 250 4MATIC")

### Como usar (caminho comum: vídeo bruto, sem texto gravado)

```
python3 gerar_video.py --input video.mp4 --year 2021 --make Tesla --model "Model 3" \
  --miles 138k --price 5200 --title clean --out tesla.mp4
```

- Milhas aceitam "138k" (mostra 138K MILES) ou o número exato (mostra 97,526 MILES); o script não arredonda
- Preço aceita "5200" ou "$5,200"
- Sem arquivo de edição, o script recorta o centro em formato vertical, usa os primeiros 4 s e segura o último quadro para o pedido de ação

### Exceção tratada à parte

- Vídeo com texto antigo gravado, rostos próximos ou etiquetas de lote usa o arquivo opcional --edit (como tesla_edit.json), só quando isso acontece; o caminho comum não ganha passo nem campo
- Título que não é limpo: o script escreve o que for informado; o site diz que só se compra título limpo, então isso deve ser raro; não criei regra para esse caso

### Teste do caminho comum

- Rodei o script sem arquivo de edição, com dados de teste de outro carro (Mercedes-Benz GLA 250 4MATIC, 97,526 milhas, $10,050, título limpo): saiu em cerca de 50 s um vídeo de 6,6 s, 1080x1920, H.264 e AAC, com os três painéis legíveis e nenhum passo a mais
- Como o vídeo de teste foi este mesmo original, os textos antigos aparecem nele; isso é esperado e mostra por que o modelo deve partir de vídeo bruto
- Rodei também o vídeo deste Tesla pelo mesmo script (com o arquivo de edição): é o vídeo final da seção 4

### Como gravar os próximos vídeos (opinião)

- Gravar sem texto, vertical, de 5 a 10 s, já com o carro grande no primeiro segundo
- Deixar o carro nos dois terços de baixo da imagem, porque o painel de preço ocupa o alto
- Evitar rostos, telas do leilão e etiquetas de lote em primeiro plano
- Evitar contra a luz forte (a traseira deste vídeo estourou)

### Como medir, sem prometer visualizações

- Nos dados do Reels: tempo médio assistido, quanto da audiência passa dos primeiros 3 s, envios por alcance, curtidas por alcance (os três sinais que o chefe do Instagram disse pesar mais em 2025; seção 9)
- Na ação: comentários com SCOUT, mensagens enviadas, visitas ao site e estimativas enviadas pela calculadora
- Comparar carro a carro com o mesmo modelo e trocar só uma coisa por vez (por exemplo, a frase do gancho)
- Vídeos curtos, gancho no primeiro quadro, texto legível e pedido de ação claro aumentam a chance de retenção e de envios; nenhuma dessas medidas garante 100 mil ou 1 milhão de visualizações

## 7. Legenda e primeiros comentários (prontos para copiar)

Idioma: inglês, porque o site abre em inglês (lang="en"), fala de leilões nos EUA e mostra horário da Flórida; o site também oferece espanhol e português, e a equipe responde nos três

### Legenda

```
2021 Tesla Model 3. 138K miles. Clean title.
Winning bid at auction: $5,200.

That's the bid, not the total. Auction fees, tax, title and registration come on top, and they change by state.

Want to see what a car like this would cost you all in? Comment SCOUT and we'll DM you our cost calculator. Or tap the link in our bio.

We search dealer auctions and bid for you, only with your authorization. If we don't buy your car, you don't pay us.

Every car and every auction is different. Past prices are not a quote.

#carauction #tesla #teslamodel3 #usedcars #carbuying
```

### Primeiro comentário (fixar)

```
How it works: comment SCOUT and we send you the calculator by DM. Enter a max bid and your ZIP code and it shows the bid, auction fees, tax and title. Questions? Ask here, a real person answers.
```

### Segundo comentário

```
Prices in our videos are winning bids, before fees. Your total depends on the car, the auction and your state.
```

### Resposta pública para quem comentar SCOUT

```
Sent, check your DMs
```

### Mensagem direta para quem comentar SCOUT

```
Here's the My Car Scout cost calculator: mycarscout.net
Enter the bid and your ZIP code to see the total with auction fees, tax and title. Want us to look for a car like this one? Just reply here.
```

## 8. Pendências antes de postar

1. Confirmar no registro de venda do leilão que $5,200 foi o lance vencedor; se for outro valor, gerar de novo com o script trocando só o preço
2. Confirmar título limpo e 138k milhas no documento ou no relatório de condição
3. Garantir que alguém, ou uma automação, responde todo comentário SCOUT; se não houver, trocar o pedido de ação para "link in bio" antes de postar
4. Conferir a pré-visualização no aplicativo do Instagram em um celular
5. Áudio: o vídeo usa o som ambiente original; música da biblioteca do Instagram é opcional e depende do que está liberado para a conta

## 9. Fontes

Consultadas em 2026-10-10 por busca na web; as páginas não abriram diretamente neste ambiente, então os pontos abaixo vêm dos resumos da busca. Fonte secundária está marcada.

- Sinais de ranqueamento citados por Adam Mosseri em janeiro de 2025 (tempo assistido, curtidas por alcance, envios por alcance), via Social Media Today (secundária): https://www.socialmediatoday.com/news/instagram-shares-algorithm-insights-2025/738034/
- Guia do Instagram sobre criação de Reels (3 a 15 s para conteúdo rápido, texto na tela para abrir com gancho, legendas), via Social Media Today (secundária): https://www.socialmediatoday.com/news/instagram-shares-reels-creation-tips-in-new-guide/831551/
- Áreas cobertas pelos botões e textos do Reels (topo cerca de 14% ou 250 a 270 px, base de 250 a 350 px em blogs e 35% citado para anúncios, laterais cerca de 6%), fontes de terceiros e divergentes entre si: https://www.hopperhq.com/blog/instagram-reel-size/ ; https://www.trymypost.com/blog/instagram-reels-safe-zones-text-placement-2026 ; https://www.sirency.com/blog/instagram-reels-safe-zone ; https://www.inro.social/tools/instagram-reels-safe-zone-checker ; https://billo.app/blog/meta-ads-safe-zones
- Diretrizes de conteúdo original do Instagram (texto e edição próprios contam; marca d'água não basta): https://creators.instagram.com/original-content-guidelines/ ; https://creators.instagram.com/blog/rewarding-original-creators-on-instagram
- Cartas da FTC de março de 2026 a 97 grupos de concessionárias sobre preço anunciado com taxas obrigatórias (secundárias): https://blog.galalaw.com/post/102mpp4/ftc-warns-auto-dealers-advertised-vehicle-prices-must-include-mandatory-fees ; https://www.consumeraffairs.com/news/the-ftc-calls-out-car-dealers-for-alleged-misleading-advertising-031726.html ; https://complyauto.com/ftc-issues-massive-warning-to-dealers-about-price-advertising/ ; https://pirg.org/edfund/articles/car-dealerships-nationwide-warned-to-stop-junk-fees-other-deceptive-tactics/
- Resposta automática por mensagem a quem comenta palavra-chave (prazo divergente entre fontes): https://inro.social/blog/instagram-comment-to-dm-automation ; https://www.spurnow.com/blogs/instagram-auto-reply-to-comments-guide ; https://www.wati.io/geo/blog/automatically-send-instagram-dms-keyword-comments-1
- Política de isca de engajamento do Facebook, 2017: https://about.fb.com/news/2017/12/news-feed-fyi-fighting-engagement-bait-on-facebook/
- Oferta, público e idioma: msc-calculadora.html, index.html e o/options.js deste repositório (somente leitura)
