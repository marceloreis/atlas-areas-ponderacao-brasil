import { AtlasMap } from "./atlas-map.js?v=2";

const palette = ["#ffffb2", "#fecc5c", "#fd8d3c", "#f03b20", "#bd0026"];
const nullColor = "#dce3e8";
const selectedColor = "#15263d";
const ASSET_BASE = new URL("./", import.meta.url);
const BRAZIL_BOUNDS = [[-73.9906, -33.7514], [-28.8474, 5.2721]];
const numberInteger = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const numberDecimal = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const numberPercent = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const numberArea = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const numberCurrency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });

const elements = Object.fromEntries([
  "loadingState", "loadingMessage", "areaCount", "variableCount", "areaSearch",
  "clearAreaSearch", "areaResults", "variableSearch", "clearVariableSearch",
  "variableResults", "groupSelect", "metricSelect", "metricSummary", "validCount",
  "legendItems", "mapBadge", "mapBadgeText", "mapBaseNote", "resetView", "detailsPanel",
  "emptyDetails", "detailsContent", "detailsClose", "detailName", "detailMunicipality",
  "detailCode", "detailArea", "detailSectors", "selectedMetricLabel",
  "selectedMetricValue", "selectedMetricTable", "detailSearch", "indicatorGroups",
  "controlPanel", "filtersToggle", "filtersClose", "aboutButton", "aboutDialog",
  "toast", "mobileScrim",
].map((id) => [id, document.getElementById(id)]));

const state = {
  metadata: null,
  geoManifest: null,
  groupsById: new Map(),
  areas: [],
  areasByGeomIndex: new Map(),
  areasByCode: new Map(),
  tableCache: new Map(),
  currentGroupId: "Tab1_1",
  currentFieldIndex: 0,
  currentTable: null,
  numericValues: [],
  thresholds: [],
  map: null,
  popup: null,
  selectedArea: null,
  mapLoaded: false,
  dataReady: false,
  loadedGeoKeys: new Set(["overview"]),
  tonerErrors: 0,
  geojsonErrors: 0,
  toastTimer: null,
  detailsRenderToken: 0,
};

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value, length) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1).trim()}…` : text;
}

function compactTitle(title) {
  return String(title).replace(/^Tabela\s+[\d._]+\s*[-–]\s*/i, "").trim();
}

function tableName(groupId) {
  return groupId.replace(/^Tab/, "Tabela ").replace("_", ".");
}

function numericValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const text = value.trim().replace(",", ".");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function isAbsolute(field) {
  return field.display_mode === "absolute";
}

function fieldLabel(field) {
  return isAbsolute(field) ? field.label : `${field.label} (% do Total)`;
}

function rawValueFor(dataIndex, group, field) {
  return state.tableCache.get(group.id)?.rows?.[dataIndex]?.[field.index] ?? null;
}

function thematicValueFor(dataIndex, group = currentGroup(), field = currentField()) {
  if (dataIndex < 0) return null;
  const row = state.tableCache.get(group.id)?.rows?.[dataIndex];
  if (!row) return null;
  const raw = numericValue(row[field.index]);
  if (raw === null) return null;
  if (isAbsolute(field)) return raw;
  const total = numericValue(row[group.total_field_index]);
  return total === null || total === 0 ? null : (raw / total) * 100;
}

function formatRaw(value, field) {
  if (value === null || value === undefined || value === "" || value === "-") return "Sem dado";
  const number = numericValue(value);
  if (number === null) return String(value);
  if (field.format === "currency") return numberCurrency.format(number);
  if (field.format === "integer") return numberInteger.format(number);
  return numberDecimal.format(number);
}

function formatDisplay(dataIndex, group, field) {
  if (isAbsolute(field)) return formatRaw(rawValueFor(dataIndex, group, field), field);
  const value = thematicValueFor(dataIndex, group, field);
  return value === null ? "Sem dado" : `${numberPercent.format(value)}%`;
}

function formatLegend(value) {
  const field = currentField();
  if (!isAbsolute(field)) return `${numberPercent.format(value)}%`;
  if (field.format === "currency") return numberCurrency.format(value);
  if (field.format === "integer") return numberInteger.format(value);
  return numberDecimal.format(value);
}

function currentGroup() {
  return state.groupsById.get(state.currentGroupId);
}

function currentField() {
  return currentGroup().fields[state.currentFieldIndex];
}

async function fetchJson(path) {
  const response = await fetch(new URL(path.replace(/^\.\//, ""), ASSET_BASE));
  if (!response.ok) throw new Error(`${response.status} ao carregar ${path}`);
  return response.json();
}

function loadTable(groupId) {
  if (state.tableCache.has(groupId)) return Promise.resolve(state.tableCache.get(groupId));
  const group = state.groupsById.get(groupId);
  if (group.loadingPromise) return group.loadingPromise;
  group.loadingPromise = fetchJson(group.file)
    .then((table) => {
      if (table.id !== groupId || table.rows.length !== state.metadata.join.matched) {
        throw new Error(`Estrutura inesperada em ${groupId}`);
      }
      state.tableCache.set(groupId, table);
      group.loadingPromise = null;
      return table;
    })
    .catch((error) => {
      group.loadingPromise = null;
      throw error;
    });
  return group.loadingPromise;
}

function hydrateAreas(payload) {
  const indexes = Object.fromEntries(payload.columns.map((name, index) => [name, index]));
  return payload.rows.map((row) => {
    const area = {
      code: String(row[indexes.cd_apond]),
      name: row[indexes.nm_apond],
      municipality: row[indexes.nm_mun],
      municipalityCode: row[indexes.cd_mun],
      stateName: row[indexes.nm_uf],
      stateCode: row[indexes.cd_uf],
      dataIndex: row[indexes.data_index],
      geomIndex: row[indexes.geom_index],
      bounds: [
        [row[indexes.min_x], row[indexes.min_y]],
        [row[indexes.max_x], row[indexes.max_y]],
      ],
      areaKm2: row[indexes.area_km2],
      sectors: row[indexes.setores],
      type: row[indexes.tipo],
    };
    area.searchText = normalize(`${area.name} ${area.municipality} ${area.stateName} ${area.stateCode} ${area.code}`);
    return area;
  });
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 4300);
}

function showFatal(message) {
  elements.loadingState.classList.add("is-error");
  elements.loadingState.querySelector("strong").textContent = "Não foi possível abrir o atlas";
  elements.loadingMessage.textContent = message;
}

function hideLoading() {
  elements.loadingState.classList.add("is-hidden");
}

function revealWhenReady() {
  if (state.mapLoaded && state.dataReady) hideLoading();
}

function populateSelectors() {
  elements.groupSelect.replaceChildren();
  state.metadata.groups.forEach((group) => {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = `${tableName(group.id)} — ${truncate(compactTitle(group.title), 102)}`;
    elements.groupSelect.append(option);
  });
  elements.groupSelect.value = state.currentGroupId;
  elements.groupSelect.disabled = false;
  populateMetrics();
}

function populateMetrics(preferredIndex = 0) {
  const group = currentGroup();
  elements.metricSelect.replaceChildren();
  group.fields.forEach((field) => {
    const option = document.createElement("option");
    option.value = String(field.index);
    option.textContent = fieldLabel(field);
    elements.metricSelect.append(option);
  });
  state.currentFieldIndex = group.fields[preferredIndex] ? preferredIndex : 0;
  elements.metricSelect.value = String(state.currentFieldIndex);
  elements.metricSelect.disabled = false;
}

function computeTheme() {
  const group = currentGroup();
  const field = currentField();
  const table = state.tableCache.get(group.id);
  const valuesByDataIndex = table.rows.map((_, dataIndex) => thematicValueFor(dataIndex, group, field));
  const values = valuesByDataIndex.filter((value) => value !== null).sort((a, b) => a - b);
  state.numericValues = values;
  state.thresholds = values.length
    ? [0.2, 0.4, 0.6, 0.8].map((fraction) => values[Math.floor((values.length - 1) * fraction)])
    : [];
  const colors = valuesByDataIndex.map((value) => {
    if (value === null || !state.thresholds.length) return nullColor;
    const index = state.thresholds.findIndex((threshold) => value <= threshold);
    return palette[index === -1 ? palette.length - 1 : index];
  });
  return colors;
}

function updateLegend() {
  elements.legendItems.replaceChildren();
  elements.validCount.textContent = state.numericValues.length
    ? `${numberInteger.format(state.numericValues.length)} áreas`
    : "Sem valores numéricos";
  if (!state.numericValues.length) {
    const empty = document.createElement("div");
    empty.className = "empty-result";
    empty.textContent = "Esta variável não permite classificação numérica.";
    elements.legendItems.append(empty);
    return;
  }
  const limits = [state.numericValues[0], ...state.thresholds, state.numericValues.at(-1)];
  palette.forEach((color, index) => {
    const row = document.createElement("div");
    const swatch = document.createElement("span");
    const label = document.createElement("span");
    row.className = "legend-row";
    swatch.style.background = color;
    if (index === 0) label.textContent = `Até ${formatLegend(limits[index + 1])}`;
    else if (index === palette.length - 1) label.textContent = `Mais de ${formatLegend(limits[index])}`;
    else label.textContent = `${formatLegend(limits[index])} – ${formatLegend(limits[index + 1])}`;
    row.append(swatch, label);
    elements.legendItems.append(row);
  });
}

function updateMetricSummary() {
  const group = currentGroup();
  const field = currentField();
  elements.metricSummary.replaceChildren();
  const strong = document.createElement("strong");
  const description = document.createElement("span");
  strong.textContent = fieldLabel(field);
  description.textContent = `${tableName(group.id)} · ${compactTitle(group.title)}`;
  elements.metricSummary.append(strong, description);
  elements.mapBadgeText.textContent = truncate(fieldLabel(field), 82);
  elements.mapBadge.hidden = false;
}

function updateMapTheme() {
  const colors = computeTheme();
  updateLegend();
  updateMetricSummary();
  if (state.mapLoaded) state.map.setColors(colors);
  updateSelectedMetric();
  updateUrl();
}

async function chooseGroup(groupId, fieldIndex = 0) {
  if (!state.groupsById.has(groupId)) return;
  elements.groupSelect.disabled = true;
  elements.metricSelect.disabled = true;
  elements.metricSummary.innerHTML = '<span class="loading-line"></span><span class="loading-line short"></span>';
  try {
    await loadTable(groupId);
    state.currentGroupId = groupId;
    state.currentTable = state.tableCache.get(groupId);
    elements.groupSelect.value = groupId;
    populateMetrics(fieldIndex);
    updateMapTheme();
    if (state.selectedArea) renderIndicatorGroups();
  } catch (error) {
    showToast(`Falha ao carregar ${tableName(groupId)}.`);
    console.error(error);
  } finally {
    elements.groupSelect.disabled = false;
    elements.metricSelect.disabled = false;
  }
}

function renderAreaResults(query) {
  elements.areaResults.replaceChildren();
  elements.clearAreaSearch.hidden = !query;
  const term = normalize(query);
  if (term.length < 2) return;
  const digits = term.replace(/\D/g, "");
  const matches = state.areas
    .filter((area) => area.searchText.includes(term) || (digits && area.code.includes(digits)))
    .sort((a, b) => {
      const aExact = normalize(a.municipality) === term || normalize(a.name) === term || normalize(a.stateCode) === term;
      const bExact = normalize(b.municipality) === term || normalize(b.name) === term || normalize(b.stateCode) === term;
      if (aExact !== bExact) return aExact ? -1 : 1;
      return `${a.stateCode}${a.municipality}${a.name}`.localeCompare(`${b.stateCode}${b.municipality}${b.name}`, "pt-BR");
    })
    .slice(0, 12);
  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "empty-result";
    empty.textContent = "Nenhuma área encontrada.";
    elements.areaResults.append(empty);
    return;
  }
  matches.forEach((area) => {
    const button = document.createElement("button");
    const name = document.createElement("strong");
    const place = document.createElement("span");
    const code = document.createElement("small");
    button.type = "button";
    button.className = "search-result";
    button.setAttribute("role", "option");
    name.textContent = area.name || `Área ${area.code}`;
    place.textContent = `${area.municipality} · ${area.stateCode}`;
    code.textContent = area.code;
    button.append(name, place, code);
    button.addEventListener("click", () => selectArea(area, true));
    elements.areaResults.append(button);
  });
}

function renderVariableResults(query) {
  elements.variableResults.replaceChildren();
  elements.clearVariableSearch.hidden = !query;
  const term = normalize(query);
  if (term.length < 2 || !state.metadata) return;
  const matches = [];
  for (const group of state.metadata.groups) {
    for (const field of group.fields) {
      if (normalize(`${field.label} ${group.title} ${tableName(group.id)}`).includes(term)) {
        matches.push({ group, field });
        if (matches.length === 12) break;
      }
    }
    if (matches.length === 12) break;
  }
  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "empty-result";
    empty.textContent = "Nenhuma variável encontrada.";
    elements.variableResults.append(empty);
    return;
  }
  matches.forEach(({ group, field }) => {
    const button = document.createElement("button");
    const label = document.createElement("strong");
    const table = document.createElement("span");
    button.type = "button";
    button.className = "search-result";
    button.setAttribute("role", "option");
    label.textContent = fieldLabel(field);
    table.textContent = `${tableName(group.id)} · ${truncate(compactTitle(group.title), 72)}`;
    button.append(label, table);
    button.addEventListener("click", async () => {
      elements.variableSearch.value = "";
      elements.clearVariableSearch.hidden = true;
      elements.variableResults.replaceChildren();
      await chooseGroup(group.id, field.index);
    });
    elements.variableResults.append(button);
  });
}

function tooltipNode(area) {
  const container = document.createElement("div");
  const name = document.createElement("strong");
  const place = document.createElement("span");
  const value = document.createElement("span");
  container.className = "map-tooltip";
  name.textContent = area.name || `Área ${area.code}`;
  place.className = "tooltip-place";
  place.textContent = `${area.municipality} · ${area.stateCode}`;
  value.className = "tooltip-value";
  value.textContent = `${truncate(fieldLabel(currentField()), 52)}: ${formatDisplay(area.dataIndex, currentGroup(), currentField())}`;
  container.append(name, place, value);
  return container;
}

function updateSelectedMetric() {
  if (!state.selectedArea) return;
  const group = currentGroup();
  const field = currentField();
  elements.selectedMetricLabel.textContent = fieldLabel(field);
  elements.selectedMetricValue.textContent = formatDisplay(state.selectedArea.dataIndex, group, field);
  elements.selectedMetricTable.textContent = `${tableName(group.id)} · ${compactTitle(group.title)}`;
}

function renderGroupBody(body, group, fieldIndexes, area, token) {
  body.replaceChildren();
  const loading = document.createElement("div");
  loading.className = "indicator-loading";
  loading.textContent = "Carregando tabela…";
  body.append(loading);
  loadTable(group.id)
    .then(() => {
      if (token !== state.detailsRenderToken || state.selectedArea?.geomIndex !== area.geomIndex) return;
      body.replaceChildren();
      fieldIndexes.forEach((fieldIndex) => {
        const field = group.fields[fieldIndex];
        const row = document.createElement("div");
        const label = document.createElement("span");
        const value = document.createElement("strong");
        row.className = "indicator-row";
        if (group.id === state.currentGroupId && field.index === state.currentFieldIndex) {
          row.classList.add("highlighted");
        }
        label.textContent = fieldLabel(field);
        value.textContent = formatDisplay(area.dataIndex, group, field);
        row.append(label, value);
        body.append(row);
      });
    })
    .catch((error) => {
      console.error(error);
      loading.textContent = "Não foi possível carregar esta tabela.";
    });
}

function renderIndicatorGroups() {
  state.detailsRenderToken += 1;
  const token = state.detailsRenderToken;
  const area = state.selectedArea;
  elements.indicatorGroups.replaceChildren();
  if (!area || area.dataIndex < 0) {
    const empty = document.createElement("div");
    empty.className = "no-area-data";
    empty.textContent = "Esta feição cartográfica não possui uma linha correspondente nas tabelas do Censo 2022.";
    elements.indicatorGroups.append(empty);
    return;
  }
  const filter = normalize(elements.detailSearch.value);
  let shown = 0;
  state.metadata.groups.forEach((group) => {
    const indexes = group.fields
      .filter((field) => !filter || normalize(`${field.label} ${group.title}`).includes(filter))
      .map((field) => field.index);
    if (!indexes.length) return;
    shown += indexes.length;
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const body = document.createElement("div");
    details.className = "indicator-group";
    title.textContent = compactTitle(group.title);
    meta.textContent = `${tableName(group.id)} · ${indexes.length} ${indexes.length === 1 ? "indicador" : "indicadores"}`;
    summary.append(title, meta);
    body.className = "indicator-group-body";
    details.append(summary, body);
    let rendered = false;
    const ensureBody = () => {
      if (rendered) return;
      rendered = true;
      renderGroupBody(body, group, indexes, area, token);
    };
    details.addEventListener("toggle", () => { if (details.open) ensureBody(); });
    if (group.id === state.currentGroupId || filter) {
      details.open = true;
      ensureBody();
    }
    elements.indicatorGroups.append(details);
  });
  if (!shown) {
    const empty = document.createElement("div");
    empty.className = "no-area-data";
    empty.textContent = "Nenhum indicador corresponde ao filtro informado.";
    elements.indicatorGroups.append(empty);
  }
}

function selectArea(area, focus = false) {
  state.selectedArea = area;
  if (state.mapLoaded) {
    state.map.select(area.geomIndex);
    if (focus) {
      state.map.fitBounds(area.bounds, { padding: 64, maxZoom: 11.5, duration: 850 });
    }
  }
  elements.areaSearch.value = "";
  elements.clearAreaSearch.hidden = true;
  elements.areaResults.replaceChildren();
  elements.emptyDetails.hidden = true;
  elements.detailsContent.hidden = false;
  elements.detailsPanel.classList.add("has-selection");
  elements.detailsPanel.scrollTop = 0;
  elements.detailName.textContent = area.name || `Área ${area.code}`;
  elements.detailMunicipality.textContent = `${area.municipality} · ${area.stateName} (${area.stateCode})`;
  elements.detailCode.textContent = `Código ${area.code}`;
  elements.detailArea.textContent = `${numberArea.format(area.areaKm2)} km²`;
  elements.detailSectors.textContent = `${numberInteger.format(area.sectors)} setores`;
  elements.detailSearch.value = "";
  updateSelectedMetric();
  renderIndicatorGroups();
  closeFilters();
  updateUrl();
}

function clearSelection() {
  state.selectedArea = null;
  state.detailsRenderToken += 1;
  if (state.mapLoaded) state.map.select(-1);
  elements.detailsPanel.classList.remove("has-selection");
  elements.detailsContent.hidden = true;
  elements.emptyDetails.hidden = false;
  updateUrl();
}

function fitBrazil(duration = 700) {
  state.map?.fitBounds(BRAZIL_BOUNDS, { padding: 30, duration });
}

function updateUrl() {
  if (!state.metadata) return;
  const url = new URL(window.location.href);
  url.searchParams.set("tab", state.currentGroupId);
  url.searchParams.set("var", String(state.currentFieldIndex));
  if (state.selectedArea) url.searchParams.set("area", state.selectedArea.code);
  else url.searchParams.delete("area");
  window.history.replaceState(null, "", url);
}

function initializeMap() {
  state.map = new AtlasMap(document.getElementById("map"), state.geoManifest, {
    onClick: (geomIndex) => {
      const area = state.areasByGeomIndex.get(Number(geomIndex));
      if (area) selectArea(area, false);
    },
    onStateLoad: (key) => state.loadedGeoKeys.add(key),
    onStateError: (error) => {
      console.error(error);
      if (state.geojsonErrors++ === 0) showToast("Não foi possível carregar uma das UFs. Tente aproximar novamente.");
    },
  });
  state.map.ready.then(() => {
    state.mapLoaded = true;
    if (state.currentTable) updateMapTheme();
    revealWhenReady();
  }).catch((error) => {
    console.error(error);
    showFatal("A visão nacional do atlas não pôde ser carregada.");
  });
}

function openFilters() {
  elements.controlPanel.classList.add("is-open");
  elements.mobileScrim.hidden = false;
  elements.mobileScrim.classList.add("mobile-scrim");
}

function closeFilters() {
  elements.controlPanel.classList.remove("is-open");
  elements.mobileScrim.hidden = true;
}

function bindEvents() {
  elements.groupSelect.addEventListener("change", () => chooseGroup(elements.groupSelect.value, 0));
  elements.metricSelect.addEventListener("change", () => {
    state.currentFieldIndex = Number(elements.metricSelect.value);
    updateMapTheme();
    if (state.selectedArea) renderIndicatorGroups();
  });
  elements.areaSearch.addEventListener("input", () => renderAreaResults(elements.areaSearch.value));
  elements.variableSearch.addEventListener("input", () => renderVariableResults(elements.variableSearch.value));
  elements.clearAreaSearch.addEventListener("click", () => {
    elements.areaSearch.value = "";
    renderAreaResults("");
    elements.areaSearch.focus();
  });
  elements.clearVariableSearch.addEventListener("click", () => {
    elements.variableSearch.value = "";
    renderVariableResults("");
    elements.variableSearch.focus();
  });
  elements.detailSearch.addEventListener("input", renderIndicatorGroups);
  elements.detailsClose.addEventListener("click", clearSelection);
  elements.resetView.addEventListener("click", () => fitBrazil());
  elements.aboutButton.addEventListener("click", () => elements.aboutDialog.showModal());
  elements.filtersToggle.addEventListener("click", openFilters);
  elements.filtersClose.addEventListener("click", closeFilters);
  elements.mobileScrim.addEventListener("click", closeFilters);
  document.addEventListener("click", (event) => {
    if (!elements.areaSearch.closest(".search-group").contains(event.target)) elements.areaResults.replaceChildren();
    if (!elements.variableSearch.closest(".variable-search-group").contains(event.target)) elements.variableResults.replaceChildren();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      elements.areaResults.replaceChildren();
      elements.variableResults.replaceChildren();
      closeFilters();
    }
  });
}

async function start() {
  bindEvents();
  try {
    const areaPayloadPromise = fetchJson("./data/areas.json");
    const geoManifestPromise = fetchJson("./data/geojson/manifest.json");
    elements.loadingMessage.textContent = "Carregando catálogo de indicadores…";
    const [metadata, geoManifest] = await Promise.all([
      fetchJson("./data/metadata.json"),
      geoManifestPromise,
    ]);
    state.metadata = metadata;
    state.geoManifest = geoManifest;
    state.groupsById = new Map(metadata.groups.map((group) => [group.id, group]));
    elements.variableCount.textContent = numberInteger.format(metadata.groups.reduce((sum, group) => sum + group.fields.length, 0));

    const params = new URL(window.location.href).searchParams;
    const requestedGroup = params.get("tab");
    if (requestedGroup && state.groupsById.has(requestedGroup)) state.currentGroupId = requestedGroup;
    const requestedField = Number(params.get("var"));
    populateSelectors();
    if (Number.isInteger(requestedField) && currentGroup().fields[requestedField]) populateMetrics(requestedField);
    initializeMap();

    elements.loadingMessage.textContent = "Carregando áreas e o primeiro indicador…";
    const [areaPayload] = await Promise.all([
      areaPayloadPromise,
      loadTable(state.currentGroupId),
    ]);
    state.areas = hydrateAreas(areaPayload);
    state.areasByGeomIndex = new Map(state.areas.map((area) => [area.geomIndex, area]));
    state.areasByCode = new Map(state.areas.map((area) => [area.code, area]));
    elements.areaCount.textContent = numberInteger.format(state.areas.length);
    state.currentTable = state.tableCache.get(state.currentGroupId);
    state.dataReady = true;
    updateMapTheme();
    const selectedCode = params.get("area");
    if (selectedCode && state.areasByCode.has(selectedCode)) selectArea(state.areasByCode.get(selectedCode), true);
    revealWhenReady();
  } catch (error) {
    console.error(error);
    showFatal("Confira a conexão e tente recarregar a página. Os arquivos locais do atlas não responderam como esperado.");
  }
}

start();
