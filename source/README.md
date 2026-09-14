# Atlas das Áreas de Ponderação — Brasil

Mapa interativo nacional das Áreas de Ponderação do Censo Demográfico 2022. O projeto é independente da versão do estado de São Paulo e usa:

- renderizador cartográfico Canvas incorporado ao próprio site, sem dependências externas de JavaScript;
- GeoJSON nacional leve em pontos para a abertura e 27 arquivos detalhados, um por UF;
- 31 arquivos JSON tabulares carregados sob demanda;
- Stamen Toner Lite, fornecido pela Stadia Maps, como mapa-base.

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
    geojson/overview.geojson
    geojson/{codigo_uf}.geojson
    geojson/manifest.json
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

Os scripts não incorporam o GeoPackage nem as planilhas de origem. Para reconstruir os ativos, instale `openpyxl`, `shapely`, `mercantile`, `mapbox-vector-tile` e `pmtiles`, extraia os 31 XLSX em uma pasta e execute:

```bash
python scripts/build_data.py /caminho/APONDs2022_Brasil.gpkg /caminho/xlsx dist/data
python scripts/build_pmtiles.py /caminho/APONDs2022_Brasil.gpkg dist/data/data-index.json /tmp/aponds-br.pmtiles --maxzoom 10
python scripts/split_pmtiles.py /tmp/aponds-br.pmtiles dist/data/areas.json /tmp/aponds-regioes
node scripts/build_geojson_from_pmtiles.mjs /tmp/aponds-regioes dist/data/geojson 6 0.025
node scripts/build_overview_points.mjs
```

## Execução local

Sirva a pasta do projeto por HTTP; abrir `index.html` diretamente não permite carregar os arquivos locais do atlas.

```bash
python -m http.server 8000 --directory dist
```

Depois acesse `http://localhost:8000`.

## GitHub Pages

O site é publicado automaticamente a partir da pasta `dist` pelo fluxo `pages.yml`. Antes de publicar uma reconstrução completa dos dados, execute:

```bash
python scripts/compress_web_data.py
```

Endereço esperado: `https://marceloreis.github.io/atlas-areas-ponderacao-brasil/`.
