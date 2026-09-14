const TILE_SIZE = 256;
const TILE_BLEED = 1.5;
const MIN_ZOOM = 2.3;
const MAX_ZOOM = 15;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function worldPoint(lon, lat, zoom) {
  const size = TILE_SIZE * 2 ** zoom;
  const latitude = clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180;
  return [((lon + 180) / 360) * size, (1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * size];
}

function lonLat(point, zoom) {
  const size = TILE_SIZE * 2 ** zoom;
  const y = Math.PI * (1 - 2 * point[1] / size);
  return [point[0] / size * 360 - 180, Math.atan(Math.sinh(y)) * 180 / Math.PI];
}

function intersects(left, right) {
  return left[0] <= right[2] && left[2] >= right[0] && left[1] <= right[3] && left[3] >= right[1];
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (((a[1] > point[1]) !== (b[1] > point[1])) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function pointInGeometry(point, geometry) {
  return geometry.coordinates.some((polygon) => {
    if (!polygon.length || !pointInRing(point, polygon[0])) return false;
    return !polygon.slice(1).some((hole) => pointInRing(point, hole));
  });
}

export class AtlasMap {
  constructor(container, manifest, options = {}) {
    this.container = container;
    this.manifest = manifest;
    this.options = options;
    this.center = [-52.5, -15.5];
    this.zoom = 3.25;
    this.colors = [];
    this.selectedIndex = -1;
    this.overview = [];
    this.states = new Map();
    this.pendingStates = new Set();
    this.tiles = new Map();
    this.drag = null;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "atlas-canvas";
    this.canvas.setAttribute("aria-label", "Mapa interativo das Áreas de Ponderação");
    this.canvas.tabIndex = 0;
    this.context = this.canvas.getContext("2d", { alpha: false });
    this.container.replaceChildren(this.canvas);
    this.addNavigation();
    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.ready = this.loadOverview();
  }

  async loadOverview() {
    const response = await fetch(new URL(this.manifest.overview, document.baseURI));
    if (!response.ok) throw new Error(`Visão nacional: ${response.status}`);
    this.overview = (await response.json()).features;
    this.draw();
  }

  addNavigation() {
    const controls = document.createElement("div");
    controls.className = "canvas-navigation";
    for (const [label, delta, description] of [["+", 1, "Aproximar"], ["−", -1, "Afastar"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-label", description);
      button.addEventListener("click", () => this.setZoom(this.zoom + delta));
      controls.append(button);
    }
    this.container.append(controls);
  }

  bindEvents() {
    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const anchor = this.eventPoint(event);
      const before = this.unproject(anchor);
      this.zoom = clamp(this.zoom - Math.sign(event.deltaY) * 0.55, MIN_ZOOM, MAX_ZOOM);
      const target = worldPoint(before[0], before[1], this.zoom);
      this.center = lonLat([target[0] - anchor[0] + this.width / 2, target[1] - anchor[1] + this.height / 2], this.zoom);
      this.changed();
    }, { passive: false });
    this.canvas.addEventListener("pointerdown", (event) => {
      this.canvas.setPointerCapture(event.pointerId);
      this.drag = { x: event.clientX, y: event.clientY, center: worldPoint(this.center[0], this.center[1], this.zoom), moved: false };
      this.canvas.classList.add("is-dragging");
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.drag) {
        this.handleHover(event);
        return;
      }
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
      this.center = lonLat([this.drag.center[0] - dx, this.drag.center[1] - dy], this.zoom);
      this.changed(false);
    });
    const finish = (event) => {
      if (!this.drag) return;
      const moved = this.drag.moved;
      this.drag = null;
      this.canvas.classList.remove("is-dragging");
      this.ensureVisibleStates();
      if (!moved) this.handleClick(event);
    };
    this.canvas.addEventListener("pointerup", finish);
    this.canvas.addEventListener("pointercancel", finish);
    this.canvas.addEventListener("pointerleave", () => { if (!this.drag) this.options.onHover?.(null); });
    this.canvas.addEventListener("dblclick", (event) => { event.preventDefault(); this.setZoom(this.zoom + 1); });
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.pixelRatio);
    this.canvas.height = Math.round(this.height * this.pixelRatio);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.draw();
  }

  project(coordinate) {
    const point = worldPoint(coordinate[0], coordinate[1], this.zoom);
    const center = worldPoint(this.center[0], this.center[1], this.zoom);
    return [point[0] - center[0] + this.width / 2, point[1] - center[1] + this.height / 2];
  }

  unproject(screen) {
    const center = worldPoint(this.center[0], this.center[1], this.zoom);
    return lonLat([center[0] + screen[0] - this.width / 2, center[1] + screen[1] - this.height / 2], this.zoom);
  }

  getBounds() {
    const southwest = this.unproject([0, this.height]);
    const northeast = this.unproject([this.width, 0]);
    return [southwest[0], southwest[1], northeast[0], northeast[1]];
  }

  setZoom(zoom) {
    this.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.changed();
  }

  changed(loadStates = true) {
    this.center[1] = clamp(this.center[1], -42, 14);
    this.draw();
    if (loadStates) this.ensureVisibleStates();
  }

  fitBounds(bounds, options = {}) {
    const padding = Number(options.padding ?? 30);
    const northwest = worldPoint(bounds[0][0], bounds[1][1], 0);
    const southeast = worldPoint(bounds[1][0], bounds[0][1], 0);
    const scaleX = Math.max(80, this.width - padding * 2) / Math.max(1e-9, southeast[0] - northwest[0]);
    const scaleY = Math.max(80, this.height - padding * 2) / Math.max(1e-9, southeast[1] - northwest[1]);
    this.zoom = clamp(Math.log2(Math.min(scaleX, scaleY)), MIN_ZOOM, options.maxZoom ?? MAX_ZOOM);
    this.center = lonLat([(northwest[0] + southeast[0]) / 2, (northwest[1] + southeast[1]) / 2], 0);
    this.changed();
  }

  setColors(colors) { this.colors = colors; this.draw(); }
  select(geomIndex) { this.selectedIndex = geomIndex; this.draw(); }

  featureColor(feature) {
    return feature.properties.h && this.colors[feature.properties.d] ? this.colors[feature.properties.d] : "#dce3e8";
  }

  draw() {
    if (!this.context || !this.width || !this.height) return;
    const ctx = this.context;
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.fillStyle = "#edf0f2";
    ctx.fillRect(0, 0, this.width, this.height);
    this.drawTiles(ctx);
    this.drawGraticule(ctx);
    if (this.zoom < 6.2) this.drawOverview(ctx);
    if (this.zoom >= 5.5) this.drawStates(ctx);
  }

  drawTiles(ctx) {
    const z = clamp(Math.floor(this.zoom), 2, 12);
    const scale = 2 ** (this.zoom - z);
    const screenSize = TILE_SIZE * scale;
    const center = worldPoint(this.center[0], this.center[1], z);
    const left = center[0] - this.width / 2 / scale;
    const top = center[1] - this.height / 2 / scale;
    const firstX = Math.floor(left / TILE_SIZE);
    const firstY = Math.floor(top / TILE_SIZE);
    const lastX = Math.floor((left + this.width / scale) / TILE_SIZE);
    const lastY = Math.floor((top + this.height / scale) / TILE_SIZE);
    const limit = 2 ** z;
    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.filter = "grayscale(1) contrast(.9)";
    ctx.imageSmoothingEnabled = false;
    for (let x = firstX; x <= lastX; x += 1) for (let y = firstY; y <= lastY; y += 1) {
      if (y < 0 || y >= limit) continue;
      const wrappedX = ((x % limit) + limit) % limit;
      const key = `${z}/${wrappedX}/${y}`;
      let tile = this.tiles.get(key);
      if (!tile) {
        const image = new Image();
        tile = { image, loaded: false, fallback: false };
        this.tiles.set(key, tile);
        image.onload = () => { tile.loaded = true; this.draw(); };
        image.onerror = () => {
          if (tile.fallback) return;
          tile.fallback = true;
          image.src = `https://tile.openstreetmap.org/${key}.png`;
        };
        image.src = `https://tile.openstreetmap.org/${key}.png`;
      }
      if (tile.loaded) {
        const screenX = (x * TILE_SIZE - left) * scale;
        const screenY = (y * TILE_SIZE - top) * scale;
        ctx.drawImage(
          tile.image,
          screenX - TILE_BLEED,
          screenY - TILE_BLEED,
          screenSize + TILE_BLEED * 2,
          screenSize + TILE_BLEED * 2,
        );
      }
    }
    ctx.restore();
  }

  drawGraticule(ctx) {
    ctx.save();
    ctx.strokeStyle = "rgba(77,98,112,.12)";
    ctx.lineWidth = 1;
    for (let lon = -80; lon <= -25; lon += 10) {
      const a = this.project([lon, -40]); const b = this.project([lon, 10]);
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    }
    for (let lat = -40; lat <= 10; lat += 10) {
      const a = this.project([-80, lat]); const b = this.project([-25, lat]);
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    }
    ctx.restore();
  }

  drawOverview(ctx) {
    const radius = 2.1 + (this.zoom - MIN_ZOOM) / (5.5 - MIN_ZOOM) * 2.3;
    for (const feature of this.overview) {
      const point = this.project(feature.geometry.coordinates);
      if (point[0] < -8 || point[1] < -8 || point[0] > this.width + 8 || point[1] > this.height + 8) continue;
      ctx.beginPath(); ctx.arc(point[0], point[1], radius, 0, Math.PI * 2);
      ctx.fillStyle = this.featureColor(feature); ctx.globalAlpha = 0.8; ctx.fill();
      if (feature.properties.g === this.selectedIndex) {
        ctx.globalAlpha = 1; ctx.strokeStyle = "#15263d"; ctx.lineWidth = 2.5; ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  traceGeometry(ctx, geometry) {
    ctx.beginPath();
    for (const polygon of geometry.coordinates) for (const ring of polygon) {
      ring.forEach((coordinate, index) => {
        const point = this.project(coordinate);
        if (index === 0) ctx.moveTo(...point); else ctx.lineTo(...point);
      });
      ctx.closePath();
    }
  }

  drawStates(ctx) {
    const view = this.getBounds();
    for (const { info, features } of this.states.values()) {
      if (!intersects(view, info.bounds)) continue;
      for (const feature of features) {
        this.traceGeometry(ctx, feature.geometry);
        ctx.fillStyle = this.featureColor(feature); ctx.globalAlpha = 0.96; ctx.fill("evenodd");
        ctx.globalAlpha = 1;
        ctx.strokeStyle = feature.properties.g === this.selectedIndex ? "#15263d" : "rgba(255,255,255,.58)";
        ctx.lineWidth = feature.properties.g === this.selectedIndex ? 2.7 : Math.max(0.25, (this.zoom - 3) * 0.12);
        ctx.stroke();
      }
    }
  }

  async ensureVisibleStates() {
    if (this.zoom < 5.35) return;
    const view = this.getBounds();
    for (const info of this.manifest.states) {
      const key = `uf-${info.code}`;
      if (!intersects(view, info.bounds) || this.states.has(key) || this.pendingStates.has(key)) continue;
      this.pendingStates.add(key);
      try {
        const response = await fetch(new URL(info.file, document.baseURI));
        if (!response.ok) throw new Error(`${info.name}: ${response.status}`);
        this.states.set(key, { info, features: (await response.json()).features });
        this.options.onStateLoad?.(key);
        this.draw();
      } catch (error) {
        this.options.onStateError?.(error);
      } finally {
        this.pendingStates.delete(key);
      }
    }
  }

  hitTest(screen) {
    if (this.zoom < 5.5) {
      let closest = null;
      let distance = 42;
      for (const feature of this.overview) {
        const point = this.project(feature.geometry.coordinates);
        const squared = (point[0] - screen[0]) ** 2 + (point[1] - screen[1]) ** 2;
        if (squared < distance) { distance = squared; closest = feature; }
      }
      return closest?.properties.g ?? null;
    }
    const coordinate = this.unproject(screen);
    for (const { info, features } of [...this.states.values()].reverse()) {
      if (!intersects(this.getBounds(), info.bounds)) continue;
      for (const feature of features) if (pointInGeometry(coordinate, feature.geometry)) return feature.properties.g;
    }
    return null;
  }

  eventPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  handleClick(event) { this.options.onClick?.(this.hitTest(this.eventPoint(event))); }

  handleHover(event) {
    const point = this.eventPoint(event);
    const hit = this.hitTest(point);
    this.canvas.style.cursor = hit === null ? "grab" : "pointer";
    this.options.onHover?.(hit, point);
  }
}
