# Encaixe/Chapa (NESTING V2)

Aplicativo web local para **encaixe de peças em chapa** (nesting). Você importa os desenhos, organiza as peças por projeto e por modelo, o programa distribui tudo nas chapas e exporta os arquivos para a máquina de corte.

Roda no seu computador, sem instalar bibliotecas: o servidor usa só a biblioteca padrão do Python e a página é HTML e JavaScript puros.

## O que faz

- **Projetos separados.** Cada projeto tem as suas peças, arquivos de origem e sequência de exportação.
- **Importação em lote com revisão.** Aceita DXF, DWG e SVG. Antes de importar, mostra peças encontradas, material, espessura, modelo e avisos de cada arquivo.
- **Detecção de duplicados** por SHA-256 do arquivo.
- **Modelos e cores.** A cor identifica o modelo da peça. O modelo pode ser criado antes da importação e tem uma quantidade por projeto (ex.: 5 unidades do mesmo modelo).
- **Regras de chapa.** Modelos em chapas separadas, modelos que devem ficar na mesma chapa e pares que não podem se misturar.
- **Encaixe** com rotação livre ou em passos, espelhamento por peça e preenchimento de furos, calculado no servidor em vários núcleos ou no navegador.
- **Tempo de otimização à escolha**, de 10 segundos a 2 horas, com prévia do encaixe em tempo real, barra de progresso e botão para parar antes e ficar com o melhor até ali.
- **Exportação** em EPS, DXF, DWG e SVG, mais relatório em PDF.
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

## Instalador para Windows

`installer\build.ps1` gera `installer\out\EncaixeChapa-Setup-<versão>.exe`, que já leva a janela do programa (Electron), o Python portátil (python.org) e o motor Rust compilado. O programa abre na própria janela, sem console nem navegador: ela liga o servidor escondido e o desliga ao fechar (`desktop/main.js`). Quem instala não precisa de Python nem de Rust, nem de permissão de administrador: o programa vai para `%LOCALAPPDATA%\Programs\EncaixeChapa` e os dados para `%LOCALAPPDATA%\EncaixeChapa\data`, que a desinstalação não apaga.

O ODA File Converter não vai dentro do instalador, porque a licença dele não permite redistribuir. Se ele não estiver instalado, o instalador oferece baixá-lo do canal oficial (winget, ou a página da ODA quando não há winget).

```powershell
powershell -ExecutionPolicy Bypass -File installer\build.ps1 -Version 2.0.0
```

Para gerar é preciso ter o Inno Setup 6 (`winget install JRSoftware.InnoSetup`), o Rust e o Node.js (o `npx` baixa o Electron).

## Como usar

1. Crie um projeto em **Novo projeto**.
2. Em **Modelos e cores**, crie os modelos (opcional, pode ser feito depois).
3. Solte os arquivos em **Importar** e confira a tela de revisão.
4. Ajuste quantidade, material, espessura e giro de cada peça.
5. Defina a medida das chapas e clique em **Encaixar**.
6. Exporte em **EPS**, DXF, DWG ou SVG, ou gere o relatório em PDF.

## Estrutura

| Arquivo | Papel |
|---|---|
| `index.html` | Toda a interface (HTML, CSS e JavaScript) |
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

- `store.json`: projetos, modelos e cores, presets, regras, histórico e exportações.
- `project_<id>.json`: peças, arquivos de origem e contadores de sequência de cada projeto.

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
- **Entidades de DXF não lidas:** SPLINE, ELLIPSE, INSERT (blocos) e POLYLINE antiga. O programa avisa e pede confirmação antes de importar; no CAD, exploda os blocos e converta as curvas em polilinhas.
- **Uma janela por vez.** Com duas abas abertas, a segunda recebe conflito e para de gravar.
- **Modelos e cores são compartilhados** entre todos os projetos.
- Peças idênticas dentro do mesmo arquivo viram quantidade; entre arquivos diferentes nunca se fundem.
