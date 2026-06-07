/**
 * Melbourne Garden Bed Health — Interactive Map
 * s_map.js
 *
 * This script handles:
 * - Mapbox GL map initialisation
 * - Layer rendering with data-driven styling (condition / origin / bed type)
 * - Dual-zoom strategy: point circles at low zoom, polygons at high zoom
 * - Popup on click with bed details
 * - Filter panel (condition, origin, bed type, neighbourhood)
 * - Chart.js dashboard charts
 * - Story panel with guided flyto steps
 * - Legend updates per mode
 */

'use strict';

// ─── TOKEN ───────────────────────────────────────────────────────────────
// Public token for the City of Melbourne / coursework map. Replace if needed.
mapboxgl.accessToken = 'pk.eyJ1IjoiczQyMTkyODQiLCJhIjoiY21vZ2pvZ3J6MHp1NTJwb2twYWtpeHdzYyJ9.W5RlO10Lr3bIrfe7rg2Y6Q';

// ─── COLOUR PALETTES ─────────────────────────────────────────────────────

/** Condition colours - 5-point scale from red (1) to green (5) */
const CONDITION_COLORS = {
  'Total failure': '#c1121f',
  'Poor condition': '#f4a261',
  'Good condition': '#95d5b2',
  'Very good condition': '#52b788',
  'Excellent, new': '#1b4332',
  '': '#ccc',
};
const CONDITION_ORDER = ['Excellent, new', 'Very good condition', 'Good condition', 'Poor condition', 'Total failure'];

/** Origin colours */
const ORIGIN_COLORS = {
  'Indigenous': '#386641',
  'Native': '#6a994e',
  'Mixed': '#bc6c25',
  'Exotic': '#9b2226',
  'N/A': '#aaa',
  'Unknown': '#ccc',
  '': '#ccc',
};
const ORIGIN_ORDER = ['Indigenous', 'Native', 'Mixed', 'Exotic'];

/** Bed type colours */
const TYPE_COLORS = {
  'Perennial bed': '#457b9d',
  'Mulch bed': '#a8dadc',
  'Hedge': '#1d3557',
  'Bioretention bed': '#2a9d8f',
  'Groundcover bed': '#8ecae6',
  'Annual bed': '#e9c46a',
  'Bulb understorey': '#f4a261',
  'Bulb meadow': '#e76f51',
  'Unknown': '#ccc',
  '': '#ccc',
};
const TYPE_ORDER = ['Perennial bed', 'Mulch bed', 'Hedge', 'Bioretention bed', 'Groundcover bed', 'Annual bed', 'Bulb understorey', 'Bulb meadow'];

// Map short keys used in minified data back to readable strings
const KEY = {
  c: 'condition',
  cs: 'condition_score',
  bt: 'bed_type',
  or: 'origin',
  nb: 'neighbourhood',
  si: 'site',
  sp: 'species',
  sc: 'species_count',
  ds: 'dominant_species',
  pc: 'plant_condition',
  wc: 'weed_cover',
  pv: 'plant_cover',
  ir: 'irrigation',
  co: 'corridor',
  lg: 'logs',
  am: 'area_m2',
  sn: 'SITENAME',
  id: 'MCC_ID',
};

// ─── STATE ────────────────────────────────────────────────────────────────
let currentMode = 'condition';   // 'condition' | 'origin' | 'type'
let activeFilters = {};          // {field: [values]}
let activePopupId = null;

// ─── MAP INIT ─────────────────────────────────────────────────────────────
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/light-v11',
  center: [144.962, -37.805],
  zoom: 12,
  minZoom: 11,
  maxZoom: 19,
  maxBounds: [[144.85, -37.88], [145.06, -37.73]], // Melbourne city bounds
});

// Navigation controls
map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');
map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-right');

// ─── SPLASH ───────────────────────────────────────────────────────────────
document.getElementById('splash-enter').addEventListener('click', () => {
  document.getElementById('splash').classList.add('gone');
});

// ─── MAP LOAD ─────────────────────────────────────────────────────────────
map.on('load', () => {
  // Add point source (always loaded, used at low zooms)
  map.addSource('beds-points', {
    type: 'geojson',
    data: GARDEN_BEDS_POINTS,
    generateId: true,
  });

  // Add polygon source lazily — load the poly file once user zooms in
  // For now we serve polygons from the points source centroid (since file is large)
  // The polygon file is loaded separately below for high-zoom detail
  loadPolygonSource();

  addLayers();
  updateLegend();
  setupZoomHint();
  buildFilterPanel();
  buildCharts();
  setupStoryPanel();

  // ---- Municipal boundary outline ----
  // ── MUNICIPAL BOUNDARY ──
  map.addSource('municipality', {
    type: 'geojson',
    data: 'municipal.geojson',  // place your file in the same folder as the HTML
  });

  map.addLayer({
    id: 'municipality-outline',
    type: 'line',
    source: 'municipality',
    paint: {
      'line-color': '#2d6a4f',
      'line-width': 2,
      'line-dasharray': [3, 3],
      'line-opacity': 0.8,
    },
  });
});

// ─── POLYGON SOURCE ───────────────────────────────────────────────────────
/**
 * Load the polygon GeoJSON. Because the file is large (~8MB), we only
 * trigger its visibility at zoom >= 14 to keep performance acceptable.
 * At lower zooms, point circles provide the overview.
 */
function loadPolygonSource() {
  // We reference the poly file relative to the HTML file
  fetch('shrubbed_poly_min.geojson')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data) return;
      // Expand minified keys back to readable properties for consistency
      data.features.forEach(f => {
        const p = f.properties;
        Object.keys(KEY).forEach(k => {
          if (k in p) { p[KEY[k]] = p[k]; }
        });
      });
      map.addSource('beds-poly', { type: 'geojson', data, generateId: true });
      addPolyLayers();
    })
    .catch(() => {
      // Polygon file not found — gracefully degrade to points only
      console.info('Polygon GeoJSON not found — using point circles only.');
    });
}

// ─── LAYERS ───────────────────────────────────────────────────────────────
/**
 * Build Mapbox data-driven fill colour expression for the current mode.
 * Matches each property value to its designated colour.
 */
function colorExpression(propName, colorMap, defaultColor = '#ccc') {
  const stops = [];
  Object.entries(colorMap).forEach(([val, col]) => {
    stops.push(val, col);
  });
  return ['match', ['get', propName], ...stops, defaultColor];
}

function addLayers() {
  // ── CIRCLE LAYER for low zoom overview (zoom 11–14) ──
  map.addLayer({
    id: 'beds-circle',
    type: 'circle',
    source: 'beds-points',
    maxzoom: 15,
    paint: {
      'circle-color': colorExpression('c', CONDITION_COLORS),
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        11, 2.5,
        13, 4,
        14.9, 7,
      ],
      'circle-opacity': 0.8,
      'circle-stroke-width': 0.4,
      'circle-stroke-color': 'rgba(0,0,0,0.2)',
    },
  });

  // ── INTERACTION: hover highlight (circle) ──
  map.addLayer({
    id: 'beds-circle-hover',
    type: 'circle',
    source: 'beds-points',
    maxzoom: 15,
    paint: {
      'circle-color': colorExpression('c', CONDITION_COLORS),
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        11, 4,
        14.9, 9,
      ],
      'circle-opacity': 0.95,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff',
    },
    filter: ['==', ['id'], -1], // nothing highlighted initially
  });
}

function addPolyLayers() {
  if (!map.getSource('beds-poly')) return;

  // ── POLYGON FILL (zoom 14+) ──
  map.addLayer({
    id: 'beds-fill',
    type: 'fill',
    source: 'beds-poly',
    minzoom: 14,
    paint: {
      'fill-color': colorExpression('condition', CONDITION_COLORS),
      'fill-opacity': [
        'interpolate', ['linear'], ['zoom'],
        14, 0.6,
        16, 0.75,
      ],
    },
  });

  // ── POLYGON OUTLINE ──
  map.addLayer({
    id: 'beds-outline',
    type: 'line',
    source: 'beds-poly',
    minzoom: 14,
    paint: {
      'line-color': [
        'interpolate', ['linear'], ['zoom'],
        14, 'rgba(0,0,0,0)',
        15, 'rgba(0,0,0,0.3)',
        17, 'rgba(0,0,0,0.6)',
      ],
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        14, 0.3,
        17, 1.5,
      ],
    },
  });

  // ── POLYGON HOVER HIGHLIGHT ──
  map.addLayer({
    id: 'beds-fill-hover',
    type: 'fill',
    source: 'beds-poly',
    minzoom: 14,
    paint: {
      'fill-color': '#fff',
      'fill-opacity': 0.35,
    },
    filter: ['==', ['id'], -1],
  });

  // ── SPECIES LABEL at very high zoom ──
  map.addLayer({
    id: 'beds-label',
    type: 'symbol',
    source: 'beds-poly',
    minzoom: 17,
    layout: {
      'text-field': ['slice', ['get', 'dominant_species'], 0, 30],
      'text-size': 9,
      'text-max-width': 8,
      'text-anchor': 'center',
    },
    paint: {
      'text-color': '#1a3d2b',
      'text-halo-color': 'rgba(255,255,255,0.8)',
      'text-halo-width': 1.5,
    },
  });

  // Attach events to polygon layer too
  attachPolyEvents();
}

// ─── COLOUR MODE SWITCHING ────────────────────────────────────────────────
/**
 * When the user switches between Condition / Origin / Bed Type modes,
 * update the paint properties for both circle and polygon layers.
 */
function applyColorMode(mode) {
  currentMode = mode;
  let propCircle, propPoly, colorMap;

  if (mode === 'condition') {
    propCircle = 'c'; propPoly = 'condition'; colorMap = CONDITION_COLORS;
  } else if (mode === 'origin') {
    propCircle = 'or'; propPoly = 'origin'; colorMap = ORIGIN_COLORS;
  } else {
    propCircle = 'bt'; propPoly = 'bed_type'; colorMap = TYPE_COLORS;
  }

  // Update circle layer
  if (map.getLayer('beds-circle')) {
    map.setPaintProperty('beds-circle', 'circle-color', colorExpression(propCircle, colorMap));
  }
  if (map.getLayer('beds-circle-hover')) {
    map.setPaintProperty('beds-circle-hover', 'circle-color', colorExpression(propCircle, colorMap));
  }
  // Update poly layers if loaded
  if (map.getLayer('beds-fill')) {
    map.setPaintProperty('beds-fill', 'fill-color', colorExpression(propPoly, colorMap));
  }

  updateLegend();
}

// Mode buttons
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyColorMode(btn.dataset.mode);
  });
});

// ─── LEGEND ───────────────────────────────────────────────────────────────
function updateLegend() {
  const titleEl = document.getElementById('legend-title');
  const itemsEl = document.getElementById('legend-items');

  let title, entries;
  if (currentMode === 'condition') {
    title = 'Garden Bed Condition';
    entries = CONDITION_ORDER.map(k => [k, CONDITION_COLORS[k]]);
  } else if (currentMode === 'origin') {
    title = 'Plant Origin';
    entries = ORIGIN_ORDER.map(k => [k, ORIGIN_COLORS[k]]);
  } else {
    title = 'Bed Type';
    entries = TYPE_ORDER.map(k => [k, TYPE_COLORS[k]]);
  }

  titleEl.textContent = title;
  itemsEl.innerHTML = entries.map(([label, color]) =>
    `<div class="legend-item">
       <div class="legend-swatch" style="background:${color}"></div>
       <span>${label}</span>
     </div>`
  ).join('');
}

// ─── EVENTS: CLICK & HOVER ────────────────────────────────────────────────

// Hover on circles
let hoveredCircleId = null;
map.on('mousemove', 'beds-circle', (e) => {
  map.getCanvas().style.cursor = 'pointer';
  const id = e.features[0].id;
  if (id !== hoveredCircleId) {
    if (hoveredCircleId !== null) map.setFilter('beds-circle-hover', ['==', ['id'], -1]);
    hoveredCircleId = id;
    map.setFilter('beds-circle-hover', ['==', ['id'], id]);
  }
});
map.on('mouseleave', 'beds-circle', () => {
  map.getCanvas().style.cursor = '';
  hoveredCircleId = null;
  map.setFilter('beds-circle-hover', ['==', ['id'], -1]);
});

// Click on circles -> show popup
map.on('click', 'beds-circle', (e) => {
  showPopup(e.features[0].properties);
});

// Polygon events (attached after poly source loads)
function attachPolyEvents() {
  let hoveredPolyId = null;

  map.on('mousemove', 'beds-fill', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const id = e.features[0].id;
    if (id !== hoveredPolyId) {
      if (hoveredPolyId !== null) map.setFilter('beds-fill-hover', ['==', ['id'], -1]);
      hoveredPolyId = id;
      map.setFilter('beds-fill-hover', ['==', ['id'], id]);
    }
  });
  map.on('mouseleave', 'beds-fill', () => {
    map.getCanvas().style.cursor = '';
    hoveredPolyId = null;
    map.setFilter('beds-fill-hover', ['==', ['id'], -1]);
  });
  map.on('click', 'beds-fill', (e) => {
    showPopup(e.features[0].properties);
  });
}

// ─── POPUP ────────────────────────────────────────────────────────────────
/**
 * Show the custom side-panel popup for a clicked feature.
 * Props may use either the short (minified) or long key names.
 */
function showPopup(props) {
  // Normalise keys (handle both minified points and full poly props)
  const p = {
    condition: props.c || props.condition || '',
    condition_score: props.cs ?? props.condition_score ?? 0,
    bed_type: props.bt || props.bed_type || '',
    origin: props.or || props.origin || '',
    neighbourhood: props.nb || props.neighbourhood || '',
    site: props.si || props.site || props.SITENAME || '',
    species: props.sp || props.species || '',
    species_count: props.sc || props.species_count || 0,
    dominant_species: props.ds || props.dominant_species || '',
    plant_condition: props.pc || props.plant_condition || '',
    weed_cover: props.wc || props.weed_cover || '',
    plant_cover: props.pv || props.plant_cover || '',
    irrigation: props.ir || props.irrigation || '',
    corridor: props.co || props.corridor || '',
    area_m2: props.am || props.area_m2 || 0,
    id: props.id || props.MCC_ID || '',
  };

  // Badge colour
  const condColor = CONDITION_COLORS[p.condition] || '#aaa';

  // Score bar width (score 1-5 → 20%-100%)
  const scoreWidth = p.condition_score ? (p.condition_score / 5 * 100) : 0;

  // Build species list (first 5)
  const speciesList = p.species
    ? p.species.split(',').slice(0, 5).map(s => `<em>${s.trim()}</em>`).join(', ')
    : 'Not recorded';

  // Build dominant species
  const dominant = p.dominant_species
    ? `<strong>Dominant:</strong> ${p.dominant_species}`
    : '';

  document.getElementById('popup-content').innerHTML = `
    <span class="popup-badge" style="background:${condColor}">${p.condition || 'Unknown'}</span>
    <div class="popup-site">${p.site || 'Garden Bed'}</div>
    <div class="popup-nb">${p.neighbourhood || ''} · Asset #${p.id}</div>
    <div class="popup-grid">
      <div class="popup-kv">
        <span>Bed Type</span>
        <span>${p.bed_type || '—'}</span>
      </div>
      <div class="popup-kv">
        <span>Origin</span>
        <span>${p.origin || '—'}</span>
      </div>
      <div class="popup-kv">
        <span>Area</span>
        <span>${p.area_m2 ? Math.round(p.area_m2) + ' m²' : '—'}</span>
      </div>
      <div class="popup-kv">
        <span>Species Count</span>
        <span>${p.species_count || '—'}</span>
      </div>
      <div class="popup-kv">
        <span>Weed Cover</span>
        <span>${p.weed_cover && p.weed_cover !== 'NA' ? p.weed_cover : 'Low'}</span>
      </div>
      <div class="popup-kv">
        <span>Irrigation</span>
        <span>${p.irrigation || '—'}</span>
      </div>
    </div>
    ${p.plant_condition && p.plant_condition !== 'NA' ? `
    <div class="popup-kv" style="margin-bottom:0.5rem">
      <span>Plant Condition</span>
      <span>${p.plant_condition}</span>
    </div>` : ''}
    <div class="popup-species">
      <strong>Species recorded</strong>
      ${speciesList}
      ${dominant ? `<br/><br/>${dominant}` : ''}
    </div>
    <div class="score-bar">
      <div class="score-fill" style="width:${scoreWidth}%;background:${condColor}"></div>
    </div>
  `;

  document.getElementById('popup').classList.remove('hidden');

  // Close other panels
  document.getElementById('filter-panel').classList.add('hidden');
  document.getElementById('stats-panel').classList.add('hidden');
}

document.getElementById('popup-close').addEventListener('click', () => {
  document.getElementById('popup').classList.add('hidden');
});

// ─── FILTER PANEL ─────────────────────────────────────────────────────────
function buildFilterPanel() {
  buildCheckboxes('filter-condition', 'c', CONDITION_ORDER, true);
  buildCheckboxes('filter-origin', 'or', ORIGIN_ORDER, true);
  buildCheckboxes('filter-type', 'bt', TYPE_ORDER, true);

  // Neighbourhoods from data
  const nbs = [...new Set(
    GARDEN_BEDS_POINTS.features.map(f => f.properties.nb).filter(v => v && v !== '0' && v !== 'missing')
  )].sort();
  buildCheckboxes('filter-neighbourhood', 'nb', nbs, true);
}

function buildCheckboxes(containerId, field, values, checked) {
  const el = document.getElementById(containerId);
  el.innerHTML = values.map(v =>
    `<label>
      <input type="checkbox" data-field="${field}" data-value="${v}" ${checked ? 'checked' : ''}/>
      ${v}
    </label>`
  ).join('');
}

document.getElementById('filter-toggle').addEventListener('click', () => {
  const panel = document.getElementById('filter-panel');
  panel.classList.toggle('hidden');
  document.getElementById('stats-panel').classList.add('hidden');
  document.getElementById('popup').classList.add('hidden');
});

document.getElementById('filter-apply').addEventListener('click', applyFilters);
document.getElementById('filter-reset').addEventListener('click', () => {
  document.querySelectorAll('#filter-panel input[type=checkbox]').forEach(cb => cb.checked = true);
  applyFilters();
});

/**
 * Read checked filter values and build a Mapbox filter expression.
 * Applies to both circle and polygon layers.
 */
function applyFilters() {
  // Collect unchecked values per field (short keys for points, long for poly)
  const fieldValues = {};
  document.querySelectorAll('#filter-panel input[type=checkbox]:checked').forEach(cb => {
    const f = cb.dataset.field;
    if (!fieldValues[f]) fieldValues[f] = [];
    fieldValues[f].push(cb.dataset.value);
  });

  // Build 'in' expression for each active field
  const clauses = Object.entries(fieldValues).map(([field, vals]) =>
    ['in', ['get', field], ['literal', vals]]
  );

  const filterExpr = clauses.length === 0
    ? null
    : (clauses.length === 1 ? clauses[0] : ['all', ...clauses]);

  ['beds-circle', 'beds-circle-hover'].forEach(id => {
    if (map.getLayer(id)) map.setFilter(id, filterExpr);
  });

  // For poly layers, map short keys back to long keys
  const polyClauseMap = { c: 'condition', or: 'origin', bt: 'bed_type', nb: 'neighbourhood' };
  const polyClauses = Object.entries(fieldValues).map(([field, vals]) => {
    const pf = polyClauseMap[field] || field;
    return ['in', ['get', pf], ['literal', vals]];
  });
  const polyFilter = polyClauses.length === 0 ? null
    : (polyClauses.length === 1 ? polyClauses[0] : ['all', ...polyClauses]);

  ['beds-fill', 'beds-outline', 'beds-fill-hover', 'beds-label'].forEach(id => {
    if (map.getLayer(id)) map.setFilter(id, polyFilter);
  });

  // Count visible features
  const total = GARDEN_BEDS_POINTS.features.filter(f => {
    const p = f.properties;
    return Object.entries(fieldValues).every(([field, vals]) =>
      vals.includes(String(p[field] || ''))
    );
  }).length;

  document.getElementById('filter-count').textContent =
    `Showing ${total.toLocaleString()} beds`;
}

// ─── STATS PANEL ──────────────────────────────────────────────────────────
document.getElementById('stats-toggle').addEventListener('click', () => {
  const panel = document.getElementById('stats-panel');
  panel.classList.toggle('hidden');
  document.getElementById('filter-panel').classList.add('hidden');
  document.getElementById('popup').classList.add('hidden');
});
document.getElementById('stats-close').addEventListener('click', () => {
  document.getElementById('stats-panel').classList.add('hidden');
});

// ─── CHARTS ───────────────────────────────────────────────────────────────
/**
 * Build Chart.js charts from the embedded point dataset.
 * Charts render once on load and reflect the full dataset.
 */
function buildCharts() {
  // ── Count by condition ──
  const conditionCounts = {};
  CONDITION_ORDER.forEach(k => conditionCounts[k] = 0);
  GARDEN_BEDS_POINTS.features.forEach(f => {
    const c = f.properties.c;
    if (c in conditionCounts) conditionCounts[c]++;
  });

  new Chart(document.getElementById('chart-condition'), {
    type: 'doughnut',
    data: {
      labels: CONDITION_ORDER,
      datasets: [{
        data: CONDITION_ORDER.map(k => conditionCounts[k]),
        backgroundColor: CONDITION_ORDER.map(k => CONDITION_COLORS[k]),
        borderWidth: 2,
        borderColor: '#fff',
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'right', labels: { font: { size: 10 }, boxWidth: 12 } } },
    },
  });

  // ── Count by origin ──
  const originCounts = {};
  ORIGIN_ORDER.forEach(k => originCounts[k] = 0);
  GARDEN_BEDS_POINTS.features.forEach(f => {
    const o = f.properties.or;
    if (o in originCounts) originCounts[o]++;
  });

  new Chart(document.getElementById('chart-origin'), {
    type: 'doughnut',
    data: {
      labels: ORIGIN_ORDER,
      datasets: [{
        data: ORIGIN_ORDER.map(k => originCounts[k]),
        backgroundColor: ORIGIN_ORDER.map(k => ORIGIN_COLORS[k]),
        borderWidth: 2, borderColor: '#fff',
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'right', labels: { font: { size: 10 }, boxWidth: 12 } } },
    },
  });

  // ── Avg score by neighbourhood ──
  const nbScores = {};
  const nbCounts = {};
  GARDEN_BEDS_POINTS.features.forEach(f => {
    const nb = f.properties.nb;
    const cs = f.properties.cs;
    if (!nb || nb === '0' || !cs) return;
    if (!nbScores[nb]) { nbScores[nb] = 0; nbCounts[nb] = 0; }
    nbScores[nb] += cs;
    nbCounts[nb]++;
  });

  const nbSorted = Object.entries(nbScores)
    .map(([nb, total]) => ({ nb, avg: total / nbCounts[nb] }))
    .filter(x => nbCounts[x.nb] >= 10)
    .sort((a, b) => b.avg - a.avg);

  const nbColors = nbSorted.map(x => {
    const a = x.avg;
    if (a >= 4) return '#52b788';
    if (a >= 3) return '#95d5b2';
    if (a >= 2.5) return '#f4a261';
    return '#c1121f';
  });

  new Chart(document.getElementById('chart-neighbourhood'), {
    type: 'bar',
    data: {
      labels: nbSorted.map(x => x.nb),
      datasets: [{
        label: 'Avg Condition Score',
        data: nbSorted.map(x => Math.round(x.avg * 100) / 100),
        backgroundColor: nbColors,
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          min: 1, max: 5,
          grid: { color: 'rgba(0,0,0,0.04)' },
          ticks: { font: { size: 10 } },
        },
        y: { ticks: { font: { size: 10 } } },
      },
    },
  });

  // ── Bed type count ──
  const typeCounts = {};
  TYPE_ORDER.forEach(k => typeCounts[k] = 0);
  GARDEN_BEDS_POINTS.features.forEach(f => {
    const bt = f.properties.bt;
    if (bt in typeCounts) typeCounts[bt]++;
  });

  new Chart(document.getElementById('chart-bedtype'), {
    type: 'bar',
    data: {
      labels: TYPE_ORDER.map(k => k.replace(' bed', '').replace(' understorey', '').replace(' meadow', '')),
      datasets: [{
        data: TYPE_ORDER.map(k => typeCounts[k]),
        backgroundColor: TYPE_ORDER.map(k => TYPE_COLORS[k]),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { font: { size: 9 }, maxRotation: 30 } },
        y: { ticks: { font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.04)' } },
      },
    },
  });
}

// ─── STORY PANEL ──────────────────────────────────────────────────────────
/**
 * Story panel — guided flyto narrative steps.
 * Each step can optionally set a filter so only certain beds appear.
 */
function setupStoryPanel() {
  const panel = document.getElementById('story-panel');
  const tab = document.getElementById('story-tab');

  tab.addEventListener('click', () => panel.classList.toggle('open'));

  document.querySelectorAll('.story-step').forEach(step => {
    step.addEventListener('click', () => {
      // Deactivate others
      document.querySelectorAll('.story-step').forEach(s => s.classList.remove('active'));
      step.classList.add('active');

      // Fly to location
      const lat = parseFloat(step.dataset.lat);
      const lon = parseFloat(step.dataset.lon);
      const zoom = parseFloat(step.dataset.zoom);
      map.flyTo({ center: [lon, lat], zoom, duration: 1500, essential: true });

      // Apply story filter
      const filterStr = step.dataset.filter;
      if (filterStr === 'none') {
        // Reset all filters
        ['beds-circle', 'beds-circle-hover'].forEach(id => {
          if (map.getLayer(id)) map.setFilter(id, null);
        });
        ['beds-fill', 'beds-outline', 'beds-fill-hover'].forEach(id => {
          if (map.getLayer(id)) map.setFilter(id, null);
        });
      } else {
        // Parse "field:value1,value2" or "field:value"
        const [field, valStr] = filterStr.split(':');
        const vals = valStr.split(',').map(v => v.trim());

        // Map field name to short key (for points) and long key (for poly)
        const shortKey = { condition: 'c', origin: 'or', type: 'bt' }[field] || field;
        const longKey = { condition: 'condition', origin: 'origin', type: 'bed_type' }[field] || field;

        const ptFilter = ['in', ['get', shortKey], ['literal', vals]];
        const pyFilter = ['in', ['get', longKey], ['literal', vals]];

        ['beds-circle', 'beds-circle-hover'].forEach(id => {
          if (map.getLayer(id)) map.setFilter(id, ptFilter);
        });
        ['beds-fill', 'beds-outline', 'beds-fill-hover'].forEach(id => {
          if (map.getLayer(id)) map.setFilter(id, pyFilter);
        });
      }
    });
  });
}

// ─── ZOOM HINT ────────────────────────────────────────────────────────────
/**
 * Show a hint that polygon detail is available at higher zoom.
 * Hides once the user zooms past zoom 14.
 */
function setupZoomHint() {
  const hint = document.getElementById('zoom-hint');
  map.on('zoom', () => {
    if (map.getZoom() >= 14) {
      hint.classList.add('hidden');
    } else {
      hint.classList.remove('hidden');
    }
  });
}

// ─── CLOSE PANELS ON MAP CLICK ────────────────────────────────────────────
map.on('click', (e) => {
  // Only close if click was NOT on a feature
  const features = map.queryRenderedFeatures(e.point, {
    layers: ['beds-circle', 'beds-fill'].filter(id => map.getLayer(id)),
  });
  if (features.length === 0) {
    document.getElementById('popup').classList.add('hidden');
  }
});
