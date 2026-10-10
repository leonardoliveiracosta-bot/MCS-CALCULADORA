# IG-001 Nível 2 Revisor independente (instagram)

Data: 2026-10-10
Pedido: IG-001 (setores/instagram/entregas/IG-001-pedido.md)
Papel: Nível 2 Revisor independente, etapa cega
Ordem das etapas: pedido registrado, executor e revisor trabalhando em paralelo com o mesmo pedido, esta avaliação cega registrada antes de qualquer contato com o rascunho do executor
Anti-ancoragem: não abri IG-001-executor.md nem nada em scratchpad/insta/exec/; extraí meus próprios quadros do vídeo original

## Avaliação cega

### Como avaliei

- Vídeo original medido com ffprobe: 7,67 s, 1440x2560, 30 quadros por segundo, HEVC 10 bits em HDR (HLG com Dolby Vision perfil 8.4), áudio AAC estéreo 44,1 kHz
- Quadros extraídos a cada 0,1 s e 0,25 s, com grade de coordenadas, para medir onde e quando cada texto aparece
- Brilho por quadro (signalstats) para achar o fim preto e silencedetect para o áudio
- Leitura de msc-calculadora.html (somente leitura) para oferta, público e idioma
- Pesquisa atual sobre Reels (lista de fontes no fim); conteúdo da web tratado como dado
- Marcação: [Evidência] é algo medido no vídeo, no código ou citado de fonte; [Opinião] é julgamento meu, que precisa de teste para virar fato

### Oferta, público e idioma (do msc-calculadora.html)

- [Evidência] Página em inglês por padrão (lang="en"), com opções EN, ES e PT
- [Evidência] A oferta: a My Car Scout dá lances por você em leilões fechados a revendedores ("81 wholesale auctions. 8 million cars a year. Dealer-only access")
- [Evidência] O custo total que a calculadora mostra soma lance, taxa do leilão ("Auction fee", cobrada pela casa de leilão e estimada por lote), taxa de serviço da My Car Scout ("only if we actually win the vehicle for you"), imposto sobre venda, título, registro e placa, com Flórida como referência
- [Evidência] "Clean title only": a empresa só dá lance em título limpo com hodômetro documentado
- [Evidência] O próximo passo da calculadora é enviar a estimativa por WhatsApp ou SMS
- Conclusão: o público é quem compra carro nos EUA (forte presença da Flórida) e quer preço de atacado; o vídeo deve falar inglês e levar para a calculadora

### O que o vídeo original mostra, segundo a segundo

| Tempo | O que aparece | Avaliação |
|---|---|---|
| 0,0 a 0,5 s | Tesla vindo na direção da câmera dentro do leilão; embaixo, "2021 TESLA MODEL 3" e caixas pretas ainda vazias, com o preço sendo digitado | [Evidência] o primeiro quadro tem caixas vazias e nenhum motivo escrito para parar; o preço só fica completo perto de 0,5 s. [Opinião] o movimento do carro vindo para a câmera é o melhor elemento do vídeo e deve ficar; o primeiro quadro precisa já trazer a frase do gancho |
| 0,5 a 2,8 s | "138k miles \| SOLD at AUCTION:" e "$ 5,200" no bloco de baixo; "EXCLUSIVE ACCESS / EXCLUSIVE PRICE" em cima, de 0,6 s a 2,8 s | [Evidência] o texto de cima é branco fino com serifa sobre o teto branco, com pouco contraste; o bloco do preço ocupa de 66% a 86% da altura (y 1275 a 1650 em 1080x1920), e o próprio preço fica entre y 1480 e 1590, faixa que os guias de área segura colocam sob a legenda e o nome do perfil. [Evidência] "EXCLUSIVE PRICE" sugere que o preço é para quem assiste, mas $5.200 é só o lance vencedor, sem taxas, imposto e registro. [Opinião] "EXCLUSIVE ACCESS" é vago e não diz o que a pessoa ganha |
| 2,25 a 3,05 s | "CLEAN TITLE" amarelo pequeno sobre o capô | [Evidência] menos de 1 s na tela, com letras de cerca de 55 px de altura sobre o capô em movimento; no para-brisa aparece "Repo" escrito à mão. [Opinião] título limpo é um argumento forte para essa marca e merece ficar fixo na ficha, desde que confirmado no relatório de condição |
| 2,8 a 4,6 s | "COMMENT" / "WANT THIS ACCESS" / "SCOUT" com aspas e mão apontando para baixo | [Evidência] a ordem de leitura fica ambígua ("Comment want this access"?), falta ponto de interrogação, a aspa de abertura aparece antes da de fechamento durante a animação e a mão aponta para o bloco do preço, não para o botão de comentários, que fica à direita. [Evidência, fonte secundária] o Instagram disse que conteúdo que pede comentário com uma palavra específica pode deixar de ser recomendado a quem não segue, e depois esclareceu que ferramentas como o ManyChat continuam permitidas. [Evidência] não há no repositório nada que mostre uma resposta automática ligada à palavra SCOUT; sem ela, o pedido de ação não leva a lugar nenhum |
| 4,6 a 7,3 s | Câmera passa pela lateral e chega à traseira; muito tremido e céu estourado | [Evidência] nenhum texto novo e nenhum pedido de ação nesses 2,7 s finais. [Opinião] é onde mais gente sai: não há informação nova nem motivo para ficar até o fim |
| 7,30 a 7,67 s | Tela preta com o bloco de texto ainda por cima; áudio em silêncio de 7,27 s a 7,68 s | [Evidência] 11 quadros pretos no fim. É erro de edição: o vídeo termina em preto e a repetição automática do Reel recomeça depois de um corte seco |

### Erros de texto e de acabamento (original)

- [Evidência] "MYCARSCOUT.NET" tem cerca de 22 px de altura em 1080x1920; ilegível no celular
- [Evidência] "$ 5,200" com espaço depois do cifrão; "SOLD at AUCTION:" mistura maiúsculas e termina com dois pontos
- [Evidência] Arquivo em HDR HLG de 10 bits; ao converter sem tratamento, as cores ficam lavadas (testei: sem conversão de cor o amarelo e o carro ficam pálidos). [Opinião] mandar ao Instagram uma versão já em SDR evita surpresa de cor

### Privacidade (original)

- [Evidência] Rostos de terceiros identificáveis: homem de camisa cinza andando (0 a 1,7 s), motorista do leilão dentro do Tesla (0 a 5 s, boné e rosto parcialmente visíveis), homem de camisa vermelha ao lado do carro (3,1 a 5 s, rosto nítido entre 3,5 e 4 s), pessoas sentadas ao fundo, pessoa dentro do carro vermelho e o operador da cabine da pista
- [Evidência] Placa: o suporte traseiro está vazio (quadro de 7,0 s); nenhuma placa legível
- [Evidência] VIN: não está legível em nenhum quadro que conferi
- [Evidência] Nome do leilão: não ficou legível nos quadros que conferi; aparecem telas com o sistema do leilão (borradas pelo movimento) e o número da pista. [Opinião] tratar telas e placas de parede como risco e escondê-las quando der
- [Evidência] A etiqueta "6.97" e o "Repo" no para-brisa não identificam pessoa

### Afirmações que podem enganar

- [Evidência] O vídeo mostra "$5,200" e "EXCLUSIVE PRICE" sem nenhuma menção a taxas, imposto ou registro; a calculadora da própria empresa mostra que o cliente paga tudo isso por cima do lance. Isso fere o limite do pedido ("preço vendido no leilão sem taxas não pode parecer preço final")
- [Evidência, fonte secundária] A regra federal da FTC contra taxas escondidas, em vigor desde maio de 2025, ficou restrita a ingressos e hospedagem; veículos ficaram fora. Isso não muda a regra deste pedido, que é mais rígida
- [Opinião] "2021", "138k miles" e "$5,200" não podem ser conferidos só pelo vídeo; precisam do registro da venda e do relatório de condição antes de postar

### O que a pesquisa atual diz e como usei

- [Evidência, fonte secundária] Em janeiro de 2025, Adam Mosseri citou três sinais principais para Reels: tempo assistido, curtidas por alcance e envios por alcance; envios pesam mais para alcançar quem não segue. Uso: vídeo curto e informação nova até o fim, e algo que dê vontade de mandar para alguém (o preço que surpreende e a explicação honesta)
- [Evidência, fonte secundária] Em 2025 o Instagram trocou "View Rate" por "Skip Rate", que mede quem sai nos primeiros 3 segundos, e adicionou o gráfico de retenção. Uso: medir o gancho por esse número
- [Evidência, fonte secundária] Área segura: os guias para anúncios de Reels citam 14% livre em cima, 35% embaixo e 6% nas laterais; para posts orgânicos os números variam entre guias e não achei página oficial com pixels. Uso: texto principal entre y 260 e 1530 e nada importante à direita de x 930
- [Evidência, fonte secundária] Desde 2021 o Instagram reduz a recomendação de Reels com marca d'água de outros apps ou baixa qualidade, e em 2026 estendeu a regra contra conteúdo repostado sem transformação. Uso: postar arquivo nativo, sem marca de outro app
- [Evidência, fonte secundária] Pedir comentário com palavra específica é o exemplo que o Instagram dá de conteúdo que pode não ser recomendado. Uso: o pedido de ação do meu vídeo é "Link in bio", que não depende de automação nem pede engajamento
- Nada disso garante visualizações. O que aumenta a chance: gancho escrito no primeiro quadro, informação nova a cada 2 s, fim sem tela preta, texto legível e honestidade que gera confiança e envio

### Minha versão corrigida

Arquivo: /tmp/claude-0/-home-user-MCS-CALCULADORA/879d293b-da99-5ce0-bd31-b1d31a9bad96/scratchpad/insta/rev/IG-001-revisor.mp4 (fora do repositório)

- [Evidência] 1080x1920, 30 quadros por segundo, H.264 High, yuv420p, cores BT.709 (SDR); áudio AAC 48 kHz estéreo 192 kb/s; 7,30 s; 8,1 MB; com faststart para começar a tocar rápido
- Só imagens deste vídeo: convertido de HDR para SDR, cortado antes do preto final (7,30 s), áudio original com fade de 0,25 s no fim
- Como o original já tem texto queimado na imagem, cobri as duas áreas com cartões opacos e retirei o "CLEAN TITLE" do capô por interpolação com borda suavizada
- Rostos de terceiros desfocados com caixas acompanhando o movimento (homem de cinza, motorista, homem de vermelho, pessoas sentadas, pessoa no carro vermelho, operador da cabine); conferi quadro a quadro em grades de 0,2 a 0,4 s

Roteiro da minha versão

| Tempo | Cartão de cima (mensagem) | Cartão de baixo (ficha, fixo o tempo todo) |
|---|---|---|
| 0,0 a 2,5 s | SOLD AT A DEALER-ONLY AUCTION / This 2021 Model 3 sold for $5,200 | 2021 TESLA MODEL 3 / 138k miles · Clean title / Winning bid: $5,200 / Before fees, tax and registration |
| 2,5 a 4,7 s | THE CATCH / That's only the winning bid / Fees, tax and registration come on top | igual |
| 4,7 a 7,3 s | FREE CALCULATOR / See your real total for any car / Link in bio | igual |

- O gancho está escrito desde o primeiro quadro, junto com o carro vindo na direção da câmera
- O aviso "Before fees, tax and registration" fica na tela durante todo o tempo em que o preço aparece, em 36 px, fora da faixa coberta pela legenda
- A virada honesta ("That's only the winning bid") abre uma pergunta e responde no fim com a calculadora; é a oferta da empresa dita em uma frase
- Títulos em Inter Display ExtraBold de 84 px, ficha em Inter de 36 a 60 px, amarelo só no preço e no pedido de ação
- Quadros conferidos com Read: 0,0 s, 2,6 s (capô), 2,7 s, 4,8 s, 5,5 s, 6,0 s e 7,25 s, além de grades de privacidade de 0 a 5,6 s
- [Opinião] Limites desta versão: os cartões ocupam cerca de 42% da tela porque precisam esconder o texto queimado; com vídeo bruto, sem texto, os cartões podem ser menores. As cenas de 5,4 a 7,3 s continuam tremidas e com céu estourado porque são as únicas imagens disponíveis

### Legenda e primeiros comentários sugeridos (prontos para copiar)

Legenda

```
2021 Tesla Model 3, 138k miles, clean title. Winning bid at a dealer-only auction: $5,200.

That number is the bid, not the total. Auction fees, our service fee (only if we win the car for you), sales tax, title and registration come on top.

Want the real all-in number for the car you want? Free calculator, link in bio.
```

Primeiro comentário (fixar)

```
How it works: you tell us the car and your max bid, we bid for you at dealer-only auctions, and you get the auction's condition report before anything is authorized. Full cost breakdown in the calculator, link in bio.
```

Segundo comentário

```
Why is the bid so low? Wholesale prices reflect miles, condition and history. That is why you see the condition report before we bid.
```

### O modelo para todos os carros

Fica fixo
- Tela 1080x1920, 30 quadros por segundo, H.264 com AAC, SDR BT.709, de 6 a 9 s
- Cartão de cima com a mensagem e cartão de baixo com a ficha, nas mesmas posições, fontes e cores
- Três fases: gancho com preço (0 s), a pegadinha honesta (cerca de 2,5 s) e calculadora com "Link in bio" (cerca de 4,7 s até o fim)
- A linha "Before fees, tax and registration" sempre que houver preço na tela
- Abertura com o carro em movimento na direção da câmera, sem tela preta no fim
- Sem rosto de terceiro, placa, VIN completo ou nome do leilão

Muda por carro
- Ano, marca, modelo, milhas, lance vencedor e situação do título
- O vídeo bruto, o ponto de corte final e, quando houver, as caixas de desfoque

Script reutilizável (fora do repositório, em scratchpad/insta/rev/)
- make_reel.py lê car.json e gera o vídeo em um comando: `python3 -I make_reel.py car.json`
- Caminho comum: trocar os seis campos do carro em car.json, apontar o vídeo bruto e rodar; nenhum passo extra
- `--debug-sheet` gera uma folha de quadros para conferir antes de exportar
- Remoção de texto queimado e caixas de desfoque são opcionais; só entram quando a conferência mostra rosto ou texto. Neste vídeo foram necessárias; não sei com que frequência isso acontece nos próximos (1 vídeo medido), então medir antes de tornar regra

O que precisa ser verdade em cada vídeo, antes de postar
- O lance vencedor bate com o registro da venda daquele carro, e o carro realmente foi vendido
- Milhas vêm do hodômetro do relatório de condição
- "Clean title" só aparece se o relatório confirmar; sem isso, a linha sai
- O carro filmado é o mesmo carro dos dados
- O link da bio abre a calculadora no celular e funciona
- Se algum dia o pedido de ação for palavra no comentário ou DM, a resposta automática precisa estar ativa e testada antes de postar
- Nenhum rosto de terceiro, placa, VIN completo ou nome do leilão identificável no vídeo final
- Filmar sem texto queimado, com o carro no terço do meio da tela (y 600 a 1250), porque em cima e embaixo ficam os cartões

Como medir, sem prometer números
- Skip Rate (quem sai nos 3 primeiros segundos) e gráfico de retenção de cada Reel
- Envios e salvamentos por alcance
- Cliques no link da bio e mensagens de WhatsApp que chegam da calculadora
- Mudar uma coisa por vez entre vídeos (por exemplo, só a frase do gancho) e comparar com pelo menos alguns vídeos no mesmo modelo

## Fontes

- Sinais de ranqueamento de Reels citados por Adam Mosseri em 2025 (fontes secundárias): [dataslayer.ai](https://www.dataslayer.ai/blog/instagram-algorithm-2025-complete-guide-for-marketers), [contentgrip.com](https://www.contentgrip.com/instagram-influencer-marketing/), [ecommercefastlane.com](https://ecommercefastlane.com/how-does-the-algorithm-for-reels-work-in-2025/)
- Skip Rate e gráfico de retenção: [socialsamosa.com](https://www.socialsamosa.com/news-2/instagram-retention-chart-skip-rate-new-performance-metrics-reels-9730992), [metricool.com](https://metricool.com/instagram-reel-analytics/), [marketing4ecommerce.net](https://marketing4ecommerce.net/en/retention-and-skip-rate-reels/)
- Área segura de Reels: [hopperhq.com](https://www.hopperhq.com/blog/instagram-reel-size/), [houseofmarketers.com](https://houseofmarketers.com/guide-to-safe-zones-tiktok-facebook-instagram-stories-reels/), [inro.social](https://www.inro.social/tools/instagram-reels-safe-zone-checker), [billo.app](https://billo.app/blog/meta-ads-safe-zones)
- Marca d'água e conteúdo reciclado: [xda-developers.com](https://www.xda-developers.com/psa-do-not-upload-tiktok-instagram-reels-without-removing-watermark/), [tubefilter.com 2022](https://www.tubefilter.com/2022/04/21/instagram-adam-mosseri-algorithm-change-original-content/), [petapixel.com 2026](https://petapixel.com/2026/04/30/new-instagram-policies-target-reposted-content/)
- Pedido de comentário com palavra e recomendação: [socialmediatoday.com, esclarecimento](https://www.socialmediatoday.com/news/instagram-clarifies-advice-on-single-word-ctas-and-longer-reels/718151/), [socialmediatoday.com, aviso](https://www.socialmediatoday.com/news/instagram-says-using-certain-ctas-can-impact-post-reach/717732/), [help.instagram.com](https://help.instagram.com/313829416281232)
- Regra da FTC sobre taxas: [olshanlaw.com](https://www.olshanlaw.com/Advertising-Law-Blog/ftc-anti-drip-pricing-regulation-now-in-effect), [americanbar.org](https://www.americanbar.org/groups/litigation/resources/newsletters/consumer/drip-pricing-junk-fee-class-actions-ftc-rule-unfair-deceptive-fees/)
- Observação: as páginas acima vieram de busca; não consegui abrir help.instagram.com nem socialmediatoday.com diretamente nesta sessão, então os trechos citados delas são os resumos da busca e devem ser conferidos na fonte
- Dados internos: msc-calculadora.html (somente leitura); medições com ffprobe e ffmpeg no vídeo original
