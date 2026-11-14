// People's Case File — starter map. Untested against live data: see CLAUDE.md.
// Reads site/data/index.json (written by the collector) or falls back to sample.geojson.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Layer registry: each layer is a GeoJSON file the collector produces.
  const LAYERS = [
    { id: 'facilities', name: 'Facilities + violations', tag: 'ECHO', color: '#b2400f', on: true },
    { id: 'water', name: 'Water systems', tag: 'SDWIS', color: '#0e7a8a', on: true },
    { id: 'tri', name: 'Toxic releases', tag: 'TRI', color: '#8a3ea8', on: true },
    { id: 'mines', name: 'Mines + who controls them', tag: 'MSHA', color: '#5d636e', on: true },
  ];

  const map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster', tileSize: 256,
          // OSM's tile servers are for light use only; switch to OpenFreeMap or a self-hosted PMTiles basemap before launch.
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          attribution: '© OpenStreetMap contributors',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    },
    center: [-83.25, 36.87], // Harlan County, KY pilot (first real-data test)
    zoom: 10,
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.json();
  }

  let meta = { sample: true, pulled: null };
  async function loadData() {
    let byLayer = {};
    try {
      const idx = await getJSON('data/index.json'); // {pulled, layers:{facilities:'facilities.geojson',...}}
      meta = { sample: false, pulled: idx.pulled };
      for (const [k, f] of Object.entries(idx.layers)) byLayer[k] = await getJSON('data/' + f);
    } catch (e) {
      const s = await getJSON('data/sample.geojson');
      for (const L of LAYERS) byLayer[L.id] = { type: 'FeatureCollection', features: s.features.filter((f) => f.properties.layer === L.id) };
    }
    $('fresh').innerHTML = meta.sample
      ? '<span class="sample">SAMPLE DATA</span> Collector has not run yet.'
      : 'Data pulled ' + esc(meta.pulled) + ' · archived copies kept';
    for (const L of LAYERS) {
      const data = byLayer[L.id] || { type: 'FeatureCollection', features: [] };
      L.count = data.features.length;
      if (!L.count) L.on = false;
      map.addSource(L.id, { type: 'geojson', data });
      map.addLayer({
        id: L.id, type: 'circle', source: L.id,
        layout: { visibility: L.on ? 'visible' : 'none' },
        paint: {
          'circle-color': L.color,
          'circle-radius': ['interpolate', ['linear'], ['coalesce', ['get', 'qtrs_noncompliance'], ['get', 'violations'], 0], 0, 5, 12, 12],
          'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
        },
      });
      map.on('click', L.id, (e) => showFeature(e.features[0]));
      map.on('mouseenter', L.id, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', L.id, () => (map.getCanvas().style.cursor = ''));
    }
    buildLayerList();
  }

  function buildLayerList() {
    $('layerList').innerHTML = LAYERS.map((L) =>
      L.count
        ? `<label><input type="checkbox" data-l="${L.id}" ${L.on ? 'checked' : ''}>${esc(L.name)} <span class="muted">(${L.count.toLocaleString()})</span><span class="tag">${esc(L.tag)}</span></label>`
        : `<label><input type="checkbox" disabled>${esc(L.name)}<span class="soon">not collected yet</span></label>`).join('');
    $('layerList').addEventListener('change', (e) => {
      const id = e.target.dataset.l; if (!id) return;
      map.setLayoutProperty(id, 'visibility', e.target.checked ? 'visible' : 'none');
    });
  }

  // Every fact shows its source + date. Properties come from the collector:
  // {name, kind, violations, penalties, operator, parent, parent_confidence, source, source_url, as_of, ids:{frs,...}}
  function showFeature(f) {
    const p = f.properties;
    const parse = (v, d) => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch (e) { return d; } })() : (v || d));
    const ids = parse(p.ids, {});
    const hist = parse(p.history, []);
    const flags = parse(p.flags, []);
    const histHtml = hist.length ? `<details open><summary>Who ran it, who controlled it</summary><ol class="hist">${hist.slice().reverse().map((h) =>
      `<li><b>${esc(h.operator || 'Unknown operator')}</b> <span class="muted">operator ${esc(h.op_start || '?')} → ${esc(h.op_end || 'now')}</span>` +
      (h.controller ? `<br>controlled by <b>${esc(h.controller)}</b>${h.controller_type ? ` <span class="muted">(${esc(h.controller_type)})</span>` : ''}` : '') +
      `</li>`).join('')}</ol></details>` : '';
    $('detailBody').innerHTML = `
      ${meta.sample ? '<p><span class="sample">SAMPLE</span></p>' : ''}
      <div class="fac"><h3>${esc(p.name)}</h3>
      <p class="muted">${esc(p.kind || '')}</p>
      ${p.qtrs_noncompliance != null ? `<p><span class="badge">${esc(p.qtrs_noncompliance)} of last 12 quarters out of compliance</span></p>` : ''}
      ${p.violations != null && p.qtrs_noncompliance == null ? `<p><span class="badge">${esc(p.violations)} violations</span></p>` : ''}
      ${p.penalties != null ? `<p>Penalties: $${Number(p.penalties).toLocaleString()}</p>` : ''}
      ${p.operator ? `<p>Operator: ${esc(p.operator)}</p>` : ''}
      ${p.parent ? `<p>Controller / parent: ${esc(p.parent)} <span class="muted">(linked to · ${esc(p.parent_confidence || 'unrated')})</span></p>` : ''}
      ${histHtml}
      ${flags.length ? `<p class="muted">Data note: ${flags.map(esc).join('; ')}</p>` : ''}
      <p class="src">SOURCE: ${p.source_url ? `<a href="${esc(p.source_url)}" target="_blank" rel="noopener">${esc(p.source)}</a>` : esc(p.source)} · AS OF ${esc(p.as_of)}</p>
      <p class="src pro">IDS: ${esc(Object.entries(ids).filter(([, v]) => v).map(([k, v]) => k + ' ' + v).join(' · '))}</p></div>`;
  }

  // Address search: Nominatim (light use only, 1 req/sec; follow its usage policy or swap for a self-hosted geocoder).
  $('search').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('q').value.trim(); if (!q) return;
    try {
      const r = await getJSON('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q));
      if (!r.length) { $('detailBody').innerHTML = '<p class="muted">No match for that address.</p>'; return; }
      map.flyTo({ center: [+r[0].lon, +r[0].lat], zoom: 14 });
    } catch (err) { $('detailBody').innerHTML = '<p class="muted">Search is unavailable right now.</p>'; }
  });

  // Simple / Pro
  function setMode(pro) {
    document.body.classList.toggle('simple', !pro);
    $('mSimple').setAttribute('aria-pressed', String(!pro));
    $('mPro').setAttribute('aria-pressed', String(pro));
    try { localStorage.setItem('pcfPro', pro ? '1' : '0'); } catch (e) {}
  }
  $('mSimple').onclick = () => setMode(false);
  $('mPro').onclick = () => setMode(true);
  let pro = false; try { pro = localStorage.getItem('pcfPro') === '1'; } catch (e) {}
  setMode(pro);

  map.on('load', loadData);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
