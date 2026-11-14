// People's Case File: Curtain Puller map.
// Reads site/data/index.json, mines.geojson, facilities.geojson and families.json
// written by collector/collect.py. Falls back to sample.geojson (labelled SAMPLE).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const parse = (v, d) => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch (e) { return d; } })() : (v ?? d));
  const MSHA_LOOKUP = 'https://www.msha.gov/mine-data-retrieval-system';

  const LAYERS = [
    { id: 'mines', name: 'Mines + who controls them', tag: 'MSHA', on: true },
    { id: 'facilities', name: 'EPA-regulated facilities', tag: 'ECHO', on: true },
    { id: 'water', name: 'Water systems', tag: 'SDWIS', on: true },
    { id: 'tri', name: 'Toxic releases', tag: 'TRI', on: true },
  ];

  const map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        base: {
          type: 'raster', tileSize: 256,
          // Free CARTO dark basemap (OSM data), light use only. Swap for self-hosted PMTiles before launch.
          tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`),
          attribution: '© OpenStreetMap contributors © CARTO',
        },
      },
      layers: [{ id: 'base', type: 'raster', source: 'base' }],
    },
    center: [-83.25, 36.87], // Harlan County, KY pilot
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
  let families = {};      // controller_id -> family
  let mineById = {};      // msha mine id -> feature
  const intro = $('detailBody').innerHTML;

  async function loadData() {
    const byLayer = {};
    try {
      const idx = await getJSON('data/index.json');
      meta = { sample: false, pulled: idx.pulled };
      for (const [k, f] of Object.entries(idx.layers)) byLayer[k] = await getJSON('data/' + f);
      try { for (const f of await getJSON('data/families.json')) families[f.controller_id] = f; } catch (e) {}
    } catch (e) {
      const s = await getJSON('data/sample.geojson');
      for (const L of LAYERS) byLayer[L.id] = { type: 'FeatureCollection', features: s.features.filter((f) => f.properties.layer === L.id) };
    }
    $('fresh').innerHTML = meta.sample ? '<span class="sample">SAMPLE DATA</span>' : 'DATA PULLED ' + esc(meta.pulled) + ' · ARCHIVED';
    for (const f of (byLayer.mines || { features: [] }).features) mineById[f.properties.ids?.msha_mine] = f;

    for (const L of LAYERS) {
      const data = byLayer[L.id] || { type: 'FeatureCollection', features: [] };
      L.count = data.features.length;
      if (!L.count) L.on = false;
      map.addSource(L.id, { type: 'geojson', data });
      const isMine = L.id === 'mines';
      map.addLayer({
        id: L.id, type: 'circle', source: L.id,
        layout: { visibility: L.on ? 'visible' : 'none', 'circle-sort-key': isMine ? ['coalesce', ['get', 'citations'], 0] : 0 },
        paint: {
          'circle-color': isMine
            ? ['case', ['==', ['get', 'status'], 'Active'], '#E3A44E', '#5A6270']
            : (L.id === 'facilities' ? '#86B6CC' : '#9CC6D8'),
          'circle-radius': isMine
            ? ['interpolate', ['linear'], ['sqrt', ['coalesce', ['get', 'citations'], 0]], 0, 4, 10, 9, 40, 18]
            : ['interpolate', ['linear'], ['coalesce', ['get', 'qtrs_noncompliance'], 0], 0, 4, 12, 10],
          'circle-opacity': 0.9,
          'circle-stroke-color': '#0A0C0F', 'circle-stroke-width': 1.2,
        },
      });
      map.on('click', L.id, (e) => (isMine ? showMine(e.features[0].properties) : showFacility(e.features[0].properties)));
      map.on('mouseenter', L.id, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', L.id, () => (map.getCanvas().style.cursor = ''));
    }
    buildLayerList();
  }

  function buildLayerList() {
    $('layerList').innerHTML = LAYERS.map((L) =>
      L.count
        ? `<label><input type="checkbox" data-l="${L.id}" ${L.on ? 'checked' : ''}>${esc(L.name)} <span class="count">${num(L.count)}</span><span class="tag">${esc(L.tag)}</span></label>`
        : `<label><input type="checkbox" disabled>${esc(L.name)}<span class="soon">not collected yet</span></label>`).join('');
    $('layerList').addEventListener('change', (e) => {
      const id = e.target.dataset.l; if (!id) return;
      map.setLayoutProperty(id, 'visibility', e.target.checked ? 'visible' : 'none');
    });
  }

  function show(html) {
    $('detailBody').innerHTML = html;
    $('detail').scrollTop = 0;
    if (window.innerWidth <= 760) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function violStats(v, scope) {
    if (!v) return '';
    const paidPct = v.due > 0 ? Math.round((v.paid / v.due) * 100) : null;
    return `
      <div class="stats" role="group" aria-label="Safety citations ${esc(scope)}">
        <div class="stat"><span class="k">Safety citations</span><span class="v">${num(v.total)}</span><span class="s">${v.first ? esc(v.first.slice(0, 4)) + '–' + esc(v.last.slice(0, 4)) : 'none on record'}</span></div>
        <div class="stat"><span class="k">Serious (S&amp;S)</span><span class="v ${v.sig_sub ? 'warm' : ''}">${num(v.sig_sub)}</span><span class="s">likely to cause injury</span></div>
        <div class="stat"><span class="k">Last 5 years</span><span class="v">${num(v.last5)}</span><span class="s">citations issued</span></div>
        <div class="stat"><span class="k">Penalties owed</span><span class="v">${usd(v.due)}</span><span class="s ${paidPct !== null && paidPct < 50 ? 'hot' : ''}">${paidPct === null ? '—' : paidPct + '% paid (' + usd(v.paid) + ')'}</span></div>
      </div>
      <p class="note pro">Proposed at issue: ${usd(v.proposed)} · vacated citations left out: ${num(v.vacated)}${v.contractor != null ? ' · cited to contractors (not counted): ' + num(v.contractor) : ''}</p>`;
  }

  function personLabel(name, type) {
    return (type || '').toUpperCase().startsWith('P') ? `${esc(name)} <span class="muted-s">(individual, as named in MSHA records)</span>` : esc(name);
  }

  function showMine(p) {
    const ids = parse(p.ids, {});
    const hist = parse(p.history, []);
    const flags = parse(p.flags, []);
    const v = parse(p.viol, null);
    const fam = families[ids.msha_controller];
    const histHtml = hist.length ? `<details ${hist.length <= 4 ? 'open' : ''}><summary>Who ran it, who controlled it (${hist.length})</summary><ol class="hist">${hist.slice().reverse().map((h) =>
      `<li><b>${esc(h.operator || 'Unknown operator')}</b> <span class="muted-s">operator</span>` +
      (h.controller ? `<br><span class="muted-s">controlled by</span> ${personLabel(h.controller, h.controller_type)}` : '') +
      `<span class="when">${esc(h.op_start || '?')} → ${esc(h.op_end || 'now')}</span></li>`).join('')}</ol></details>` : '';
    show(`
      ${meta.sample ? '<p><span class="sample">SAMPLE</span></p>' : ''}
      <p class="eyebrow">${esc((p.kind || 'Mine').toUpperCase())}</p>
      <h2 class="card-title">${esc(p.name)}</h2>
      ${violStats(v, 'at this mine')}
      ${p.operator ? `<div class="row"><span class="lbl">Operator now</span><span>${esc(p.operator)}</span></div>` : ''}
      ${p.parent ? `<div class="row"><span class="lbl">Controller now</span><span>${esc(p.parent)}</span></div>` : ''}
      ${fam ? `<div class="btns"><button type="button" class="btn primary" data-fam="${esc(fam.controller_id)}">Pull the curtain on this controller →</button></div>` : ''}
      ${histHtml}
      ${flags.length ? `<p class="flag">Data note: ${flags.map(esc).join('; ')}</p>` : ''}
      <p class="src">SOURCE: <a href="${MSHA_LOOKUP}" target="_blank" rel="noopener">MSHA Mine Data Retrieval</a> · search mine ID ${esc(ids.msha_mine)} · pulled ${esc(p.as_of)}</p>
      <p class="src pro">IDS: MSHA mine ${esc(ids.msha_mine)}${ids.msha_controller ? ' · controller ' + esc(ids.msha_controller) : ''}</p>`);
  }

  function showFamily(cid) {
    const f = families[cid]; if (!f) return;
    const v = f.viol;
    const mines = (f.mines || []).map((m) => ({ ...m, feat: mineById[m.id] }))
      .sort((a, b) => (b.feat?.properties.citations || 0) - (a.feat?.properties.citations || 0));
    show(`
      <p class="eyebrow">CONTROLLER · ${esc((f.controller_type || 'unknown').toUpperCase())} · MSHA ${esc(f.controller_id)}</p>
      <h2 class="card-title">${personLabel(f.controller, f.controller_type)}</h2>
      <p class="muted-s">At Harlan County mines: ${num(mines.length)} mine${mines.length === 1 ? '' : 's'}, run through ${num((f.operators || []).length)} operating compan${(f.operators || []).length === 1 ? 'y' : 'ies'}.</p>
      ${violStats(v, 'under this controller')}
      <p class="note">Citations are counted under the controller MSHA recorded on the day each was issued.</p>
      <details open><summary>Operating companies (${num((f.operators || []).length)})</summary><ol class="hist">${(f.operators || []).map((o) => `<li>${esc(o.name || 'Unnamed')} <span class="when pro">MSHA operator ${esc(o.id)}</span></li>`).join('')}</ol></details>
      <details open><summary>Mines (${num(mines.length)})</summary><ul class="mines-list">${mines.map((m) =>
        `<li><button type="button" data-mine="${esc(m.id)}"><span>${esc(m.name || 'Mine ' + m.id)}</span><span class="count">${num(m.feat?.properties.citations || 0)} citations</span></button></li>`).join('')}</ul></details>
      <p class="flag">Not connected yet: parent companies above this controller, and the same company under other MSHA IDs. That’s the next layer of the Curtain Puller.</p>
      <p class="src">SOURCE: MSHA Controller/Operator History + Violations · pulled ${esc(f.as_of)}</p>`);
  }

  function showFacility(p) {
    const ids = parse(p.ids, {});
    show(`
      ${meta.sample ? '<p><span class="sample">SAMPLE</span></p>' : ''}
      <p class="eyebrow">${esc(String(p.kind || 'EPA-regulated facility').toUpperCase())}</p>
      <h2 class="card-title">${esc(p.name)}</h2>
      <div class="stats">
        <div class="stat"><span class="k">Quarters out of compliance</span><span class="v ${p.qtrs_noncompliance >= 4 ? 'hot' : ''}">${p.qtrs_noncompliance ?? '—'}<span class="muted-s"> / 12</span></span><span class="s">last 3 years</span></div>
        <div class="stat"><span class="k">Penalties on record</span><span class="v">${p.penalties != null ? usd(p.penalties) : '—'}</span><span class="s">EPA programs</span></div>
      </div>
      <p class="src">SOURCE: ${p.source_url ? `<a href="${esc(p.source_url)}" target="_blank" rel="noopener">EPA ECHO facility report</a>` : 'EPA ECHO'} · pulled ${esc(p.as_of)}</p>
      <p class="src pro">IDS: FRS ${esc(ids.frs)}</p>`);
  }

  $('detail').addEventListener('click', (e) => {
    const fam = e.target.closest('[data-fam]');
    if (fam) return showFamily(fam.dataset.fam);
    const mine = e.target.closest('[data-mine]');
    if (mine && mineById[mine.dataset.mine]) {
      const f = mineById[mine.dataset.mine];
      map.flyTo({ center: f.geometry.coordinates, zoom: 13 });
      showMine(f.properties);
    }
  });

  // Search: mines and controllers in our data first, then addresses (Nominatim, light use only).
  $('search').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('q').value.trim().toLowerCase(); if (!q) return;
    const mines = Object.values(mineById).filter((f) => (f.properties.name || '').toLowerCase().includes(q)).slice(0, 8);
    const fams = Object.values(families).filter((f) => (f.controller || '').toLowerCase().includes(q))
      .sort((a, b) => (b.mines || []).length - (a.mines || []).length).slice(0, 8);
    if (mines.length || fams.length) {
      show(`<p class="eyebrow">RESULTS FOR “${esc($('q').value.trim())}”</p>
        ${fams.length ? `<details open><summary>Controllers (${fams.length})</summary><ul class="mines-list">${fams.map((f) =>
          `<li><button type="button" data-fam="${esc(f.controller_id)}"><span>${esc(f.controller)}</span><span class="count">${num((f.mines || []).length)} mines</span></button></li>`).join('')}</ul></details>` : ''}
        ${mines.length ? `<details open><summary>Mines (${mines.length})</summary><ul class="mines-list">${mines.map((f) =>
          `<li><button type="button" data-mine="${esc(f.properties.ids.msha_mine)}"><span>${esc(f.properties.name)}</span><span class="count">${esc(f.properties.status || '')}</span></button></li>`).join('')}</ul></details>` : ''}`);
      return;
    }
    try {
      const r = await getJSON('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent($('q').value.trim()));
      if (!r.length) { show(intro + '<p class="flag">No mine, company or address matched that.</p>'); return; }
      map.flyTo({ center: [+r[0].lon, +r[0].lat], zoom: 13 });
    } catch (err) { show(intro + '<p class="flag">Address search is unavailable right now.</p>'); }
  });

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
