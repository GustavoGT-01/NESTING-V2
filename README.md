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
| `nest.py` | Algoritmo de encaixe |
| `eps.py` | Geração do EPS e conferência por releitura |
| `store.py` | Gravação dos dados em JSON |
| `iniciar.bat` | Atalho para ligar o programa no Windows |
| `bench.py` | Mede chapas usadas e aproveitamento de um projeto gravado |
| `tests/` | Testes automáticos |

## Dados

Tudo fica na pasta `data/`, que **não vai para o repositório**:

- `store.json`: projetos, modelos e cores, presets, regras, histórico e exportações.
- `project_<id>.json`: peças, arquivos de origem e contadores de sequência de cada projeto.

A gravação é atômica e mantém uma cópia `.bak`. Um arquivo corrompido é preservado ao lado, nunca apagado. Faça cópia da pasta `data/` para ter backup.

## Testes

```bash
python -m unittest discover -s tests -t .
```

São 22 testes do servidor (gravação de dados e EPS).

Há também um teste de fluxo completo em `tests/e2e_jsdom.js`, que precisa do Node.js com o pacote `jsdom`. O caminho do projeto está fixo no topo desse arquivo e precisa ser ajustado antes de rodar.

## Medir o aproveitamento

```bash
python bench.py --seconds 30
```

Lê os projetos gravados em `data/` (sem alterar nada), roda o encaixe e mostra, por material e espessura, as chapas usadas, o comprimento usado na última chapa e o aproveitamento. Serve para comparar o motor antes e depois de uma mudança, com as peças reais.

## Limitações conhecidas

- **O EPS ainda não foi testado em máquina de corte**, nem no CorelDRAW ou Ghostscript.
- **Eixo Y do EPS.** A origem segue a tela (canto superior esquerdo). Confirme o que a sua máquina espera antes de cortar.
- **Curvas viram retas.** Arcos e círculos são convertidos em polilinhas, e o EPS sai só com segmentos de reta.
- **Entidades de DXF não lidas:** SPLINE, ELLIPSE, INSERT (blocos) e POLYLINE antiga. O programa avisa e pede confirmação antes de importar; no CAD, exploda os blocos e converta as curvas em polilinhas.
- **Uma janela por vez.** Com duas abas abertas, a segunda recebe conflito e para de gravar.
- **Modelos e cores são compartilhados** entre todos os projetos.
- Peças idênticas dentro do mesmo arquivo viram quantidade; entre arquivos diferentes nunca se fundem.
