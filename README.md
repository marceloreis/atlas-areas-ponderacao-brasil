# Atlas das Áreas de Ponderação — Brasil · versão GeoJSON multinível

Mapa interativo nacional das Áreas de Ponderação do Censo Demográfico 2022. O projeto é independente da versão do estado de São Paulo e usa:

- renderizador cartográfico Canvas incorporado ao próprio site, sem dependências externas de JavaScript;
- três GeoJSON nacionais topologicamente contínuos, com níveis nacional, regional e local;
- troca atômica do nível de detalhe conforme o zoom, mantendo a malha anterior visível durante o carregamento;
- 31 arquivos JSON tabulares carregados sob demanda;
- OpenStreetMap em segundo plano, sem recortar ou tilear a camada temática.

## Base de dados

- Malha: `AreasDePonderacao2022_Brasil`, do GeoPackage oficial do IBGE;
- Chave da malha: `cd_apond`;
- Chave das planilhas: `Área de ponderação`;
- Feições na malha: 14.406;
- Feições associadas às tabelas: 14.270;
- Tabelas: 31;
- Variáveis: 305.

As 136 geometrias sem correspondência tabular permanecem no mapa como `Sem dado`.

## Estrutura

```text
dist/
  index.html
  app.js
  styles.css
  data/
    lod/nacional.geojson.gz
    lod/regional.geojson.gz
    lod/detalhado.geojson.gz
    lod/manifest.json
    areas.json
    metadata.json
    tables/*.json
scripts/
  build_data.py
  build_pmtiles.py
  split_pmtiles.py
  build_geojson_from_pmtiles.mjs
```

## Reconstrução dos dados

Os três níveis devem ser derivados da mesma topologia, conservar os 14.406 códigos `cd_apond` e passar pela validação de cobertura antes da publicação. A simplificação nunca deve ser aplicada separadamente a cada polígono.

| Nível | Entrada no zoom | Feições | Vértices | Tamanho |
| --- | ---: | ---: | ---: | ---: |
| Nacional | 0 | 14.406 | 453.930 | 12,1 MB |
| Regional | 4,8 | 14.406 | 1.280.023 | 31,4 MB |
| Detalhado | 7,8 | 14.406 | 3.176.731 | 76,0 MB |

Todos os níveis foram validados como coberturas topológicas, sem geometrias vazias ou inválidas. A compactação gzip reduz a transferência sem alterar qualquer coordenada; a descompactação acontece no navegador. As faixas de saída usam uma margem de 0,4 ponto de zoom para evitar trocas repetidas junto aos limiares.

## Execução local

Sirva a pasta do projeto por HTTP; abrir `index.html` diretamente não permite carregar os arquivos locais do atlas.

```bash
python -m http.server 8000 --directory dist
```

Depois acesse `http://localhost:8000`.

## Publicação

Este diretório é uma alternativa independente. Ele não substitui nem altera a versão principal do atlas. A pasta `dist` contém integralmente o site estático.
