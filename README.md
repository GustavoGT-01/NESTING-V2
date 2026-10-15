# Encaixe/Chapa (NESTING V2)

Aplicativo web local para **encaixe de peças em chapa** (nesting). Você importa os desenhos, organiza as peças por projeto e por modelo, o programa distribui tudo nas chapas e exporta os arquivos para a máquina de corte.

Roda no seu computador, sem instalar bibliotecas: o servidor usa só a biblioteca padrão do Python e a página é HTML e JavaScript puros.

## O que faz

- **Produtos (base de produtos).** Cada produto tem nome e as peças importadas (DXF, DWG e SVG, com SPLINE e ELLIPSE), com quantidade, giro, espelhamento, material e espessura, e espaço entre peças e margem da chapa próprios (vazio = os do encaixe). As peças aparecem separadas por material e espessura.
- **Planejamento (banco de planejamentos).** Cada planejamento (ex.: PLANEJAMENTO-LOTE1010) junta produtos e quantidades, com uma cor por produto que não se repete no planejamento. Opções: encaixar na ordem da lista e manter as peças de cada produto juntas (mesma chapa ou chapas vizinhas). "Enviar para o encaixe" leva as peças multiplicadas pelas quantidades.
- **Encaixe salvo no planejamento**, com toda a definição usada (espaço, margem, rotação, resolução, tempo, opções e chapas); "Abrir encaixe salvo" restaura tudo.
- **Importação com revisão.** Mostra peças encontradas, material, espessura e avisos de cada arquivo; camadas `REBAIXO_x` e `FURO_x` viram rebaixo e furo cego.
- **Detecção de duplicados** por SHA-256 do arquivo.
- **Encaixe** com rotação livre ou em passos, espelhamento por peça, preenchimento de furos e espaço/margem por peça, calculado no servidor em vários núcleos (Rust, com o Python de reserva) ou no navegador.
- **Tempo de otimização à escolha**, de 10 segundos a 2 horas, com prévia do encaixe em tempo real, barra de progresso e botão para parar antes e ficar com o melhor até ali.
- **Exportação** em EPS, DXF, DWG, SVG e G-code, mais relatório em PDF. Nome padrão `NN-<espessura>MM-<planejamento>`, com NN na ordem de corte do planejamento (ex.: `01-18MM-PLANEJAMENTO-LOTE1010.eps`).
- **Acesso pela rede e túnel** com PIN (Presets › Acesso pela rede).
- **EPS conferido.** O arquivo só é baixado se a releitura bater com o desenho (medida da chapa, número de contornos e desvio de até 0,01 mm).
- **Histórico** de importações, alterações e exportações.
- **Layout responsivo** para desktop, tablet e celular.

## Como rodar

Requisitos: **Python 3.10 ou mais novo**. Para ler e gravar **DWG**, é preciso ter o [ODA File Converter](https://www.opendesign.com/guestfiles/oda_file_converter) instalado; DXF e SVG funcionam sem ele.

No Windows, dê dois cliques em `iniciar.bat`. Ele liga o servidor e abre a página no navegador.

Em qualquer sistema:

```bash
python server.py
```

Depois abra http://127.0.0.1:8080. O programa funciona enquanto o servidor estiver rodando.

### Variáveis de ambiente (opcionais)

| Variável | Para que serve |
|---|---|
| `NEST_DATA` | Pasta onde os dados são gravados (padrão: `data/`) |
| `NEST_WORKERS` | Número de núcleos usados no encaixe (padrão: todos) |
| `ODA_FILE_CONVERTER` | Caminho do ODA File Converter, se não estiver no local padrão |
| `NEST_MOTOR` | Caminho do motor compilado, se não estiver em `motor/target/release/` |

## Motor compilado (opcional, recomendado)

O encaixe funciona só com Python, mas o motor em Rust testa muito mais arranjos no mesmo tempo. Ele não tem dependências externas. Com o [Rust](https://rustup.rs) instalado:

```bash
cd motor
cargo build --release
```

O servidor encontra o executável sozinho em `motor/target/release/` e avisa no início qual motor está em uso. Os dois motores dão exatamente as mesmas posições para a mesma ordem de peças; a diferença é quantas ordens cada um consegue testar no prazo.

## Usinagem CNC (G-code)

Aba **Usinagem CNC**, no modelo do Aspire e do Alphacam: biblioteca de ferramentas (diâmetro, nº T, rotação, avanço, mergulho, passo vertical, sobreposição), estratégia de corte e pós-processador. Gera o G-code das chapas encaixadas (`cam.py`, rota `/api/gcode`).

- **Contorno** externo e interno com compensação do raio da fresa, passadas em profundidade, rampa de entrada e sentido concordante ou discordante. "Passar da chapa" desce na mesa de sacrifício.
- **Micro-juntas** nas peças menores que a área escolhida (quantidade, largura e altura).
- **Furação**: furo redondo com broca do mesmo diâmetro (±0,2 mm) vira furação, com bicada opcional; os outros furos viram contorno interno.
- **Rebaixo e furo cego** pelas camadas do DXF: contorno na camada `REBAIXO_5` (ou `POCKET_5`) é rebaixo de 5 mm; `FURO_10` é furo de 10 mm. Esses contornos não contam como furo no encaixe.
- **Mesa de vácuo**: furos, rebaixos e contornos internos antes; peças pequenas antes das grandes.
- **Troca de ferramenta** manual (um arquivo por ferramenta) ou automática (`T M06`, um arquivo por chapa).
- **Pós-processador** NCStudio editável (início, troca, spindle e fim do arquivo, com variáveis `{T}`, `{RPM}`, `{SAFEZ}`…).

**Simulação 2D e 3D** (botão "Simular 2D / 3D", `sim.js`): lê o G-code gerado e remove material de uma chapa virtual, como a simulação do Alphacam. Escolha o material (MDF cru, MDF BP branco ou preto, compensado, acrílico, ACM ou cores próprias de face e miolo), a vista (2D de cima ou 3D com giro, deslocamento e zoom), a velocidade (tempo real até 500×) e a posição na linha do tempo. Mostra a ferramenta e a linha de G-code em execução e avisa movimento rápido (G0) dentro do material, que na máquina seria colisão. O 3D usa WebGL2 direto, sem bibliotecas.

Origem X0 Y0 no canto inferior esquerdo da chapa; Z0 no topo da chapa ou na mesa. Confira sempre a simulação no controle da máquina antes do primeiro corte.

## Instalador para Windows

`installer\build.ps1` gera `installer\out\EncaixeChapa-Setup-<versão>.exe`, que já leva a janela do programa (Electron), o Python portátil (python.org) e o motor Rust compilado. O programa abre na própria janela, sem console nem navegador: ela liga o servidor escondido e o desliga ao fechar (`desktop/main.js`). Quem instala não precisa de Python nem de Rust, nem de permissão de administrador: o programa vai para `%LOCALAPPDATA%\Programs\EncaixeChapa` e os dados para `%LOCALAPPDATA%\EncaixeChapa\data`, que a desinstalação não apaga.

O ODA File Converter não vai dentro do instalador, porque a licença dele não permite redistribuir. Se ele não estiver instalado, o instalador oferece baixá-lo do canal oficial (winget, ou a página da ODA quando não há winget).

```powershell
powershell -ExecutionPolicy Bypass -File installer\build.ps1 -Version 2.0.0
```

Para gerar é preciso ter o Inno Setup 6 (`winget install JRSoftware.InnoSetup`), o Rust e o Node.js (o `npx` baixa o Electron).

## Como usar

1. Em **Produtos**, crie o produto e importe as peças dele; ajuste quantidade, giro, espelhamento, espaço e margem de cada peça.
2. Em **Planejamento**, crie um planejamento, adicione os produtos, defina quantidades, ordem e cores, e clique em **Enviar para o encaixe**.
3. Em **Encaixar**, confira a medida das chapas e a configuração, clique em **Encaixar** e depois em **Salvar encaixe** (fica no planejamento).
4. Exporte em **EPS**, DXF, DWG ou SVG, gere o relatório em PDF, ou gere o G-code em **Usinagem CNC** (com simulação 2D/3D).

## Estrutura

| Arquivo | Papel |
|---|---|
| `index.html` | Interface (HTML e CSS) |
| `app.js` | Lógica da página |
| `sim.js` | Simulação de usinagem 2D/3D |
| `cam.py` | Caminhos de ferramenta e G-code |
| `desktop/`, `installer/` | Janela Electron e gerador do instalador |
| `server.py` | Servidor local e rotas da API |
| `nest.py` | Algoritmo de encaixe em Python (reserva) |
| `motor/` | O mesmo algoritmo em Rust, compilado: dezenas de vezes mais rápido |
| `engine.py` | Escolhe o motor: o compilado quando existe, senão o `nest.py` |
| `eps.py` | Geração do EPS e conferência por releitura |
| `store.py` | Gravação dos dados em JSON |
| `iniciar.bat` | Atalho para ligar o programa no Windows |
| `bench.py` | Mede chapas usadas e aproveitamento de um projeto gravado |
| `tests/` | Testes automáticos |

## Dados

Tudo fica na pasta `data/`, que **não vai para o repositório**:

- `store.json`: índice de produtos e planejamentos, presets, configurações (inclusive usinagem) e a área de encaixe.
- `product_<id>.json`: peças e arquivos de origem de cada produto.
- `plan_<id>.json`: encaixe salvo do planejamento (peças, chapas, posições e definição usada).
- `project_<id>.json`: área de encaixe (e projetos antigos, guardados).
- `rede.json`: acesso pela rede (ligado/desligado e PIN).
- `history.jsonl`, `exports.jsonl`: histórico e exportações.

A gravação é atômica e mantém uma cópia `.bak`. Um arquivo corrompido é preservado ao lado, nunca apagado, e o `.bak` válido volta a ser o arquivo principal. Se os dois estiverem ruins, a página mostra erro em vez de abrir vazia.

- Cada projeto tem uma revisão (`rev`): se duas janelas editam o mesmo projeto, a que gravar com a versão antiga recebe aviso e precisa recarregar, em vez de apagar o que a outra fez.
- Backup automático: ao ligar, o servidor copia os arquivos de `data/` para `data/backups/AAAA-MM-DD/` (uma vez por dia, guarda os 14 mais recentes). Para restaurar: feche o servidor, copie os arquivos da pasta do dia desejado de volta para `data/` e ligue de novo.

## Segurança

O servidor só atende em `127.0.0.1` e só serve a página (`/` e `/index.html`) e a API. Ele recusa pedidos com `Host` diferente de `127.0.0.1:8080`/`localhost:8080` e gravações vindas de outros sites (cabeçalho `Origin`), o que impede uma página aberta no navegador de ler ou apagar os projetos. Abra sempre por `http://127.0.0.1:8080`. Só um servidor pode usar a porta: um segundo `iniciar.bat` avisa e fecha.

**Acesso pela rede** (Presets › Acesso pela rede, desligado por padrão). Ligado, o servidor passa a atender a rede local na próxima vez que abrir. Outros computadores e celulares do mesmo Wi-Fi entram por `http://<IP do computador>:8080` e precisam do PIN de 6 dígitos mostrado no computador principal. O PIN abre uma sessão de 30 dias por cookie `HttpOnly`/`SameSite=Strict`; 5 PINs errados bloqueiam aquele IP por 5 minutos; gerar um PIN novo derruba todas as sessões. O PIN e a chave liga/desliga só aparecem no próprio computador (`/api/rede` recusa pedidos da rede). A configuração fica em `data/rede.json`. É HTTP sem criptografia: use só em rede de confiança. Na primeira vez, o Windows pergunta se libera o programa no firewall.

## Testes

```bash
py -3 -m unittest discover -s tests
```

São 44 testes: gravação de dados, EPS, segurança do servidor, limites do encaixe e paridade entre o motor Python e o compilado (este pula se `motor.exe` não existir).

Há também um teste de fluxo completo em `tests/e2e_jsdom.js`, que precisa do Node.js com o pacote `jsdom` instalado em qualquer pasta (`npm i jsdom` e `NODE_PATH` apontando para o `node_modules` dela):

```bash
node tests/e2e_jsdom.js
```

## Medir o aproveitamento

```bash
python bench.py --seconds 30
```

Use `--motor python` ou `--motor rust` para comparar os dois motores.

Lê os projetos gravados em `data/` (sem alterar nada), roda o encaixe e mostra, por material e espessura, as chapas usadas, o comprimento usado na última chapa e o aproveitamento. Serve para comparar o motor antes e depois de uma mudança, com as peças reais.

## Limitações conhecidas

- **O EPS ainda não foi testado em máquina de corte**, nem no CorelDRAW ou Ghostscript.
- **Eixo Y do EPS.** A origem segue a tela (canto superior esquerdo). Confirme o que a sua máquina espera antes de cortar.
- **Curvas viram retas.** Arcos e círculos são convertidos em polilinhas, e o EPS sai só com segmentos de reta.
- **Entidades de DXF não lidas:** INSERT (blocos) e POLYLINE antiga. O programa avisa e pede confirmação antes de importar; no CAD, exploda os blocos. SPLINE e ELLIPSE são lidas e convertidas em polilinha.
- **Uma janela por vez.** Com duas abas abertas, a segunda recebe conflito e para de gravar.
- **Modelos e cores são compartilhados** entre todos os projetos.
- Peças idênticas dentro do mesmo arquivo viram quantidade; entre arquivos diferentes nunca se fundem.
