# Auditoria do projeto — 14/10/2026

Branch `audit/2026-10-14`, a partir de `39622b6`. Acompanhada no painel `/audit` (mod `audit-board` do Claude Code).

## Estado geral

O app é sólido no núcleo (encaixe Rust e Python idênticos na ordem fixa, EPS validado por releitura), mas tinha um ponto crítico de perda de dados e uma superfície de ataque séria para um app local: qualquer página aberta no navegador conseguia ler e apagar os projetos. Os dois foram corrigidos e cobertos por testes. Ficam pendências de desempenho no motor Python e de organização do código.

## Arquitetura

- `server.py`: HTTP local (127.0.0.1:8080), serve só a página e a API `/api/*`.
- `store.py`: persistência em JSON (`data/store.json`, `data/project_<id>.json`), gravação atômica, `.bak`, revisão por documento, backup diário em `data/backups/`.
- `engine.py`: escolhe o motor (Rust `motor.exe`, reserva `nest.py`), jobs com progresso, parada e prazo.
- `nest.py` / `motor/`: o encaixe (mesmas posições para a mesma ordem; teste de paridade em `tests/test_parity.py`).
- `eps.py`: EPS por chapa com validação.
- `index.html`: interface inteira (importação DXF/SVG/DWG, modelos, encaixe, exportação, relatório PDF), estado global `S`.

## Equipe e método

Dez papéis (A0 orquestrador, A1 arquitetura, A2 backend, A3 frontend, A4 segurança, A5 dados, A6 infra, A7 testes, A8 código morto, A9 documentação), executados como subagentes do Claude Code em ondas. Diagnóstico só leitura e em paralelo; implementação com um dono por arquivo; revisão por um agente diferente de quem implementou; uma tarefa só conclui com validação registrada (regra imposta pelo quadro).

## Problemas e resultado

| Gravidade | Encontrados | Corrigidos | Validados por teste/navegador |
|---|---|---|---|
| Crítica | 1 | 1 | 1 |
| Alta | 12 | 12 | 12 |
| Média | 19 | 14 | — |
| Baixa / info | 8 | 5 | — |

A lista completa, com a evidência e a validação de cada um, está no painel `/audit`, aba Problemas.

Principais correções:

- **Perda silenciosa de dados (crítica):** store corrompido era recuperado do `.bak` sem regravar; na leitura seguinte voltava vazio e o `.bak` era sobrescrito. Agora o `.bak` é promovido e, se os dois estiverem ruins, a página mostra erro.
- **Acesso por outros sites:** arquivos fora da página eram servidos (`data/`, código, `.git`) por variações de caminho; não havia checagem de `Host` nem de `Origin`. Agora: só `/` e `/index.html`, `Host` e `Origin` locais obrigatórios, cabeçalhos de segurança e CSP.
- **XSS armazenado** em campos numéricos do projeto (executava no navegador): números normalizados ao carregar e escapados.
- **Duas abas no mesmo projeto** apagavam uma à outra: revisão por projeto com aviso (409).
- **Encaixe em projeto errado** ao trocar de projeto durante o cálculo; botão Encaixar ativo durante o job; motor do navegador ignorava o giro por peça; erros do servidor caíam em silêncio no motor do navegador.
- **Limites:** tamanho do corpo, tempo de encaixe (até 7200 s), no máximo 2 encaixes simultâneos, motor travado é encerrado.
- **Operação:** segunda instância na mesma porta agora avisa e fecha; `iniciar.bat` usa `py -3`, exige Python 3.10+ e recompila o motor; backup diário automático.
- **Limpeza:** 2 funções JS e 1 variável sem uso removidas; `graphify-out/` no `.gitignore`. Nenhum arquivo apagado.

## Testes

- Unitários: 22 → **44** (`py -3 -m unittest discover -s tests`), todos aprovados. Os testes novos de segurança e de limites falham no código antigo (9 de 10).
- Fluxo completo: `tests/e2e_jsdom.js` não rodava no Windows; agora **20/20**.
- Navegador real (Edge headless, cópias do servidor com dados temporários): XSS, troca de projeto durante o encaixe, conflito entre abas, aviso de saída, exportação SVG.
- Não executados: compilação do motor Rust em CI (não há `cargo` nesta máquina para `cargo test`/`clippy`), conversão DWG com o ODA, `iniciar.bat` de ponta a ponta.

## Pendências (roadmap, por prioridade)

1. Motor Python estoura o prazo (300 peças: 4 s pedidos → 34-46 s) e não atende "Parar"; piso de 1 s por grupo.
2. Histórico e exportações dentro do `store.json`: mover para arquivo de linhas (JSONL) com consulta paginada.
3. Log em arquivo com rotação (`data/logs/`).
4. CI mínima (unittest + build do motor + paridade).
5. Separar o JS do `index.html` em arquivos testáveis (permite CSP sem `unsafe-inline`).
6. Baixa gravidade: keepalive limitado a ~64 KB ao fechar a aba; edição feita durante a troca de projeto; snapshot só na partida; `rev` opcional por compatibilidade.

Dependem de decisão: aviso de produção em dobro no encaixe conjunto; apagar o `LEIA-ME.md` (defasado).

## Escalabilidade

Medido com dados sintéticos: o store fica lento por volume de exportações (50 mil → gravação de 2,5 s); projetos de 1000 peças × 500 vértices (9 MB) gravam em ~1 s a cada autosave; com o motor Rust, 300 peças cabem no prazo pedido; sem ele, o limite prático é ~100 peças. O que quebra primeiro: histórico no store, depois tamanho de projeto, depois o motor Python.

## Para aplicar

Feche o servidor aberto, faça o merge do branch, rode os testes e abra `iniciar.bat` de novo. Para desfazer: `git checkout main`.
