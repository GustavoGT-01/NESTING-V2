# Encaixe/Chapa — evolução (entrega 1)

## Como rodar
    python server.py        # abre em http://127.0.0.1:8080 ; dados em data/
    python -m unittest discover -s tests -t .      # 22 testes de backend
    cd tests && npm i jsdom && node e2e_jsdom.js   # fluxo completo (21 verificações)
(O e2e sobe o servidor sozinho; ajuste o caminho do projeto no topo do arquivo se mudar a pasta.)

## Arquivos
- **Novos:** `store.py` (persistência JSON), `eps.py` (EPS + releitura/validação), `tests/`.
- **Alterados:** `server.py` (rotas /api/store, /api/project/<id>, /api/history, /api/eps; bloqueia servir `data/` e `*.py`), `index.html` (redesign + projetos + importação em lote + EPS). `nest.py` intacto.
- **Dependências novas:** nenhuma em produção (stdlib e JS puro). jsdom só para o teste e2e.

## Dados (pasta data/)
`store.json` (projetos, modelos e cores, presets, histórico, exportações, nomenclatura) e `project_<id>.json` (peças, arquivos de origem com SHA-256, contadores de sequência). Escrita atômica + `.bak`; arquivo corrompido é preservado ao lado, nunca apagado. Presets antigos do localStorage migram sozinhos na primeira abertura.

## Regras implementadas
- Importação exige projeto; cada arquivo passa por tela de revisão (hash, contornos→peças, material, espessura, modelo, avisos).
- Espessura/material têm origem rotulada: *inferida do nome*, *padrão* ou *manual*. Nada é tratado como confirmado sem estar rotulado.
- Arquivo idêntico (SHA-256) vem desmarcado; mesmo nome com conteúdo diferente gera alerta.
- Peças sem modelo ficam "pendentes" e geram aviso na revisão de exportação.
- Cor pertence ao modelo (persistida), não à espessura nem ao arquivo.
- Projetos são carregados isoladamente: não há mistura entre produtos.
- EPS: só é baixado se a releitura bater com o desenho (chapa, nº de contornos, desvio ≤ 0,01 mm). Nome: padrão configurável, sequência por projeto+material+espessura, sem repetição.
- Histórico: projeto, importação, modelos/cores, presets e exportação (arquivos de origem, validação, opções).

## Limitações conhecidas (não declaradas como concluídas)
1. **Curvas:** o importador ainda converte arcos/círculos em polilinhas; o EPS sai só com retas. Pendente: arcos/Béziers nativos.
2. **Parser DXF** ainda ignora SPLINE, ELLIPSE, POLYLINE clássica, INSERT, HATCH (o aviso aparece na revisão).
3. **Eixo Y do EPS** segue a tela (origem no canto superior esquerdo); o DXF atual não inverte. Confirmar qual vale para a máquina.
4. **Presets por espessura**, tela de revisão completa de exportação (hoje é uma confirmação com lista e avisos), cadastro formal de produto/modelo e bloqueio por "erros impeditivos" ainda não existem.
5. Peças idênticas **dentro do mesmo arquivo** ainda viram quantidade (qty); entre arquivos nunca se fundem.
6. EPS não foi testado em Ghostscript/CorelDRAW nem na máquina de corte (não havia no ambiente).
7. Escrita no servidor assume uma janela por vez: com duas abas, a segunda recebe conflito e para de gravar.
