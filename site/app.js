// The People's Case: Curtain Puller map.
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
    { id: 'ej', name: 'Open EJ Score (by neighborhood)', tag: 'Open formula', on: false, poly: true },
    { id: 'kypermits', name: 'Kentucky mine permit areas', tag: 'KY DMP', on: false, poly: true },
    { id: 'mines', name: 'Mines + who controls them', tag: 'MSHA', on: true },
    { id: 'facilities', name: 'EPA-regulated facilities', tag: 'ECHO', on: true },
    { id: 'water', name: 'Drinking water systems', tag: 'SDWIS', on: true },
    { id: 'tri', name: 'Toxic release reporters', tag: 'TRI', on: true },
  ];

  const map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        base: {
          type: 'raster', tileSize: 256, maxzoom: 16,
          // Esri World Dark Gray Canvas: no key needed, attribution required, light use only. Swap for self-hosted PMTiles before launch.
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
          attribution: 'Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors',
        },
        labels: {
          type: 'raster', tileSize: 256, maxzoom: 16,
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'],
        },
      },
      layers: [{ id: 'base', type: 'raster', source: 'base' }, { id: 'labels', type: 'raster', source: 'labels' }],
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
  let facFeatures = [], triFeatures = [];
  const water = {};       // area id -> {label, systems}
  const letters = {};     // key -> letter spec
  let money = null;       // money.json: USAspending / FEC / CourtListener by normalized name
  let parents = null;     // parents.json: GLEIF legal-entity records by normalized name
  let registry = null;    // registry.json: Kentucky Secretary of State records by normalized name
  let pendingData = null; // comments.json: permit actions pending with the state (public-comment alerts)
  let archiveIdx = null;  // archive.json: today's archived originals with SHA-256 (for evidence packs)
  let sec = null;         // sec.json: hand-run SEC Exhibit 21 / 95 results (collector/sec_local.py)
  let klec = null;        // klec.json: Kentucky employer lobbying lines by normalized name
  let ejData = null;      // ej.geojson: block groups with percentiles; the score is computed here from the user's weights
  const intro = $('detailBody').innerHTML;

  async function loadData() {
    const byLayer = {};
    try {
      const idx = await getJSON('data/index.json');
      meta = { sample: false, pulled: idx.pulled };
      for (const [k, f] of Object.entries(idx.layers)) byLayer[k] = await getJSON('data/' + f);
      try { for (const f of await getJSON('data/families.json')) families[f.controller_id] = f; } catch (e) {}
      try { for (const w of await getJSON('data/water.json')) water[w.area] = w; } catch (e) {}
      try { money = await getJSON('data/money.json'); } catch (e) {}
      try { parents = await getJSON('data/parents.json'); } catch (e) {}
      try { registry = await getJSON('data/registry.json'); } catch (e) {}
      try { pendingData = await getJSON('data/comments.json'); } catch (e) {}
      try { archiveIdx = await getJSON('data/archive.json'); } catch (e) {}
      try { klec = await getJSON('data/klec.json'); } catch (e) {}
      try { sec = await getJSON('data/sec.json'); } catch (e) {}
    } catch (e) {
      const s = await getJSON('data/sample.geojson');
      for (const L of LAYERS) byLayer[L.id] = { type: 'FeatureCollection', features: s.features.filter((f) => f.properties.layer === L.id) };
    }
    $('fresh').innerHTML = meta.sample ? '<span class="sample">SAMPLE DATA</span>' : 'DATA PULLED ' + esc(meta.pulled) + ' · ARCHIVED';
    for (const f of (byLayer.mines || { features: [] }).features) mineById[f.properties.ids?.msha_mine] = f;
    facFeatures = (byLayer.facilities || { features: [] }).features;
    triFeatures = (byLayer.tri || { features: [] }).features;

    for (const L of LAYERS) {
      const data = byLayer[L.id] || { type: 'FeatureCollection', features: [] };
      L.count = data.features.length;
      if (!L.count) L.on = false;
      map.addSource(L.id, { type: 'geojson', data });
      const isMine = L.id === 'mines';
      if (L.id === 'ej') {
        ejData = data; ejScore();
        map.addLayer({ id: 'ej', type: 'fill', source: 'ej', layout: { visibility: L.on ? 'visible' : 'none' },
          paint: { 'fill-color': ['case', ['==', ['get', 'score'], null], '#14181E', ['step', ['get', 'score'], '#1E2630', 20, '#33505E', 40, '#7E8A6A', 60, '#D9963F', 80, '#EE7D67']], 'fill-opacity': 0.55 } });
        map.addLayer({ id: 'ej-line', type: 'line', source: 'ej', layout: { visibility: L.on ? 'visible' : 'none' }, paint: { 'line-color': '#0A0C0F', 'line-width': 0.7, 'line-opacity': 0.8 } });
        map.on('click', 'ej', (e) => { if (map.queryRenderedFeatures(e.point).some((f) => f.layer.type === 'circle')) return; showEJ(e.features[0].properties.geoid); });
        continue;
      }
      if (L.poly) {
        map.addLayer({ id: L.id, type: 'fill', source: L.id, layout: { visibility: L.on ? 'visible' : 'none' },
          paint: { 'fill-color': ['case', ['==', ['get', 'flag'], 'ACT'], '#E3A44E', '#86B6CC'], 'fill-opacity': 0.08 } });
        map.addLayer({ id: L.id + '-line', type: 'line', source: L.id, layout: { visibility: L.on ? 'visible' : 'none' },
          paint: { 'line-color': ['case', ['==', ['get', 'flag'], 'ACT'], '#E3A44E', '#5E7F8F'], 'line-width': 0.8, 'line-opacity': 0.7 } });
        map.on('click', L.id, (e) => { if (map.queryRenderedFeatures(e.point).some((f) => f.layer.type === 'circle')) return; showPermit(e.features[0].properties); });
        continue;
      }
      map.addLayer({
        id: L.id, type: 'circle', source: L.id,
        ...(L.id === 'facilities' ? { filter: ['!', ['has', 'mine_link']] } : {}), // linked facilities show on their mine's card
        layout: { visibility: L.on ? 'visible' : 'none', 'circle-sort-key': isMine ? ['coalesce', ['get', 'citations'], 0] : 0 },
        paint: {
          'circle-color': isMine
            ? ['case', ['==', ['get', 'status'], 'Active'], '#E3A44E', '#5A6270']
            : L.id === 'facilities' ? ['match', ['coalesce', ['get', 'flag_level'], 0], 2, '#EE7D67', 1, '#A87A70', '#86B6CC']
            : L.id === 'tri' ? '#C39BD3' : '#4FC3D3',
          'circle-radius': isMine
            ? ['interpolate', ['linear'], ['sqrt', ['coalesce', ['get', 'citations'], 0]], 0, 4, 10, 9, 40, 18]
            : L.id === 'facilities' ? ['interpolate', ['linear'], ['coalesce', ['get', 'qtrs_noncompliance'], 0], 0, 4, 12, 10]
            : L.id === 'tri' ? 6 : 16,
          'circle-opacity': 0.9,
          'circle-stroke-color': isMine ? ['case', ['==', ['get', 'epa_flagged'], true], '#EE7D67', ['==', ['get', 'has_epa'], true], '#86B6CC', '#0A0C0F'] : '#0A0C0F',
          'circle-stroke-width': isMine ? ['case', ['==', ['get', 'has_epa'], true], 2.5, 1.2] : 1.2,
        },
      });
      map.on('click', L.id, (e) => {
        const p = e.features[0].properties;
        if (isMine) showMine(p); else if (L.id === 'facilities') showFacility(p, e.features[0].geometry.coordinates);
        else if (L.id === 'tri') showTri(p); else showWater(p.area);
      });
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
    $('layerList').insertAdjacentHTML('beforeend', `<label class="flagonly"><input type="checkbox" id="flagOnly">Only high-priority silence flags</label>`);
    $('flagOnly').addEventListener('change', (e) => {
      const on = e.target.checked;
      if (map.getLayer('facilities')) map.setFilter('facilities', on ? ['all', ['!', ['has', 'mine_link']], ['==', ['coalesce', ['get', 'flag_level'], 0], 2]] : ['!', ['has', 'mine_link']]);
      if (map.getLayer('mines')) map.setFilter('mines', on ? ['==', ['get', 'epa_flagged'], true] : null);
    });
    $('layerList').addEventListener('change', (e) => {
      const id = e.target.dataset.l; if (!id) return;
      map.setLayoutProperty(id, 'visibility', e.target.checked ? 'visible' : 'none');
      if (id === 'ej' && e.target.checked) showEJPanel();
      if (map.getLayer(id + '-line')) map.setLayoutProperty(id + '-line', 'visibility', e.target.checked ? 'visible' : 'none');
    });
  }

  // ---- Right of reply + corrections (static JSON in site/records/, edited by hand from GitHub issues) ----
  const REPO = 'https://github.com/BuildBeyond1889/peoples-case-file';
  let replyLog = { items: [] }, corrLog = { items: [] };
  const recLoaded = Promise.all([
    getJSON('records/replies.json').then((d) => (replyLog = d)).catch(() => {}),
    getJSON('records/corrections.json').then((d) => (corrLog = d)).catch(() => {}),
  ]);
  const recKey = (kind, id) => `${kind}:${id}`;
  function issueUrl(tpl, kind, id, name) {
    const q = new URLSearchParams({ template: tpl + '.yml', title: (tpl === 'reply' ? 'Reply: ' : 'Correction: ') + (name || recKey(kind, id)), record: recKey(kind, id), page: location.href });
    return `${REPO}/issues/new?${q}`;
  }
  // Replies and corrections for one record, plus the two links. Safe to call before the logs load (they're tiny and load first).
  function recordActions(kind, id, name) {
    if (!id) return '';
    const k = recKey(kind, id);
    const reps = (replyLog.items || []).filter((r) => r.record && recKey(r.record.kind, r.record.id) === k);
    const cors = (corrLog.items || []).filter((r) => r.record && recKey(r.record.kind, r.record.id) === k);
    return `<div class="recact">
      ${reps.map((r) => `<div class="reply"><p class="eyebrow">RESPONSE FROM ${esc((r.from || '').toUpperCase())}${r.role ? ' · ' + esc(r.role.toUpperCase()) : ''} · ${esc(r.date || '')}</p><p class="rtext">${esc(r.text || '')}</p><p class="muted-s">Published as submitted${r.verified ? ' · sender confirmed by ' + esc(r.verified) : ''}${r.issue ? ` · <a href="${esc(r.issue)}" target="_blank" rel="noopener">original</a>` : ''}</p></div>`).join('')}
      ${cors.map((c) => `<div class="corr"><p class="eyebrow">CORRECTED ${esc(c.date || '')}</p><p class="muted-s">Was: ${esc(c.was || '')}<br>Now: ${esc(c.now || '')}${c.why ? '<br>Why: ' + esc(c.why) : ''}</p></div>`).join('')}
      <p class="recl"><a href="${esc(issueUrl('correction', kind, id, name))}" target="_blank" rel="noopener">Something wrong? Request a correction</a><a href="${esc(issueUrl('reply', kind, id, name))}" target="_blank" rel="noopener">Named here? Publish a reply</a></p>
    </div>`;
  }

  // ---- Spot check: a random sample of records, our numbers next to the agency's own page ----
  function seeded(seed) { let x = 0; for (const c of String(seed)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
  function pickN(arr, n, rnd) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); }
  const CHK_KEY = 'pcf.check';
  let chk = (() => { try { return JSON.parse(localStorage.getItem(CHK_KEY)) || {}; } catch (e) { return {}; } })();
  const chkSave = () => { try { localStorage.setItem(CHK_KEY, JSON.stringify(chk)); } catch (e) {} };
  function copyBtn(v) { return `<button type="button" class="linkbtn" data-copy="${esc(v)}">copy ID</button>`; }

  function checkItems() {
    const rnd = seeded('pcf-check-' + (chk.round || 1));
    const items = [];
    const mines = Object.values(mineById);
    const active = mines.filter((f) => f.properties.status === 'Active');
    // MSHA's website search can't find abandoned mines, so sample the ones a person can actually check there.
    const findable = mines.filter((f) => !/abandon/i.test(f.properties.status || '') && (f.properties.citations || 0) > 0);
    for (const f of [...pickN(active, 3, rnd), ...pickN(findable.filter((f) => f.properties.status !== 'Active'), 5, rnd)]) {
      const p = f.properties, ids = parse(p.ids, {}), v = parse(p.viol, {}) || {};
      items.push({ key: 'mine:' + ids.msha_mine, kind: 'mine', name: p.name, id: ids.msha_mine, idLabel: 'MSHA mine ID',
        src: MSHA_LOOKUP, srcName: 'MSHA Mine Data Retrieval System', how: 'On MSHA’s page set the search type to “Mine ID”, paste the ID, press Search, then click the mine in the results. The Mine ID at the top must match before you compare. Citations are under “Violations”.',
        rows: [['Status', mineStatus(p.status) || '—'], ['Operator now', p.operator || '—'], ['Controller now', p.parent || '—'],
          ['Citations, all owners', num(v.total || 0) + ' (we leave out contractor and vacated citations, and MSHA’s live report can include a few citations missing from its downloadable data, so MSHA’s count can be a bit higher)'], ['Penalties assessed', usd(v.due || 0)], ['Paid', usd(v.paid || 0)]] });
    }
    const hi = facFeatures.filter((f) => f.properties.flag_level === 2), rest = facFeatures.filter((f) => f.properties.flag_level !== 2 && f.properties.source_url);
    for (const f of [...pickN(hi, 4, rnd), ...pickN(rest, 4, rnd)]) {
      const p = f.properties, ids = parse(p.ids, {}), flags = parse(p.flags, []);
      items.push({ key: 'facility:' + ids.frs, kind: 'facility', name: p.name, id: ids.frs, idLabel: 'EPA registry ID',
        src: p.source_url || 'https://echo.epa.gov/facilities/facility-search', srcName: 'EPA ECHO facility report', how: 'Check the summary at the top and the 3-year compliance table.',
        rows: [['Quarters out of compliance (last 12)', p.qtrs_noncompliance == null ? '—' : num(p.qtrs_noncompliance)], ['Penalties on record (5 yrs)', p.penalties == null ? '—' : usd(p.penalties)],
          ['Last inspection', p.last_inspection || 'none on record'], ['Our flags', flags.length ? flags.map((x) => x.label).join('; ') : 'none']] });
    }
    for (const f of pickN(triFeatures.filter((f) => parse(f.properties.releases, null)), 3, rnd)) {
      const p = f.properties, r = parse(p.releases, {}), t = parse(p.tri, {});
      items.push({ key: 'tri:' + (parse(p.ids, {}).tri || ''), kind: 'tri', name: p.name, id: parse(p.ids, {}).tri, idLabel: 'TRI ID',
        src: r.source_url || p.source_url, srcName: 'EPA TRI facility profile', how: 'Find the same year in the release table.',
        rows: [['Year', r.latest_year], ['Total released', num(r.latest_total) + ' lbs'], ['Parent company reported', t.parent || 'none']] });
    }
    const sys = Object.values(water).flatMap((w) => (w.systems || []).map((x) => ({ ...x, area: w.label })));
    for (const x of pickN(sys, 4, rnd)) {
      items.push({ key: 'water:' + x.pwsid, kind: 'water', name: x.name, id: x.pwsid, idLabel: 'Water system ID (PWSID)',
        src: 'https://sdwis.epa.gov/ords/sfdw_pub/r/sfdw/sdwis_fed_reports_public/200', srcName: 'EPA drinking water reports (SDWIS)', how: 'Search the water system ID, then open its violations.',
        rows: [['Area', x.area], ['People served', x.population ? num(x.population) : '—'], ['Health-based violations (5 yrs)', num(x.health_last5 || 0)], ['Violations on record', num(x.violations || 0)]] });
    }
    return items.filter((i) => i.id);
  }

  function renderCheck() {
    const el = $('checkPage');
    if (meta.sample) { el.innerHTML = '<div class="fp-wrap prose"><h1 class="serif">Spot check</h1><p>The live data hasn’t loaded, so there’s nothing to check yet.</p></div>'; return; }
    const items = checkItems(); const res = chk.res || (chk.res = {});
    const done = items.filter((i) => res[i.key]), bad = done.filter((i) => res[i.key].v === 'no');
    el.innerHTML = `<div class="fp-wrap prose wide">
      <div class="fp-crumb"><a href="#">Home</a> / <span>Spot check</span></div>
      <header><p class="eyebrow">QUALITY CONTROL · ROUND ${num(chk.round || 1)}</p><h1 class="serif">Spot check</h1>
      <p class="lede2">${num(items.length)} records picked at random. For each one: open the agency’s own page, compare, and mark it. Takes about 2 minutes a record.</p></header>
      <div class="chkbar"><span><b>${num(done.length)}</b> of ${num(items.length)} checked · <b class="${bad.length ? 'hot' : ''}">${num(bad.length)}</b> don’t match</span>
        <span class="btns"><button type="button" class="btn" id="chkCopy">Copy results</button><button type="button" class="btn" id="chkNew">New sample</button></span></div>
      <p class="muted-s">What counts as a match: same name, same IDs, same numbers. Small timing gaps are fine (the agency may have updated since we pulled on ${esc(meta.pulled)}). Your marks stay in this browser.</p>
      ${['mine', 'facility', 'tri', 'water'].map((k) => {
        const group = items.filter((i) => i.kind === k); if (!group.length) return '';
        const title = { mine: 'Mines (MSHA)', facility: 'EPA-regulated sites (half are high-priority flags)', tri: 'Toxic release reporters (TRI)', water: 'Drinking water systems' }[k];
        return `<article><h2>${title}</h2>${group.map((i) => { const r = res[i.key] || {};
          return `<div class="chk ${r.v ? 'is-' + r.v : ''}" data-ck="${esc(i.key)}">
            <div class="chk-h"><b>${esc(i.name)}</b><span class="muted-s">${esc(i.idLabel)} ${esc(i.id)} ${copyBtn(i.id)}</span></div>
            <dl class="chk-rows">${i.rows.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}</dl>
            <p class="muted-s"><a href="${esc(i.src)}" target="_blank" rel="noopener">Open ${esc(i.srcName)} ↗</a> · ${esc(i.how)}</p>
            <p class="muted-s">First check the agency page shows <b>${esc(i.idLabel)} ${esc(i.id)}</b>. If it shows a different ID, you’re on the wrong record. Search again; it isn’t a mismatch.</p>
            <div class="chk-btns" role="group" aria-label="Result">
              <button type="button" data-cv="yes" aria-pressed="${r.v === 'yes'}">Matches</button>
              <button type="button" data-cv="no" aria-pressed="${r.v === 'no'}">Doesn’t match</button>
              <button type="button" data-cv="unsure" aria-pressed="${r.v === 'unsure'}">Can’t tell</button>
            </div>
            ${r.v === 'no' || r.v === 'unsure' ? `<label class="chk-note">What’s different?<textarea rows="2" data-cnote>${esc(r.note || '')}</textarea></label>
              ${r.v === 'no' ? `<p><a href="${esc(issueUrl('correction', i.kind, i.id, i.name))}" target="_blank" rel="noopener">Report it as a correction ↗</a></p>` : ''}` : ''}
          </div>`; }).join('')}</article>`; }).join('')}
    </div>`;
    el.onclick = async (e) => {
      const cp = e.target.closest('[data-copy]');
      if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); cp.textContent = 'copied'; } catch (err) {} return; }
      const b = e.target.closest('[data-cv]');
      if (b) { const k = b.closest('[data-ck]').dataset.ck; res[k] = { ...(res[k] || {}), v: b.dataset.cv, at: new Date().toISOString().slice(0, 10) }; chkSave(); renderCheck(); return; }
      if (e.target.id === 'chkNew') { chk = { round: (chk.round || 1) + 1, res: {} }; chkSave(); renderCheck(); window.scrollTo(0, 0); return; }
      if (e.target.id === 'chkCopy') {
        const txt = `Spot check round ${chk.round || 1}, data pulled ${meta.pulled}\n` + items.map((i) => { const r = res[i.key] || {};
          return `${(r.v || 'not checked').toUpperCase()} · ${i.kind} ${i.id} · ${i.name}${r.note ? ' · ' + r.note : ''}`; }).join('\n');
        try { await navigator.clipboard.writeText(txt); e.target.textContent = 'Copied: paste it to Claude'; } catch (err) { e.target.textContent = 'Copy failed'; }
      }
    };
    el.oninput = (e) => { const t = e.target.closest('[data-cnote]'); if (!t) return; const k = t.closest('[data-ck]').dataset.ck; res[k] = { ...(res[k] || {}), note: t.value }; chkSave(); };
  }

  function renderCorrections() {
    const el = $('corrPage'); const all = [
      ...(corrLog.items || []).map((x) => ({ ...x, t: 'c' })),
      ...(replyLog.items || []).map((x) => ({ ...x, t: 'r' })),
    ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    el.innerHTML = `<div class="fp-wrap prose">
      <div class="fp-crumb"><a href="#">Home</a> / <span>Corrections and replies</span></div>
      <header><p class="eyebrow">ACCOUNTABILITY GOES BOTH WAYS</p><h1 class="serif">Corrections and replies</h1>
      <p class="lede2">Every fix we make is listed here, permanently. Companies, agencies and officials named on this site can publish a reply next to their record.</p></header>
      <div class="btns"><a class="btn primary" href="${REPO}/issues/new?template=correction.yml" target="_blank" rel="noopener">Request a correction</a><a class="btn" href="${REPO}/issues/new?template=reply.yml" target="_blank" rel="noopener">Publish a reply</a><a class="btn" href="#how">How this works</a></div>
      <article><h2>How it works</h2><ul>
        <li><b>Corrections:</b> anyone can point out a mistake. We check it against the public record. If it holds up, we fix it and list it here: what it said, what it says now, and why.</li>
        <li><b>Replies:</b> if your organization is named, your statement appears next to the record, as written, with the date. We only remove personal details and abuse, and we confirm the sender first.</li>
        <li><b>Nothing is deleted from this log.</b></li>
        <li>Both forms are on GitHub (a free account is needed). Each record on the site has its own links, which fill in the record for you.</li>
      </ul></article>
      <article><h2>Log</h2>${all.length ? `<ul class="corrlog">${all.map((x) => `<li><span class="when">${esc(x.date || '')} · ${x.t === 'c' ? 'CORRECTION' : 'REPLY FROM ' + esc((x.from || '').toUpperCase())}</span><b>${esc(x.record?.name || recKey(x.record?.kind, x.record?.id))}</b>${x.t === 'c' ? `<span>Was: ${esc(x.was || '')}</span><span>Now: ${esc(x.now || '')}</span>${x.why ? `<span class="muted-s">Why: ${esc(x.why)}</span>` : ''}` : `<span>${esc(x.text || '')}</span>`}${x.issue ? `<a href="${esc(x.issue)}" target="_blank" rel="noopener">Original request</a>` : ''}</li>`).join('')}</ul>` : '<p class="muted-s">No corrections or replies yet. This log starts with the public launch.</p>'}</article>
    </div>`;
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
        <div class="stat"><span class="k">Penalties assessed</span><span class="v">${usd(v.due)}</span><span class="s ${paidPct !== null && paidPct < 50 ? 'hot' : ''}">${paidPct === null ? '—' : paidPct + '% paid (' + usd(v.paid) + ')'}</span></div>
      </div>
      <p class="note">“Assessed” is the current penalty amount MSHA has set. Unpaid amounts can include penalties still being contested or not yet final. Citations not assessed yet count as $0.</p>
      <p class="note pro">Proposed at issue: ${usd(v.proposed)} · vacated citations left out: ${num(v.vacated)}${v.contractor != null ? ' · cited to contractors (not counted): ' + num(v.contractor) : ''}</p>`;
  }

  function flagsHtml(flags, where, severity, letterKey) {
    if (!flags || !flags.length) return '';
    return `<div class="silence"><p class="eyebrow" style="color:var(--coral)">SILENCE DETECTOR${severity ? ' · ' + esc(severity.toUpperCase()) + ' PRIORITY' : ''}${where ? ' · ' + esc(where) : ''}</p><ul>${flags.map((f) =>
      `<li><b>${esc(f.label)}</b><span class="when">${esc(f.evidence)}</span></li>`).join('')}</ul>
      <p class="note">A question worth asking the agency, not a finding of wrongdoing. Check the EPA report.</p>
      ${letterKey ? `<div class="btns"><button type="button" class="btn primary" data-letter="${esc(letterKey)}">Draft a records request →</button></div>` : ''}</div>`;
  }

  // MSHA's downloadable data says "NonProducing" where its website says "NonProdActive": a mine that is open but not producing.
  const MINE_STATUS = { NonProducing: 'Non-producing (open, not producing coal)', NonProdActive: 'Non-producing (open, not producing coal)', TempIdled: 'Temporarily idled', 'Temporarily Idled': 'Temporarily idled' };
  const mineStatus = (st) => MINE_STATUS[st] || st || '';
  function kindLabel(k, dflt) {
    const parts = String(k || '').split(/,\s*(?=\d{3,6}:)/).map((x) => x.replace(/^\d{3,6}:\s*/, '').trim()).filter(Boolean);
    if (!parts.length) return dflt;
    return parts[0] + (parts.length > 1 ? ' + ' + (parts.length - 1) + ' more' : '');
  }

  // Individuals listed as MSHA controllers: lead with the company, show the person only as "listed controller".
  function leadCompany(names) {
    const ns = (names || []).filter(Boolean);
    return ns.length ? ns[0] + (ns.length > 1 ? ' + ' + (ns.length - 1) + ' more' : '') : 'Unnamed operating company';
  }
  function listedControllerNote(name) {
    return `<p class="muted-s">Listed controller in MSHA records: ${esc(name)} (individual). Shown only as named in those records, in that role.</p>`;
  }

  // MSHA types many older individual controllers as "COMPANY" (e.g. "Karst Edward W"). Treat a controller as a person
  // when MSHA says so OR the name has no company word, so individuals are never headlined as if they were companies.
  const CO_WORDS = /\b(inc|llc|l\.l\.c|co|corp|corporation|company|companies|ltd|limited|lp|llp|plc|holdings?|group|energy|coal|mining|minerals?|resources?|trust|partners|partnership|fuels?|industries|enterprises?|associates|development|properties|land|bank|capital|investments?|ventures?|international|america|usa|services|contracting|construction|trucking|natural|power|steel|materials|global|commodities|operations)\b/i;
  const isPersonCtl = (name, type) => (type || '').toUpperCase().startsWith('P') || !CO_WORDS.test(name || '');

  function personLabel(name, type) {
    return isPersonCtl(name, type) ? `${esc(name)} <span class="muted-s">(individual, as named in MSHA records)</span>` : esc(name);
  }

  function showMine(p) {
    const ids = parse(p.ids, {});
    const hist = parse(p.history, []);
    const flags = parse(p.flags, []);
    const v = parse(p.viol, null);
    const fam = families[ids.msha_controller];
    const epa = parse(p.epa, []);
    const epaHtml = epa.length ? `<details open><summary>EPA records at this site (${epa.length})</summary><ol class="hist">${epa.map((e) =>
      `<li><b>${esc(e.name)}</b> <span class="muted-s">${esc(e.kind || '')}</span>` +
      `<br>${e.qtrs_noncompliance != null ? `<span class="${e.qtrs_noncompliance >= 4 ? 'hot' : ''}">${esc(e.qtrs_noncompliance)} of last 12 quarters out of compliance</span>` : 'Compliance: not reported'}${e.penalties ? ' · penalties ' + usd(e.penalties) : ''}` +
      (e.permits && e.permits.length ? e.permits.map((pm) => `<span class="when">Water permit ${esc(pm.id)}: <span class="${pm.status_code === 'EXP' ? 'hot' : ''}">${esc(pm.status)}</span>${pm.expiration ? ' · expires/expired ' + esc(pm.expiration) : ''}${pm.effluent_qtrs ? ' · discharge limits exceeded ' + esc(pm.effluent_qtrs) + ' of 12 quarters' : ''}</span>` +
        (pm.exceed?.exceedances ? `<span class="when hot">Over its limits ${num(pm.exceed.exceedances)}× in 3 yrs · worst: ${esc(pm.exceed.parameters[0]?.name || '')} ${pct(Math.max(...pm.exceed.parameters.map((x) => x.max_pct)))} over</span>` : '') +
        (pm.informal?.last5 >= 3 && !pm.formal?.last5 ? `<span class="when hot">${num(pm.informal.last5)} warning letters in 5 yrs, no formal action</span>` : '')).join('') : '') +
      (e.tri && e.tri.parent ? `<span class="when">Parent company reported to EPA (TRI): ${esc(e.tri.parent)}</span>` : '') +
      (e.flags && e.flags.length ? `<span class="when" style="color:var(--coral)">⚑ ${e.severity ? esc(e.severity.toUpperCase()) + ' PRIORITY · ' : ''}${e.flags.map((f) => esc(f.label)).join(' · ')}</span>` +
        `<span class="when"><button type="button" class="linkbtn" data-letter="${esc(regFacilityLetter(e, ids))}">Draft a records request about this permit →</button></span>` : '') +
      `<span class="when">${e.confidence === 'high' ? 'Same site (high confidence, state permit record)' : 'Possibly the same site (' + esc(e.confidence) + ' confidence, inferred)'}: ${esc((e.basis || []).join(' · '))}</span>` +
      (e.source_url ? `<span class="when"><a href="${esc(e.source_url)}" target="_blank" rel="noopener">EPA ECHO report</a>${e.frs ? ' <span class="pro">· FRS ' + esc(e.frs) + '</span>' : ''}</span>` : '') +
      `</li>`).join('')}</ol><p class="note">MSHA and EPA don’t share an ID number, so these matches come from location plus coal-mining permit codes or shared names. Check the EPA report before relying on one.</p></details>` : '';
    const stints = [];
    for (const h of hist) {
      let st = stints.find((x) => x.operator === h.operator && x.op_start === h.op_start);
      if (!st) stints.push(st = { operator: h.operator, op_start: h.op_start, op_end: h.op_end, ctls: [] });
      if (!h.controller) continue;
      const s0 = [h.op_start, h.ctl_start].filter(Boolean).sort().pop() || '';
      const e0 = [h.op_end, h.ctl_end].filter(Boolean).sort()[0] || '';
      if (s0 && e0 && s0 > e0) continue;   // this controller's control of the operator fell outside its time at this mine
      st.ctls.push({ name: h.controller, type: h.controller_type, s0, e0 });
    }
    const histHtml = stints.length ? `<details ${stints.length <= 4 ? 'open' : ''}><summary>Who ran it, who controlled it (${stints.length})</summary><ol class="hist">${stints.slice().reverse().map((h) =>
      `<li><b>${esc(h.operator || 'Not named in MSHA records')}</b> <span class="muted-s">operator</span>` +
      h.ctls.map((c) => `<br><span class="muted-s">controlled by</span> ${personLabel(c.name, c.type)}${h.ctls.length > 1 ? ` <span class="muted-s">(${esc(c.s0 || '?')} → ${esc(c.e0 || 'now')})</span>` : ''}`).join('') +
      `<span class="when">${esc(h.op_start || '?')} → ${esc(h.op_end || 'now')}</span></li>`).join('')}</ol></details>` : '';
    show(`
      ${meta.sample ? '<p><span class="sample">SAMPLE</span></p>' : ''}
      <p class="eyebrow">${esc(String(p.kind || 'Mine').replace(p.status || '\u0000', mineStatus(p.status)).toUpperCase())}</p>
      <h2 class="card-title">${esc(p.name)}</h2>
      ${violStats(v, 'at this mine')}
      ${fairHtml(parse(p.fair, null))}
      ${p.operator ? `<div class="row"><span class="lbl">Operator now</span><span>${esc(p.operator)}</span></div>` : ''}
      ${p.parent ? `<div class="row"><span class="lbl">Controller now</span><span>${esc(p.parent)}</span></div>` : ''}
      ${fam ? `<div class="btns"><button type="button" class="btn primary" data-fam="${esc(fam.controller_id)}">Pull the curtain on this controller →</button></div>` : ''}
      ${epaHtml}
      ${histHtml}
      ${kyPermitsHtml(parse(p.ky_permits, []))}
      ${pendingCardHtml(p)}
      <div class="btns"><button type="button" class="btn" data-letter="${esc(regMineLetter(p, ids, v))}">Request this mine’s MSHA records →</button>${parse(p.ky_permits, []).length ? `<button type="button" class="btn" data-letter="${esc(regBondLetter(p, ids))}">Ask for its cleanup bonds →</button>` : ''}${packBtn('mine', p, p.name + ' (MSHA mine ' + ids.msha_mine + ')')}</div>
      ${(sec?.by_mine?.[ids.msha_mine] || []).length ? `<div class="pendbox"><p class="eyebrow">LISTED BY PUBLIC COMPANIES (SEC EXHIBIT 95, BY MINE ID)</p><ol class="hist">${sec.by_mine[ids.msha_mine].map((h) => `<li><b>${esc(h.company)}</b><span class="when">${esc(h.form || '')} filed ${esc(h.filed || '')} · <a href="${esc(h.url)}" target="_blank" rel="noopener">mine safety disclosure</a></span></li>`).join('')}</ol><p class="note">Official-ID match: the filing lists this MSHA mine ID. Checked ${esc(sec.as_of)}.</p></div>` : ''}
      <p class="note">Owned by a public company? Its annual report lists the mine by ID (Exhibit 95): <a href="https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(`"${ids.msha_mine}" OR "${String(ids.msha_mine).slice(0, 2)}-${String(ids.msha_mine).slice(2)}"`)}" target="_blank" rel="noopener">search SEC filings for ${esc(ids.msha_mine)}</a>.</p>
      ${flags.length ? `<p class="flag">Data note: ${flags.map(esc).join('; ')}</p>` : ''}
      <p class="src">SOURCE: <a href="${MSHA_LOOKUP}" target="_blank" rel="noopener">MSHA Mine Data Retrieval</a> · search mine ID ${esc(ids.msha_mine)} · pulled ${esc(p.as_of)}</p>
      ${recordActions('mine', ids.msha_mine, p.name)}
      <p class="src pro">IDS: MSHA mine ${esc(ids.msha_mine)}${ids.msha_controller ? ' · controller ' + esc(ids.msha_controller) : ''}</p>`);
  }

  function showFamily(cid) {
    const f = families[cid]; if (!f) return;
    const v = f.viol;
    const mines = (f.mines || []).map((m) => ({ ...m, feat: mineById[m.id] }))
      .sort((a, b) => (b.feat?.properties.citations || 0) - (a.feat?.properties.citations || 0));
    show(`
      ${isPersonCtl(f.controller, f.controller_type)
        ? `<p class="eyebrow">MINE FAMILY · MSHA CONTROLLER ${esc(f.controller_id)}</p><h2 class="card-title">${esc(leadCompany((f.operators || []).map((o) => o.name)))}</h2>${listedControllerNote(f.controller)}`
        : `<p class="eyebrow">CONTROLLER · ${esc((f.controller_type || 'unknown').toUpperCase())} · MSHA ${esc(f.controller_id)}</p><h2 class="card-title">${personLabel(f.controller, f.controller_type)}</h2>`}
      <p class="muted-s">At Harlan County mines: ${num(mines.length)} mine${mines.length === 1 ? '' : 's'}, run through ${num((f.operators || []).length)} operating compan${(f.operators || []).length === 1 ? 'y' : 'ies'}.</p>
      ${violStats(v, 'under this controller')}
      <p class="note">Citations are counted under the controller MSHA recorded on the day each was issued.</p>
      <details open><summary>Operating companies (${num((f.operators || []).length)})</summary><ol class="hist">${(f.operators || []).map((o) => `<li>${esc(o.name || 'Unnamed')} <span class="when pro">MSHA operator ${esc(o.id)}</span></li>`).join('')}</ol></details>
      <details open><summary>Mines (${num(mines.length)})</summary><ul class="mines-list">${mines.map((m) =>
        `<li><button type="button" data-mine="${esc(m.id)}"><span>${esc(m.name || 'Mine ' + m.id)}</span><span class="count">${num(m.feat?.properties.citations || 0)} citations</span></button></li>`).join('')}</ul></details>
      <p class="flag">Not connected yet: parent companies above this controller, and the same company under other MSHA IDs. That’s the next layer of the Curtain Puller.</p>
      ${researchHtml(f.controller, f.controller_type)}
      <p class="src">SOURCE: MSHA Controller/Operator History + Violations · pulled ${esc(f.as_of)}</p>
      ${recordActions('family', f.controller_id, leadCompany((f.operators || []).map((o) => o.name)) + ' mine family')}`);
  }

  function showFacility(p, coords) {
    const ids = parse(p.ids, {});
    const permits = parse(p.permits, []);
    const triInfo = parse(p.tri, null);
    const flags = parse(p.flags, []);
    const link = parse(p.mine_link, null);
    const key = flags.length ? regFacilityLetter({ ...p, flags, permits, frs: ids.frs, coords }, null) : null;
    show(`
      ${meta.sample ? '<p><span class="sample">SAMPLE</span></p>' : ''}
      <p class="eyebrow">${esc(kindLabel(p.kind, 'EPA-regulated facility').toUpperCase())}</p>
      <h2 class="card-title">${esc(p.name)}</h2>
      <div class="stats">
        <div class="stat"><span class="k">Quarters out of compliance</span><span class="v ${p.qtrs_noncompliance >= 4 ? 'hot' : ''}">${p.qtrs_noncompliance ?? '—'}<span class="muted-s"> / 12</span></span><span class="s">last 3 years</span></div>
        <div class="stat"><span class="k">Penalties on record</span><span class="v">${p.penalties != null ? usd(p.penalties) : '—'}</span><span class="s">EPA programs</span></div>
      </div>
      ${flagsHtml(flags, '', p.severity, key)}
      ${pendingCardHtml(p)}
      ${permits.map(permitHtml).join('')}
      ${kyPermitsHtml(parse(p.ky_permits, []))}
      ${triInfo && triInfo.parent ? `<div class="row"><span class="lbl">Parent company (reported to EPA TRI)</span><span>${esc(triInfo.parent)}${triInfo.foreign_parent ? ' · foreign parent ' + esc(triInfo.foreign_parent) : ''}</span></div>` : ''}
      <div class="row"><span class="lbl">Last inspection, any EPA program</span><span>${esc(p.last_inspection || 'none on record')}</span></div>
      <div class="row"><span class="lbl">Formal enforcement, 5 yrs</span><span>${p.formal_actions_5y ?? '—'}</span></div>
      ${link ? `<div class="btns"><button type="button" class="btn" data-mine="${esc(link.mine_id)}">${link.confidence === 'high' ? 'Same Kentucky mine permit as' : 'Possibly the same site as'} mine: ${esc(link.mine)} →</button></div>` : ''}
      <div class="btns">${packBtn('facility', { ...p, ids }, p.name + (ids.frs ? ' (EPA FRS ' + ids.frs + ')' : ''))}</div>
      <p class="src">SOURCE: ${p.source_url ? `<a href="${esc(p.source_url)}" target="_blank" rel="noopener">EPA ECHO facility report</a>` : 'EPA ECHO'} · ICIS-NPDES permits, inspections and enforcement · ECHO effluent charts · pulled ${esc(p.as_of)}</p>
      ${recordActions('facility', ids.frs, p.name)}
      <p class="src pro">IDS: FRS ${esc(ids.frs)}${permits.length ? ' · NPDES ' + permits.map((x) => esc(x.id)).join(', ') : ''}${triInfo ? ' · TRI ' + esc(triInfo.tri_id) : ''}</p>`);
  }

  const pct = (v) => num(Math.round(v)) + '%';
  function factsFor(p) {
    const out = [];
    for (const f of parse(p.flags, [])) if (f && f.evidence) out.push(`${f.label}: ${f.evidence}`);
    for (const pm of parse(p.permits, [])) {
      const ex = pm.exceed;
      if (ex?.exceedances) out.push(`Permit ${pm.id} reported ${ex.exceedances} readings over its limits in the last 3 years; worst: ${ex.parameters.slice(0, 2).map((x) => `${x.name} ${pct(x.max_pct)} over`).join(', ')} (EPA ECHO discharge reports).`);
    }
    const v = parse(p.viol, null);
    if (v?.total) out.push(`MSHA records ${num(v.total)} safety citations at mine ${parse(p.ids, {}).msha_mine || ''}${v.last5 ? `, ${num(v.last5)} in the last 5 years` : ''}.`);
    for (const e of parse(p.epa, [])) for (const f of (e.flags || [])) out.push(`${e.name}: ${f.label} (${f.evidence})`);
    return [...new Set(out)].slice(0, 6).map((x) => `${p.name}: ${x}`);
  }
  function stageBadge(i) {
    return i.open ? `<span class="pbadge open">${esc(i.stage)} · comment window usually open</span>` : `<span class="pbadge">${esc(i.stage || 'pending')}</span>`;
  }
  function pendingRow(i, facts, ids) {
    return `<li class="prow"><div><b>${esc(i.name)}</b>${stageBadge(i)}<span class="when">${esc(i.program || '')}${i.type ? ' · ' + esc(i.type) : ''}${i.town ? ' · ' + esc(i.town) : ''}${i.stage_date ? ' · stage reached ' + esc(i.stage_date) : ''}${i.ends ? ' · comments due ' + esc(i.ends) : ''}</span></div>
      <div class="pacts"><a class="rlink" href="${esc(i.url)}" target="_blank" rel="noopener">Official record</a>${i.open ? `<button type="button" class="linkbtn" data-letter="${esc(commentLetter(i, facts, ids))}">Draft a comment →</button>` : ''}</div></li>`;
  }
  function pendingCardHtml(p) {
    const list = parse(p.pending, []);
    if (!list.length) return '';
    const facts = factsFor(p);
    return `<div class="pendbox"><p class="eyebrow">PENDING WITH THE STATE</p><ol class="hist">${list.map((i) => pendingRow(i, facts)).join('')}</ol>
      <p class="note">Tied through the Kentucky mine permit number in the state’s record.</p></div>`;
  }
  function renderHomePending() {
    const el = $('homePending'); if (!el) return;
    if (!pendingData) { el.innerHTML = '<p class="muted-s">Not collected yet.</p>'; return; }
    el.innerHTML = Object.entries(pendingData.areas || {}).map(([aid, a]) => {
      const items = a.items || [];
      const open = items.filter((i) => i.open);
      return `<div class="parea"><div class="parea-h"><b>${esc(a.label)}</b><span class="muted-s">${a.error ? 'Source not reachable this run' : `${num(items.length)} pending · ${num(open.length)} at a comment stage`}</span>${a.source ? `<a class="rlink" href="${esc(a.source.url)}" target="_blank" rel="noopener">${esc(a.source.name)}</a>` : ''}</div>
        ${items.length ? `<ol class="hist">${items.slice(0, 8).map((i) => pendingRow(i, [])).join('')}</ol>${items.length > 8 ? `<details><summary>${num(items.length - 8)} more</summary><ol class="hist">${items.slice(8).map((i) => pendingRow(i, [])).join('')}</ol></details>` : ''}` : `<p class="muted-s">${a.error ? '' : 'Nothing pending right now.'}</p>`}</div>`;
    }).join('') + `<p class="note">Stages come from the state’s own tracking system and change daily. Always check the official notice for the deadline. Not legal advice.</p>`;
  }
  function permitHtml(pm) {
    const ex = pm.exceed, ins = pm.inspections || {}, inf = pm.informal || {}, fo = pm.formal || {};
    const exHtml = ex ? (ex.exceedances
      ? `<div class="exc"><p class="exc-h"><b class="hot">Over its limits ${num(ex.exceedances)} time${ex.exceedances === 1 ? '' : 's'}</b> in the last 3 years (${num(ex.months)} month${ex.months === 1 ? '' : 's'})</p>
          <ol class="hist">${ex.parameters.slice(0, 6).map((x) => `<li><b>${esc(x.name)}</b> · ${num(x.count)}× · worst <span class="hot">${pct(x.max_pct)} over</span>${x.worst ? `<span class="when">${esc(x.worst.value)} vs limit ${esc(x.worst.limit)} ${esc(x.worst.unit || '')} (${esc((x.worst.stat || '').toLowerCase())}) · ${esc(x.worst.date || '')} · outfall ${esc(x.worst.outfall || '?')} · typical ${pct(x.median_pct)} over</span>` : ''}</li>`).join('')}</ol>
          <a class="rlink" href="${esc(ex.url)}" target="_blank" rel="noopener">EPA effluent charts for ${esc(pm.id)}</a></div>`
      : `<p class="note good">No readings over its limits in the last 3 years of discharge reports.</p>`) : '';
    return `<div class="permit">
      <div class="row"><span class="lbl">Water permit ${esc(pm.id)}</span><span class="${pm.status_code === 'EXP' ? 'hot' : ''}">${esc(pm.status)}${pm.expiration ? ' · ' + esc(pm.expiration) : ''}</span></div>
      ${pm.effluent_qtrs != null ? `<div class="row"><span class="lbl">Last 12 quarters</span><span>pollution limits exceeded: ${esc(pm.effluent_qtrs)} · reporting problems: ${esc(pm.reporting_qtrs || 0)}</span></div>` : ''}
      ${pm.water_body ? `<div class="row"><span class="lbl">Discharges to</span><span>${esc(pm.water_body)}</span></div>` : ''}
      ${exHtml}
      ${ins.count != null ? `<div class="row"><span class="lbl">Inspections on record</span><span class="${!ins.count ? 'hot' : ''}">${num(ins.count)}${ins.last ? ' · last ' + esc(ins.last) : ''}</span></div>` : ''}
      ${inf.count != null ? `<div class="row"><span class="lbl">Warning letters / notices</span><span>${num(inf.last5 ?? inf.count)} in 5 yrs · ${num(inf.count)} total</span></div>` : ''}
      ${fo.count != null ? `<div class="row"><span class="lbl">Formal enforcement</span><span class="${inf.last5 >= 3 && !fo.last5 ? 'hot' : ''}">${num(fo.last5 ?? 0)} in 5 yrs · ${num(fo.count)} total · penalties ${usd(fo.penalties || 0)}</span></div>` : ''}
      ${(pm.events || []).length ? `<details><summary>${num(pm.events.length)} incident report${pm.events.length === 1 ? '' : 's'} in 10 years (spills, failed toxicity tests…)</summary><ol class="hist">${pm.events.map((x) => `<li><b>${esc(x.what || 'Violation')}</b><span class="when">${esc(x.date || '')}${x.note ? ' · agency note: “' + esc(x.note) + '”' : ''}</span></li>`).join('')}</ol></details>` : ''}
    </div>`;
  }
  function kyPermitsHtml(list) {
    if (!list.length) return '';
    return `<details ${list.length < 4 ? 'open' : ''}><summary>Inside ${num(list.length)} Kentucky mine permit area${list.length === 1 ? '' : 's'}</summary><ol class="hist">${list.slice(0, 10).map((r) =>
      `<li><b>Permit ${esc(r.permit)}</b>${r.permittee ? ' · ' + esc(r.permittee) : ''}<span class="when">${esc(r.kind || '')} · ${esc(r.flag === 'TRNS' ? 'transferred (old number)' : (r.state || r.status || ''))}${r.issued ? ' · issued ' + esc(r.issued) : ''}${r.original ? ' · original permit ' + esc(r.original) : ''}</span></li>`).join('')}</ol>
      <p class="note">Kentucky Division of Mine Permits boundaries. A transferred number means the permit changed hands.</p></details>`;
  }
  function showPermit(p) {
    show(`
      <p class="eyebrow">KENTUCKY MINE PERMIT · ${esc(String(p.kind || '').toUpperCase())}</p>
      <h2 class="card-title">Permit ${esc(p.permit)}</h2>
      <div class="row"><span class="lbl">Permittee</span><span>${esc(p.permittee || 'not listed')}</span></div>
      <div class="row"><span class="lbl">Status</span><span>${esc(p.state || p.status || '')}</span></div>
      ${p.issued ? `<div class="row"><span class="lbl">Issued</span><span>${esc(p.issued)}</span></div>` : ''}
      ${p.original ? `<div class="row"><span class="lbl">Original permit</span><span>${esc(p.original)}</span></div>` : ''}
      ${p.acres ? `<div class="row"><span class="lbl">Area</span><span>${num(p.acres)} acres</span></div>` : ''}
      ${p.permittee ? researchHtml(p.permittee, 'COMPANY') : ''}
      <p class="src">SOURCE: <a href="${esc(p.source_url)}" target="_blank" rel="noopener">Kentucky Division of Mine Permits</a> (permitted mine boundaries) · pulled ${esc(p.as_of)}</p>`);
  }
  function triChart(by) {
    const ys = Object.keys(by).sort(); if (ys.length < 2) return '';
    const mx = Math.max(...ys.map((y) => by[y]), 1), W = 300, H = 70, bw = W / ys.length;
    return `<svg class="trichart" viewBox="0 0 ${W} ${H + 14}" role="img" aria-label="Pounds released per year">${ys.map((y, i) => {
      const h = Math.max(1, (by[y] / mx) * H);
      return `<rect x="${i * bw + 2}" y="${H - h}" width="${bw - 4}" height="${h}" rx="2"><title>${y}: ${num(by[y])} lbs</title></rect>` +
        (i === 0 || i === ys.length - 1 ? `<text x="${i * bw + bw / 2}" y="${H + 12}" text-anchor="middle">${y}</text>` : '');
    }).join('')}</svg>`;
  }
  function showTri(p) {
    const t = parse(p.tri, {});
    const ids = parse(p.ids, {});
    show(`
      <p class="eyebrow">${esc(kindLabel(p.kind, 'TRI facility').toUpperCase())}</p>
      <h2 class="card-title">${esc(p.name)}</h2>
      <div class="row"><span class="lbl">Parent company (reported by the facility)</span><span>${esc(t.parent || 'none reported')}</span></div>
      ${t.foreign_parent ? `<div class="row"><span class="lbl">Foreign parent</span><span>${esc(t.foreign_parent)}</span></div>` : ''}
      ${t.parent ? researchHtml(t.parent, 'COMPANY') : ''}
      ${parse(p.flags, []).length ? `<p class="flag">Data note: ${parse(p.flags, []).map(esc).join('; ')}</p>` : ''}
      ${(() => { const r = parse(p.releases, null); if (!r) return '<p class="note">No release amounts found in EPA TRI files for the last 10 years.</p>';
        return `<div class="stats"><div class="stat"><span class="k">Released in ${esc(r.latest_year)}</span><span class="v">${num(r.latest_total)}<span class="muted-s"> lbs</span></span><span class="s">air ${num(r.latest_air)} · water ${num(r.latest_water)}</span></div>
          <div class="stat"><span class="k">Chemicals reported</span><span class="v">${num(r.chemical_count)}</span><span class="s">${r.chemicals.filter((c) => c.carcinogen).length} on the cancer list</span></div></div>
          ${triChart(r.by_year)}
          <ol class="hist">${r.chemicals.slice(0, 8).map((c) => `<li><b>${esc(c.name)}</b>${c.carcinogen ? ' <span class="hot">carcinogen</span>' : ''}${c.pfas ? ' <span class="hot">PFAS</span>' : ''}${c.pbt ? ' <span class="warm">builds up in bodies</span>' : ''}<span class="when">${num(c.lbs)} lbs · air ${num(c.air)} · water ${num(c.water)}</span></li>`).join('')}</ol>
          <p class="note">Self-reported by the facility. Most releases are legal under permits; this shows amounts, not violations. Amounts are not health effects.</p>
          <p class="src"><a href="${esc(r.source_url)}" target="_blank" rel="noopener">EPA TRI facility profile</a></p>`; })()}
      <div class="btns">${packBtn('tri', p, p.name + ' (TRI ' + (ids.tri || '') + ')')}</div>
      <p class="src">SOURCE: ${p.source_url ? `<a href="${esc(p.source_url)}" target="_blank" rel="noopener">EPA facility report</a>` : 'EPA Toxics Release Inventory'} · pulled ${esc(p.as_of)}</p>
      ${recordActions('tri', ids.tri || ids.frs, p.name)}
      <p class="src pro">IDS: TRI ${esc(ids.tri)}${ids.frs ? ' · FRS ' + esc(ids.frs) : ''}</p>`);
  }

  function showWater(area) {
    const w = water[area]; if (!w) return;
    show(`
      <p class="eyebrow">DRINKING WATER · ${esc(w.label.toUpperCase())}</p>
      <h2 class="card-title">${num(w.systems.length)} community water systems</h2>
      <p class="muted-s">Systems that serve homes here, sorted by health-based violations in the last 5 years.${w.basis ? ' Matched by: ' + esc(w.basis) + '.' : ''}</p>
      <ul class="mines-list">${w.systems.map((sy) => `<li><div class="wsys">
        <b>${esc(sy.name)}</b> <span class="count">${sy.population ? num(sy.population) + ' people' : ''}</span>
        <span class="when"><span class="${sy.health_last5 ? 'hot' : ''}">${num(sy.health_last5)} health-based violations (5 yrs)</span> · ${num(sy.violations)} violations on record${sy.lead_copper ? ' · <span class="warm">' + num(sy.lead_copper) + ' under the Lead and Copper Rule</span>' : ''}${sy.open ? ' · ' + num(sy.open) + ' not yet resolved' : ''}</span>
        <span class="when">${Object.entries(sy.by_category || {}).map(([k, n]) => esc(k) + ': ' + num(n)).join(' · ')}</span>
        ${(sy.health_last5 || sy.lead_copper) ? `<button type="button" class="linkbtn" data-letter="${esc(regWaterLetter(sy, area))}">Draft a records request →</button>` : ''}
        <span class="when pro">PWSID ${esc(sy.pwsid)}</span></div></li>`).join('')}</ul>
      <p class="note">Health-based means the water went over a legal limit or missed a required treatment step. Monitoring and reporting violations are paperwork problems, counted separately. “Lead and Copper Rule” counts include monitoring violations under that rule.</p>
      <p class="flag">Federal violation records only show what agencies formally recorded, and can miss what residents lived through. Flint’s 2014–15 crisis is a reminder: check state records, news and court files too.</p>
      <p class="src">SOURCE: ${esc(w.source)} · pulled ${esc(w.as_of)}</p>`);
  }


  // ======================= Controller family page (full screen) =======================
  const TODAY = new Date().toISOString().slice(0, 10);
  const yr = (d) => (d || '').slice(0, 4);
  function familyModel(cid) {
    const f = families[cid]; if (!f) return null;
    const ops = {};   // operator id -> {id, name, mines: {mineId: {feat, periods[]}}}
    for (const m of f.mines || []) {
      const feat = mineById[m.id]; if (!feat) continue;
      const hist = parse(feat.properties.history, []);
      for (const h of hist) {
        if (h.controller_id !== cid) continue;
        // control of THIS mine = the overlap of the operator's stint here and the controller's control of that operator
        const s0 = [h.op_start, h.ctl_start].filter(Boolean).sort().pop() || '';
        const e0 = [h.op_end, h.ctl_end].filter(Boolean).sort()[0] || '';
        if (s0 && e0 && s0 > e0) continue;
        const o = ops[h.operator_id || h.operator] ||= { id: h.operator_id, name: h.operator || 'Unnamed operator', mines: {} };
        const mm = o.mines[m.id] ||= { feat, periods: [] };
        mm.periods.push({ start: s0, end: e0, op_start: h.op_start, op_end: h.op_end });
      }
    }
    const periods = Object.values(ops).flatMap((o) => Object.values(o.mines).flatMap((m) => m.periods));
    const first = periods.map((p) => p.start).filter(Boolean).sort()[0] || '';
    const last = periods.some((p) => !p.end) ? '' : periods.map((p) => p.end).filter(Boolean).sort().pop() || '';
    return { f, ops, first, last };
  }
  const activeAt = (p, d) => d === 'all' || ((p.start || '0000') <= d && (!p.end || p.end >= d));

  const normName = (n) => (n || '').toLowerCase().replace(/\b(llc|l\.l\.c|inc|incorporated|co|corp|corporation|company|ltd|lp|llp|the|of)\b\.?/g, ' ').match(/[a-z0-9]+/g)?.join(' ') || '';
  const CC = { US: 'United States', GB: 'United Kingdom', CH: 'Switzerland', CA: 'Canada', AU: 'Australia', IN: 'India', CN: 'China', RU: 'Russia', DE: 'Germany', NL: 'Netherlands', LU: 'Luxembourg', IE: 'Ireland', KY: 'Cayman Islands', BM: 'Bermuda', VG: 'British Virgin Islands', SG: 'Singapore', HK: 'Hong Kong', PL: 'Poland', UA: 'Ukraine', ZA: 'South Africa', JP: 'Japan', CY: 'Cyprus', JE: 'Jersey', GG: 'Guernsey', IM: 'Isle of Man', PA: 'Panama', MH: 'Marshall Islands', BS: 'Bahamas', LI: 'Liechtenstein', MT: 'Malta', AE: 'United Arab Emirates', TR: 'Turkey', CO: 'Colombia', ID: 'Indonesia' };
  const country = (c, r) => (c ? (CC[c] || c) : '') + (r && r.includes('-') && c === 'US' ? ' · ' + r.split('-')[1] : '');
  // GLEIF records for a list of names (exact normalized-name matches made by the collector)
  function leiFor(names) {
    const out = [];
    for (const n of names) for (const e of (parents?.by_name?.[normName(n)]?.gleif || [])) if (!out.some((x) => x.e.lei === e.lei)) out.push({ asName: n, e });
    return out;
  }
  function entLine(e) {
    return `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.legal_name || e.lei)}</a><span class="when">LEI ${esc(e.lei)}${e.country ? ' · registered in ' + esc(country(e.country, e.region)) : ''}${e.hq_country && e.hq_country !== e.country ? ' · HQ ' + esc(country(e.hq_country)) : ''}${e.status && e.status !== 'ACTIVE' ? ' · ' + esc(e.status.toLowerCase()) : ''}</span>`;
  }
  function parentsCard({ asName, e }) {
    const up = (rel, label) => e[rel + '_parent']
      ? `<li><span class="lbl2">${label}</span>${entLine(e[rel + '_parent'])}</li>`
      : e[rel + '_exception'] ? `<li><span class="lbl2">${label}</span><b class="muted-b">None reported</b><span class="when">${esc(e[rel + '_exception'].plain)} (GLEIF reason: ${esc(e[rel + '_exception'].code)})</span></li>`
      : `<li><span class="lbl2">${label}</span><b class="muted-b">Not stated</b></li>`;
    const sameUltimate = e.ultimate_parent && e.direct_parent && e.ultimate_parent.lei === e.direct_parent.lei;
    return `<div class="par-card"><p class="eyebrow">${esc(asName)} · <a href="#tree/${esc(e.lei)}">world tree →</a></p><div class="par-ent">${entLine(e)}${e.registered_at ? `<span class="when">LEI since ${esc(e.registered_at)}</span>` : ''}</div>
      <ol class="hist par">${up('direct', 'Direct parent')}${sameUltimate ? '' : up('ultimate', 'Ultimate parent')}</ol>
      ${e.children?.length ? `<details><summary>${num(e.children_total || e.children.length)} ${(e.children_total || e.children.length) === 1 ? 'company reports' : 'companies report'} it as their direct parent</summary><ol class="hist">${e.children.map((c) => `<li>${entLine(c)}</li>`).join('')}</ol></details>` : ''}</div>`;
  }
  function regFor(names) {
    const out = [];
    for (const n of names) for (const r of (registry?.by_name?.[normName(n)]?.ky || [])) if (!out.some((x) => x.r.url === r.url)) out.push({ asName: n, r });
    return out;
  }
  function regCard({ asName, r }) {
    const bad = /^B/.test(r.standing || ''), inactive = /^I/.test(r.status || '');
    return `<div class="par-card"><p class="eyebrow">${esc(asName)} · KENTUCKY RECORD</p>
      <div class="par-ent"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.legal_name || asName)}</a>
        <span class="when">KY org ${esc(r.org_number || '?')} · ${esc(r.type || '')}${r.home_state ? ' · formed in ' + esc(r.home_state) : ''}${r.office_city ? ' · office ' + esc(r.office_city) : ''}</span></div>
      <div class="par-tags"><span class="${inactive ? 'hot' : ''}">${esc(r.status || 'status ?')}</span><span class="${bad ? 'hot' : ''}">Standing: ${esc(r.standing || '?')}</span>${r.last_annual_report ? `<span>Last annual report ${esc(r.last_annual_report)}</span>` : ''}</div>
      ${r.agent_is_state ? '<p class="note hot">No registered agent of its own: the Secretary of State is listed as its agent, which usually means the company stopped keeping a legal contact in Kentucky.</p>' : r.agent ? `<p class="muted-s">Registered agent: ${esc(r.agent)}</p>` : ''}
      ${r.officers?.length ? `<ol class="hist par">${r.officers.map((o) => `<li><span class="lbl2">${esc(o.title)}${o.when === 'initial' ? ' · at founding' : ''}</span><b>${esc(o.name)}</b></li>`).join('')}</ol>` : '<p class="muted-s">No officers, directors or members listed in the filing.</p>'}
      ${r.hidden_admin ? `<p class="note">${num(r.hidden_admin)} administrative role${r.hidden_admin === 1 ? '' : 's'} (secretary, assistant, organizer) held by individuals not shown.</p>` : ''}</div>`;
  }
  function stateMoneyHtml(f, opList, isPerson) {
    const names = [isPerson ? null : f.controller, ...opList.map((o) => o.name)].filter(Boolean);
    const hits = names.flatMap((n) => (klec?.by_name?.[normName(n)] || []).map((x) => ({ n, ...x })));
    const q = encodeURIComponent(names[0] || '');
    return `<section class="fp-time" id="fp-state"><h2 class="serif">State-level money and lobbying</h2>
      <h3 class="fp-sub">Kentucky lobbying (Legislative Ethics Commission)</h3>
      ${klec ? (hits.length ? `<p class="muted-s">Lines in the Commission’s employer expenditure reports that name this family’s companies exactly. Read each in the report: names can repeat across unrelated employers.</p><ol class="hist">${hits.slice(0, 12).map((h) => `<li><b>${esc(h.n)}</b><span class="when">${esc(h.line)} · <a href="${esc(h.file)}" target="_blank" rel="noopener">report</a></span></li>`).join('')}</ol>` : '<p class="muted-s">None of this family’s company names appear in the Commission’s employer expenditure reports.</p>') : '<p class="muted-s">Not collected yet.</p>'}
      <div class="fp-two">
        <div class="fp-empty"><b>Campaign money: search directly</b><span>Kentucky bars corporations from giving to candidates, so company money shows up through PACs and executives. Our build can’t read the state search yet: <a href="https://secure.kentucky.gov/kref/publicsearch/AllContributors" target="_blank" rel="noopener">Kentucky Registry of Election Finance</a> · <a href="https://mi-boe.entellitrak.com/etk-mi-boe-prod/page.request.do?page=page.miboeContributionPublicSearch" target="_blank" rel="noopener">Michigan contributions search</a></span></div>
        <div class="fp-empty"><b>Business records in other states</b><span>Search by name: <a href="https://apps.sos.wv.gov/business/corporations/" target="_blank" rel="noopener">West Virginia</a> · <a href="https://tnbear.tn.gov/Ecommerce/FilingSearch.aspx" target="_blank" rel="noopener">Tennessee</a> · <a href="https://cis.scc.virginia.gov/EntitySearch/Index" target="_blank" rel="noopener">Virginia</a> · <a href="https://icis.corp.delaware.gov/ecorp/entitysearch/NameSearch.aspx" target="_blank" rel="noopener">Delaware</a> · <a href="https://opencorporates.com/companies?q=${q}" target="_blank" rel="noopener">OpenCorporates</a></span></div>
      </div></section>`;
  }
  function parentsHtml(f, opList, isPerson) {
    const names = [isPerson ? null : f.controller, ...opList.map((o) => o.name)].filter(Boolean);
    const recs = leiFor(names);
    const regs = regFor(names);
    const same = f.same_name_ids || [];
    const checked = names.filter((n) => parents?.by_name?.[normName(n)]).length;
    const sec = (n) => `https://www.sec.gov/edgar/search/#/q=%22${encodeURIComponent(n)}%22`;
    return `<section class="fp-time" id="fp-parents"><h2 class="serif">Who’s above them</h2>
      <p class="muted-s">From GLEIF, the global register of legal entities (LEIs). Parents are what each company reported about itself. Counted only when the legal name matches exactly (ignoring LLC, Inc…). ${parents ? `${num(checked)} of ${num(names.length)} names in this family were checked${recs.length ? '' : '; none has an LEI'}.` : 'Not collected yet.'}</p>
      ${recs.length ? `<div class="par-grid">${recs.map(parentsCard).join('')}</div>` : ''}
      <h3 class="fp-sub" style="margin-top:22px">Who runs them: Kentucky business records</h3>
      <p class="muted-s">Officers, directors, members and managers exactly as listed with the Kentucky Secretary of State, in their corporate roles. ${registry ? (regs.length ? '' : 'None of this family’s company names matched exactly.') : 'Not collected yet.'}</p>
      ${regs.length ? `<div class="par-grid">${regs.map(regCard).join('')}</div>` : ''}
      ${(() => { const h = names.map((n) => sec?.by_name?.[normName(n)]).filter(Boolean); return h.length ? `<h3 class="fp-sub" style="margin-top:22px">Listed as a subsidiary (SEC Exhibit 21)</h3><ol class="hist">${h.flatMap((x) => x.listed_by.map((l) => `<li><b>${esc(x.name)}</b> in <b>${esc(l.company)}</b>’s subsidiary list<span class="when">${esc(l.form || '')} filed ${esc(l.filed || '')} · <a href="${esc(l.url)}" target="_blank" rel="noopener">Exhibit 21</a> · exact-name match, check the filing</span></li>`)).join('')}</ol>` : ''; })()}
      ${same.length ? `<div class="par-same"><h3 class="fp-sub">Same name, other MSHA controller IDs</h3><p class="muted-s">Inferred, medium confidence: identical names (ignoring LLC, Inc…). It may be one company recorded more than once, or a different company with the same name.</p><ol class="hist">${same.map((x) => `<li><a href="#family/${esc(x.id)}">${esc(x.name)}</a><span class="when">MSHA controller ${esc(x.id)} · ${num(x.mines)} mine${x.mines === 1 ? '' : 's'}</span></li>`).join('')}</ol></div>` : ''}
      <div class="fp-two">
        <div class="fp-empty"><b>SEC subsidiaries and mine lists: open the links</b><span>Public companies list their subsidiaries (Exhibit 21) and every mine by MSHA ID (Exhibit 95) in annual reports. SEC blocks our build server, so search EDGAR directly: ${names.slice(0, 4).map((n) => `<a href="${sec(n)}" target="_blank" rel="noopener">${esc(n)}</a>`).join(' · ')}</span></div>
        <div class="fp-empty"><b>Not connected yet</b><span>Business registries in other states (Delaware, Tennessee, West Virginia…) and owners of companies that report none.</span></div>
      </div>
    </section>`;
  }
  function moneyFor(names) {
    const recs = names.map((n) => money?.by_name?.[normName(n)]).filter(Boolean);
    const agg = { contracts: 0, grants: 0, loans: 0, awards: [], similar: 0, pacs: [], cases: [], casesCount: 0, looked: recs.length, lobby: [], pay: [], mentions: 0 };
    for (const r of recs) {
      for (const g of ['contracts', 'grants', 'loans']) {
        const x = r.usaspending?.[g]; if (!x) continue;
        agg[g] += x.total || 0; agg.similar += x.similar_not_counted || 0;
        agg.awards.push(...(x.top || []).map((a) => ({ ...a, group: g, matched: r.name })));
      }
      for (const c of r.fec || []) { agg.pacs.push({ ...c, matched: r.name }); agg.pay.push(...(c.itemized || []).map((x) => ({ ...x, pac: c.committee }))); }
      agg.lobby.push(...(r.lobbying || []).map((x) => ({ ...x, client: r.name })));
      if (r.courts) {
        // Full-text search also finds dockets that merely MENTION the company (e.g. as one creditor among thousands).
        // Only dockets whose case name contains the company name count as its own cases.
        const nn = normName(r.name);
        for (const c of r.courts.cases || []) {
          const party = c.party ?? normName(c.case).includes(nn);
          if (party) agg.cases.push({ ...c, matched: r.name }); else agg.mentions += 1;
        }
      }
    }
    agg.total = agg.contracts + agg.grants + agg.loans;
    agg.awards.sort((a, b) => (b.amount || 0) - (a.amount || 0));
    return agg;
  }
  let famState = { cid: null, asOf: 'all', sel: null };
  function renderFamilyPage(cid, opts) {
    const M = familyModel(cid);
    const el = $('familyPage');
    if (!M) { el.innerHTML = `<div class="fp-wrap"><p class="flag">No controller family found for ID ${esc(cid)}.</p><a class="btn" href="#">Back home</a></div>`; return; }
    famState = { cid, asOf: opts?.asOf || 'all', sel: opts?.sel || null };
    const { f } = M;
    const v = f.viol || {};
    const allMines = (f.mines || []).map((m) => mineById[m.id]).filter(Boolean);
    const active = allMines.filter((x) => x.properties.status === 'Active').length;
    const epaLinks = allMines.flatMap((x) => parse(x.properties.epa, []).map((e) => ({ ...e, mine: x })));
    const highEpa = epaLinks.filter((e) => e.severity === 'high');
    const worst = allMines.filter((x) => (parse(x.properties.fair, {}).per_inspection_pct ?? -1) >= 75).length;
    const rated = allMines.filter((x) => parse(x.properties.fair, {}).per_inspection != null).length;
    const paidPct = v.due > 0 ? Math.round((v.paid / v.due) * 100) : null;
    const isPerson = isPersonCtl(f.controller, f.controller_type);
    const opList = Object.values(M.ops);
    const changes = allMines.filter((x) => parse(x.properties.history, []).length > 1).length;
    const mo = moneyFor([f.controller, ...opList.map((o) => o.name)]);
    const courtsOn = money?.courts === 'on';
    const bk = mo.cases.filter((c) => c.bankruptcy);

    // as-of year buttons
    const years = [...new Set(opList.flatMap((o) => Object.values(o.mines).flatMap((m) => m.periods.map((p) => yr(p.start)))).filter(Boolean))].sort();
    const pickYears = years.length <= 4 ? years : [0, 1, 2, 3].map((i) => years[Math.round((i * (years.length - 1)) / 3)]);
    const asOfBtns = [['all', 'All time'], ...[...new Set(pickYears)].map((y) => [y + '-07-01', y]), [TODAY, 'Now']]
      .map(([d, label]) => `<button type="button" data-asof="${d}" aria-pressed="${famState.asOf === d}">${esc(label)}</button>`).join('');

    // graph: controller -> operators -> mines (as of)
    const visOps = opList.map((o) => ({ ...o, vis: Object.entries(o.mines).filter(([, m]) => m.periods.some((p) => activeAt(p, famState.asOf))) }))
      .filter((o) => o.vis.length).sort((a, b) => b.vis.length - a.vis.length);
    const mineChip = (mid, m) => {
      const p = m.feat.properties; const e = parse(p.epa, []);
      const hi = e.some((x) => x.severity === 'high');
      const cls = p.status === 'Active' ? 'act' : '';
      return `<button type="button" class="fp-mine ${cls}" data-fpmine="${esc(mid)}" aria-pressed="${famState.sel === 'm:' + mid}">
        <span class="nm">${esc(p.name)}</span><span class="ct" title="All citations at this mine, under every operator and controller">${num(p.citations || 0)} citations · all owners</span>
        ${e.length ? `<span class="epa ${hi ? 'hi' : ''}">${hi ? '⚑ ' : ''}EPA site ${hi ? '· high priority' : ''}</span>` : ''}</button>`;
    };
    const graph = visOps.length ? visOps.map((o) => `
      <div class="fp-op ${famState.sel === 'o:' + (o.id || o.name) ? 'sel' : ''}">
        <button type="button" class="fp-ophead" data-fpop="${esc(o.id || o.name)}"><b>${esc(o.name)}</b><span class="muted-s">Operating company · MSHA record · ${num(o.vis.length)} mine${o.vis.length === 1 ? '' : 's'}</span></button>
        <div class="fp-mines">${o.vis.map(([mid, m]) => mineChip(mid, m)).join('')}</div>
      </div>`).join('') : `<p class="note">No mines under this controller on that date.</p>`;

    // right panel
    let panel = '';
    if (famState.sel?.startsWith('o:')) {
      const o = opList.find((x) => (x.id || x.name) === famState.sel.slice(2));
      panel = `<p class="eyebrow">WHY IT’S IN THIS FAMILY</p><h3 class="fp-ptitle">${esc(o.name)}</h3>
        <p class="muted-s">Operating company${o.id ? ' · MSHA operator ID ' + esc(o.id) : ''}</p>
        ${leiFor([o.name]).map((x) => `<div class="par-ent">${entLine(x.e)}</div>`).join('')}
        <div class="fp-conf"><span>Confidence</span><b class="steel">High · agency record</b></div>
        <p class="muted-s">MSHA lists ${personLabel(f.controller, f.controller_type)} as the controller of this company’s mines for these periods:</p>
        <ol class="hist">${Object.values(o.mines).flatMap((m) => m.periods.map((p) => `<li><b>${esc(m.feat.properties.name)}</b><span class="when">controlled ${esc(p.start || '?')} → ${esc(p.end || 'now')} · MSHA Controller/Operator History</span></li>`)).join('')}</ol>`;
    } else if (famState.sel?.startsWith('m:')) {
      const mf = mineById[famState.sel.slice(2)]; const p = mf.properties; const mv = parse(p.viol, null);
      const per = Object.values(M.ops).flatMap((o) => (o.mines[famState.sel.slice(2)]?.periods || []).map((x) => ({ ...x, op: o.name })));
      panel = `<p class="eyebrow">MINE · ${esc(mineStatus(p.status).toUpperCase())}</p><h3 class="fp-ptitle">${esc(p.name)}</h3>
        <div class="fp-conf"><span>Link to this controller</span><b class="steel">High · agency record</b></div>
        <ol class="hist">${per.map((x) => `<li>Run by <b>${esc(x.op)}</b><span class="when">under this controller ${esc(x.start || '?')} → ${esc(x.end || 'now')}</span></li>`).join('')}</ol>
        ${violStats(mv, 'at this mine')}
        ${fairHtml(parse(p.fair, null))}
        ${parse(p.epa, []).map((e) => `<div class="fp-epa ${e.severity === 'high' ? 'hi' : ''}"><b>${esc(e.name)}</b><span class="when">EPA site, ${e.confidence === 'high' ? 'same Kentucky mine permit (high confidence)' : 'possibly the same place (' + esc(e.confidence) + ' confidence, inferred)'}: ${esc((e.basis || []).join(' · '))}</span>
          ${(e.permits || []).map((pm) => `<span class="when">Permit ${esc(pm.id)}: <span class="${pm.status_code === 'EXP' ? 'hot' : ''}">${esc(pm.status)}</span></span>`).join('')}
          ${(e.flags || []).length ? `<span class="when hot">⚑ ${e.flags.map((x) => esc(x.label)).join(' · ')}</span><button type="button" class="linkbtn" data-letter="${esc(regFacilityLetter(e, parse(p.ids, {})))}">Draft a records request →</button>` : ''}</div>`).join('')}
        <div class="btns"><button type="button" class="btn" data-fpmap="${esc(famState.sel.slice(2))}">Open on the map →</button></div>`;
    } else {
      panel = `<p class="eyebrow">WHY THESE ARE ONE FAMILY</p><h3 class="fp-ptitle">${isPerson ? 'One listed controller' : personLabel(f.controller, f.controller_type)}</h3>
        <div class="fp-conf"><span>Confidence</span><b class="steel">High · agency records</b></div>
        <p class="muted-s">MSHA names this ${isPerson ? 'individual' : 'company'} as the controlling entity for ${num(allMines.length)} Harlan County mine${allMines.length === 1 ? '' : 's'}, run through ${num(opList.length)} operating compan${opList.length === 1 ? 'y' : 'ies'}. Every solid line is an MSHA controller record with dates.</p>
        <p class="muted-s">Click any company or mine to see the records behind it.</p>
        ${(() => { const l = leiFor([isPerson ? null : f.controller].filter(Boolean))[0]; const up = l && (l.e.ultimate_parent || l.e.direct_parent);
          return l ? `<div class="fp-conf"><span>Above it (GLEIF)</span><b class="steel">${up ? esc(up.legal_name) + ' · ' + esc(country(up.country)) : 'No parent reported'}</b></div>` : ''; })()}
        ${(f.same_name_ids || []).length ? `<p class="muted-s">${num(f.same_name_ids.length)} other MSHA controller ID${f.same_name_ids.length === 1 ? '' : 's'} share this exact name. <a href="#fp-parents">See who’s above them ↓</a></p>` : '<p class="muted-s"><a href="#fp-parents">See who’s above them ↓</a></p>'}
        ${researchHtml(f.controller, f.controller_type)}`;
    }

    // timeline (operators under this controller)
    const yMin = +(yr(M.first) || new Date().getFullYear() - 10), yMax = new Date().getFullYear() + 1;
    const pos = (d) => (((d ? +d.slice(0, 4) + (+d.slice(5, 7) - 1) / 12 : yMax) - yMin) / (yMax - yMin)) * 100;
    const tl = opList.map((o) => {
      const ps = Object.values(o.mines).flatMap((m) => m.periods);
      const s0 = ps.map((p) => p.start).filter(Boolean).sort()[0];
      const ongoing = ps.some((p) => !p.end);
      const e0 = ongoing ? '' : ps.map((p) => p.end).filter(Boolean).sort().pop();
      return { name: o.name, s0, e0, n: Object.keys(o.mines).length };
    }).filter((t) => t.s0).sort((a, b) => a.s0.localeCompare(b.s0));
    const ticks = []; for (let y = Math.ceil(yMin / 5) * 5; y < yMax; y += 5) ticks.push(y);
    const timeline = `<div class="fp-tl"><div class="tlrow tlhead"><span></span><span class="tltrack ticks">${ticks.map((y) => `<span class="tick" style="left:${pos(y + '-01-01')}%">${y}</span>`).join('')}</span><span></span></div>
      ${tl.map((t) => `<div class="tlrow"><span class="tlname">${esc(t.name)}</span><span class="tltrack"><span class="tlbar ${t.e0 ? '' : 'now'}" style="left:${pos(t.s0)}%;width:${Math.max(1, pos(t.e0) - pos(t.s0))}%" title="${esc(t.s0)} → ${esc(t.e0 || 'now')}"></span></span><span class="tlwhen">${esc(yr(t.s0))}–${t.e0 ? esc(yr(t.e0)) : 'now'} · ${t.n} mine${t.n === 1 ? '' : 's'}</span></div>`).join('')}</div>`;

    const famLetter = regFamilyLetter(f, allMines);
    const kpi = (k, val, sub, src, cls = '') => `<div class="fp-k ${cls}"><span class="k">${k}</span><span class="v">${val}</span><span class="s">${sub}</span><span class="src2">${src}</span></div>`;
    const credit = allMines.filter((x) => { const fr = parse(x.properties.fair, {}); return fr.per_inspection_pct != null && fr.per_inspection_pct <= 25; });
    const cleanEpa = epaLinks.filter((e) => e.qtrs_noncompliance === 0);

    el.innerHTML = `<div class="fp-wrap">
      <div class="fp-crumb"><a href="#">Home</a> / <a href="#map/harlan">Harlan County, KY</a> / <span>Controller family</span></div>
      <section class="fp-head">
        <div class="fp-title">
          <p class="eyebrow">${isPerson ? 'MINE FAMILY' : 'CONTROLLER · ' + esc((f.controller_type || 'unknown').toUpperCase())} · MSHA RECORDS</p>
          <h1 class="serif">${isPerson ? esc(leadCompany([...opList].sort((a, b) => Object.keys(b.mines).length - Object.keys(a.mines).length).map((o) => o.name))) : esc(f.controller)}</h1>
          ${isPerson ? listedControllerNote(f.controller) : ''}
          <p class="lede2">${num(allMines.length)} mine${allMines.length === 1 ? '' : 's'} pulled into one family from MSHA records · ${num(opList.length)} operating compan${opList.length === 1 ? 'y' : 'ies'} · ${esc(yr(M.first) || '?')}–${M.last ? esc(yr(M.last)) : 'now'}</p>
          <div class="fp-ids"><span>MSHA controller ${esc(f.controller_id)}</span>${opList.slice(0, 4).map((o) => o.id ? `<span class="pro">operator ${esc(o.id)}</span>` : '').join('')}${(() => { const l = leiFor([isPerson ? null : f.controller].filter(Boolean)); return l.length ? l.map((x) => `<span>LEI ${esc(x.e.lei)}</span>`).join('') : `<span>LEI · ${parents ? 'none found' : 'not linked yet'}</span>`; })()}<span>State registry · not linked yet</span></div>
        </div>
        <div class="btns"><button type="button" class="btn" data-fpmap="__all">Show on the map</button><button type="button" class="btn primary" data-letter="${esc(famLetter)}">Request MSHA records</button>${packBtn('family', f, (isPerson ? leadCompany(opList.map((o) => o.name)) + ' mine family' : f.controller + ' family') + ' (MSHA controller ' + f.controller_id + ')')}</div>
      </section>
      <section class="fp-kpis" aria-label="Family totals">
        ${kpi('Mines in family', num(allMines.length), `${num(active)} active now · ${num(opList.length)} compan${opList.length === 1 ? 'y' : 'ies'}`, 'MSHA · ' + esc(f.as_of))}
        ${kpi('Safety citations', num(v.total || 0), `while under this controller · ${num(v.last5 || 0)} in the last 5 years`, 'MSHA violations', (v.last5 || 0) > 0 ? '' : '')}
        ${kpi('Serious (S&amp;S)', num(v.sig_sub || 0), 'likely to cause injury', 'MSHA violations')}
        ${kpi('Penalties assessed', usd(v.due || 0), paidPct == null ? '—' : `${paidPct}% paid (${usd(v.paid || 0)}) · ${usd(Math.max(0, (v.due || 0) - (v.paid || 0)))} unpaid`, 'MSHA assessments', paidPct != null && paidPct < 50 ? 'hotk' : '')}
        ${kpi('EPA sites linked', num(epaLinks.length), `${num(highEpa.length)} high-priority flags`, 'EPA ECHO · inferred links', highEpa.length ? 'hotk' : '')}
        ${kpi('Worst-quarter mines', rated ? num(worst) + '<span class="of"> / ' + num(rated) + '</span>' : '—', 'citations per inspection vs Harlan', 'MSHA inspections')}
        ${!money || !mo.looked ? kpi('Public money received', '<span class="empty">—</span>', 'contracts, loans, grants', money ? 'not looked up for this family yet' : 'not collected yet', 'emptyk')
          : kpi('Public money received', usd(mo.total), `contracts ${usd(mo.contracts)} · loans ${usd(mo.loans)} · grants ${usd(mo.grants)}`, 'USAspending · matched by name')}
        ${!courtsOn ? kpi('Court cases', '<span class="empty">—</span>', 'lawsuits, bankruptcies', 'needs a free CourtListener token', 'emptyk')
          : kpi('Court cases', num(mo.cases.length), `${num(bk.length)} bankruptcy cases · ${num(mo.mentions)} other dockets only mention the name`, 'CourtListener · company named as a party', bk.length ? 'hotk' : '')}
      </section>
      <section class="fp-main">
        <div class="fp-graph">
          <div class="fp-ghead"><div><h2>Family graph</h2><span class="muted-s">Controller → operating companies → mines. Click anything to see why it’s here.</span></div>
            <div class="fp-asof" role="group" aria-label="As of">${asOfBtns}</div></div>
          <div class="fp-legend"><span><i class="ln solid"></i>MSHA record</span><span><i class="ln dash"></i>Inferred (EPA site match)</span><span><i class="dot" style="background:#E3A44E"></i>Active mine</span><span><i class="dot" style="background:#EE7D67"></i>High-priority EPA flag</span></div>
          <button type="button" class="fp-root ${famState.sel ? '' : 'sel'}" data-fpsel="">${esc(f.controller)}<span class="muted-s">${isPerson ? 'Listed controller (individual)' : 'Controller'} · MSHA ${esc(f.controller_id)}</span></button>
          <div class="fp-ops">${graph}</div>
        </div>
        <aside class="fp-panel" aria-live="polite">${panel}</aside>
      </section>
      <section class="fp-pats" aria-label="Patterns">
        <article class="pat coral"><span class="eyebrow">LIABILITY PATTERN</span><h3>Operator changes: ${num(changes)} of ${num(allMines.length)} mines</h3>
          <p>These mines changed operating company at least once.${bk.length ? ` Bankruptcy-court dockets found by name: ${bk.slice(0, 3).map((c) => `<a href="${esc(c.url || '#')}" target="_blank" rel="noopener">${esc(c.case)}</a> (${esc(c.court_id)}, ${esc(c.filed || '')})`).join('; ')}.` : ''}</p>
          <p class="emptynote">${courtsOn ? 'Reclamation-bond records: not collected yet' : 'Bankruptcy records need a free CourtListener token · bond records not collected yet'}</p></article>
        <article class="pat amber"><span class="eyebrow">SILENCE DETECTOR</span><h3>${highEpa.length ? num(highEpa.length) + ' high-priority EPA site' + (highEpa.length === 1 ? '' : 's') : 'No high-priority EPA flags'}</h3>
          ${highEpa.slice(0, 2).map((e) => `<p><b>${esc(e.name)}</b> · ${esc((e.flags || [])[0]?.label || '')} <span class="muted-s">· linked to this family’s mine by an inferred site match, not an MSHA record</span></p>`).join('') || '<p>No linked EPA site has a high-priority flag.</p>'}
          ${highEpa.length ? `<button type="button" class="linkbtn" data-letter="${esc(regFacilityLetter(highEpa[0], parse(highEpa[0].mine.properties.ids, {})))}">Draft a records request →</button>` : ''}</article>
        ${(mo.pacs.length || mo.lobby.length) ? `<article class="pat steel"><span class="eyebrow">MONEY TIMING · NOT PROOF</span>
          <h3>${mo.lobby.length ? usd(mo.lobby.reduce((a, x) => a + (+x.amount || 0), 0)) + ' on federal lobbying' : ''}${mo.lobby.length && mo.pacs.length ? ' · ' : ''}${mo.pacs.length ? num(mo.pacs.length) + ' PAC' + (mo.pacs.length === 1 ? '' : 's') : ''}</h3>
          <p>${mo.pay.length ? num(mo.pay.length) + ' dated PAC payments to candidates and committees' : 'No dated PAC payments found'}${mo.lobby.length ? ', ' + num(mo.lobby.length) + ' lobbying report' + (mo.lobby.length === 1 ? '' : 's') : ''}. Lined up against this family’s control changes and permits below.</p>
          <a href="#fp-money" class="linkbtn">See the timeline ↓</a></article>`
        : `<article class="pat steel empty"><span class="eyebrow">MONEY TIMING · NOT PROOF</span><h3>No federal PAC or lobbying found</h3><p>${money ? 'Searched FEC and federal lobbying reports by company name; nothing matched exactly.' : 'Campaign donations and lobbying lined up against permits and enforcement.'}</p><p class="emptynote">State campaign finance and state lobbying: not collected yet</p></article>`}
        <article class="pat green"><span class="eyebrow">CREDIT WHERE IT’S DUE</span><h3>${credit.length ? num(credit.length) + ' mine' + (credit.length === 1 ? '' : 's') + ' in the best quarter' : 'No standout clean records yet'}</h3>
          <p>${credit.length ? 'Fewer citations per inspection than 75% of Harlan mines: ' + credit.slice(0, 3).map((x) => esc(x.properties.name)).join(', ') + (credit.length > 3 ? '…' : '') + '.' : 'Mines with low citation rates will show here.'}${cleanEpa.length ? ' ' + num(cleanEpa.length) + ' linked EPA site' + (cleanEpa.length === 1 ? ' has' : 's have') + ' zero quarters out of compliance.' : ''}</p></article>
      </section>
      ${timingHtml(mo, M, epaLinks)}
      ${(mo.awards.length || mo.cases.length) ? `<section class="fp-time"><h2 class="serif">Money and courts</h2>
        <p class="muted-s">Found by searching each company name. Counted only when the name matches exactly (ignoring LLC, Inc…); each award shows the recipient’s state.${mo.similar ? ' ' + num(mo.similar) + ' similar-name results were left out.' : ''} Check each record before relying on it.</p>
        ${mo.awards.length ? `<details open><summary>Federal money (${num(mo.awards.length)} largest awards)</summary><ol class="hist">${mo.awards.slice(0, 12).map((a) => `<li><b>${usd(a.amount)}</b> ${esc(a.group.replace(/s$/, ''))} · ${esc(a.agency || '')}<span class="when">${esc(a.recipient)}${a.state ? ' (' + esc(a.state) + ')' : ''} · ${esc(a.date || '')}${a.what ? ' · ' + esc(a.what) : ''} ${a.url ? `· <a href="${esc(a.url)}" target="_blank" rel="noopener">USAspending</a>` : ''}</span></li>`).join('')}</ol></details>` : ''}
        ${mo.cases.length ? `<details open><summary>Court dockets naming these companies (${num(mo.cases.length)} of the latest searched; ${num(mo.mentions)} more only mention the name)</summary><ol class="hist">${mo.cases.slice(0, 12).map((c) => `<li><b>${esc(c.case)}</b>${c.bankruptcy ? ' <span class="hot">bankruptcy court</span>' : ''}<span class="when">${esc(c.court || c.court_id)} · filed ${esc(c.filed || '?')}${c.nature ? ' · ' + esc(c.nature) : ''} ${c.url ? `· <a href="${esc(c.url)}" target="_blank" rel="noopener">docket</a>` : ''}</span></li>`).join('')}</ol></details>` : ''}
      </section>` : ''}
      ${parentsHtml(f, opList, isPerson)}
      ${stateMoneyHtml(f, opList, isPerson)}
      <section class="fp-time"><h2 class="serif">Who ran what, when</h2><p class="muted-s">Each bar is an operating company while this controller held it (MSHA controller records). Open bars are still running.</p>${timeline}</section>
      <p class="src">SOURCES: MSHA Controller/Operator History, Violations, Inspections, Production · EPA ECHO + ICIS-NPDES (inferred site links) · USAspending, FEC, lobbying reports, CourtListener, GLEIF, Kentucky Secretary of State (matched by name) · Kentucky mine permits · pulled ${esc(f.as_of)}. “Linked to” never means “did this.” Not legal advice. <a href="#how">How this works</a>.</p>
      ${recordActions('family', f.controller_id, isPerson ? leadCompany(opList.map((o) => o.name)) + ' mine family' : f.controller)}
    </div>`;
  }

  function regFamilyLetter(f, mines) {
    const ids = mines.map((x) => parse(x.properties.ids, {}).msha_mine).filter(Boolean);
    const key = 'L' + (++letterSeq);
    letters[key] = { to: AGENCIES.MSHA.to, law: AGENCIES.MSHA.law, subject: `FOIA request: MSHA records for controller ${f.controller} (ID ${f.controller_id})`,
      facts: f.viol && f.viol.due > 0 ? [`MSHA data lists ${usd(f.viol.due)} in assessed penalties at mines under this controller, of which ${usd(f.viol.paid)} is recorded as paid.`] : [],
      source: 'MSHA Open Government Data',
      items: [`Legal Identity Reports (MSHA Form 2000-7) and any ownership or control records naming controller ID ${f.controller_id} (${f.controller}).`,
        `Records showing the payment, delinquency and collection status of civil penalties assessed at mines under this controller, including any referrals for collection.`,
        `A list of all mines MSHA associates with this controller, with the dates of control.`],
      ids: ['MSHA controller ID ' + f.controller_id, ...ids.slice(0, 25).map((m) => 'mine ' + m), ids.length > 25 ? `and ${ids.length - 25} more mines` : null].filter(Boolean) };
    return key;
  }

  $('familyPage').addEventListener('click', (e) => {
    const a = e.target.closest('[data-asof]'); if (a) return renderFamilyPage(famState.cid, { asOf: a.dataset.asof, sel: famState.sel });
    const o = e.target.closest('[data-fpop]'); if (o) return renderFamilyPage(famState.cid, { asOf: famState.asOf, sel: 'o:' + o.dataset.fpop });
    const m = e.target.closest('[data-fpmine]'); if (m) return renderFamilyPage(famState.cid, { asOf: famState.asOf, sel: 'm:' + m.dataset.fpmine });
    const r = e.target.closest('[data-fpsel]'); if (r) return renderFamilyPage(famState.cid, { asOf: famState.asOf, sel: null });
    const lt = e.target.closest('[data-letter]'); if (lt) { location.hash = '#map'; pendingMap = () => showLetter(lt.dataset.letter); return; }
    const mp = e.target.closest('[data-fpmap]');
    if (mp) {
      const id = mp.dataset.fpmap;
      const fam = families[famState.cid];
      pendingMap = () => {
        if (id === '__all') {
          const pts = (fam.mines || []).map((x) => mineById[x.id]?.geometry.coordinates).filter(Boolean);
          if (pts.length) { const b = pts.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(pts[0], pts[0])); map.fitBounds(b, { padding: 60, maxZoom: 13 }); }
        } else { const f = mineById[id]; if (f) { map.flyTo({ center: f.geometry.coordinates, zoom: 13 }); showMine(f.properties); } }
      };
      location.hash = '#map';
    }
  });


  // Money timing: PAC payments + lobbying quarters + this family's own events on one time axis. Timing only, never proof.
  function timingHtml(mo, M, epaLinks) {
    if (!mo.pay.length && !mo.lobby.length) return '';
    const events = [];
    for (const o of Object.values(M.ops)) for (const m of Object.values(o.mines)) for (const p of m.periods) {
      if (p.start) events.push({ date: p.start, label: `${o.name} takes over ${m.feat.properties.name}` });
      if (p.end) events.push({ date: p.end, label: `${o.name} leaves ${m.feat.properties.name}` });
    }
    for (const e of epaLinks) for (const pm of e.permits || []) if (pm.expiration) events.push({ date: pm.expiration, label: `Water permit ${pm.id} ${pm.status_code === 'EXP' ? 'expired' : 'expires'}`, hot: pm.status_code === 'EXP' });
    const lob = mo.lobby.map((x) => ({ date: `${x.year}-${({ 'First Quarter (Q1)': '02', 'Second Quarter (Q2)': '05', 'Third Quarter (Q3)': '08', 'Fourth Quarter (Q4)': '11' })[x.period] || '06'}-15`, ...x }));
    const all = [...mo.pay.map((x) => x.date), ...lob.map((x) => x.date), ...events.map((x) => x.date)].filter(Boolean).sort();
    const y0 = Math.max(+(all[0] || '2008').slice(0, 4), 2000), y1 = new Date().getFullYear() + 1;
    const W = 1000, X = (d) => 40 + ((+d.slice(0, 4) + (+d.slice(5, 7) - 1) / 12 - y0) / (y1 - y0)) * (W - 60);
    const maxAmt = Math.max(1, ...mo.pay.map((x) => +x.amount || 0));
    const ticks = []; for (let y = y0; y <= y1; y += y1 - y0 > 14 ? 4 : 2) ticks.push(y);
    const inRange = (d) => d && +d.slice(0, 4) >= y0;
    const svg = `<svg class="tchart" viewBox="0 0 ${W} 190" role="img" aria-label="Timeline of PAC payments, lobbying reports and this family's events">
      ${ticks.map((y) => `<line x1="${X(y + '-01-01')}" x2="${X(y + '-01-01')}" y1="18" y2="178" stroke="#1F242D"/><text x="${X(y + '-01-01')}" y="12" fill="#8B929C" font-size="10" text-anchor="middle" font-family="JetBrains Mono, monospace">${y}</text>`).join('')}
      <text x="4" y="52" fill="#E3A44E" font-size="10" font-family="Inter">PAC $</text><text x="4" y="104" fill="#9CC6D8" font-size="10" font-family="Inter">Lobby</text><text x="4" y="154" fill="#ECE9E2" font-size="10" font-family="Inter">Events</text>
      ${mo.pay.filter((x) => inRange(x.date)).map((x) => `<circle cx="${X(x.date)}" cy="50" r="${3 + 9 * Math.sqrt((+x.amount || 0) / maxAmt)}" fill="#E3A44E" fill-opacity=".55"><title>${esc(x.date)} · ${usd(x.amount)} to ${esc(x.recipient)} (${esc(x.pac)})</title></circle>`).join('')}
      ${lob.filter((x) => inRange(x.date)).map((x) => `<rect x="${X(x.date) - 4}" y="92" width="8" height="18" rx="2" fill="#86B6CC" fill-opacity=".8"><title>${esc(x.year)} ${esc(x.period || '')} · ${x.amount ? usd(x.amount) : 'amount not reported'} · ${esc(x.registrant || '')} · ${esc((x.issues || []).join(', '))}</title></rect>`).join('')}
      ${events.filter((x) => inRange(x.date)).map((x) => `<line x1="${X(x.date)}" x2="${X(x.date)}" y1="140" y2="168" stroke="${x.hot ? '#EE7D67' : '#ECE9E2'}" stroke-width="2"><title>${esc(x.date)} · ${esc(x.label)}</title></line>`).join('')}
    </svg>`;
    const byRecipient = {};
    for (const x of mo.pay) { const k = x.recipient || 'Unknown'; byRecipient[k] = (byRecipient[k] || 0) + (+x.amount || 0); }
    const topRec = Object.entries(byRecipient).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const issues = {}; for (const x of mo.lobby) for (const i of x.issues || []) issues[i] = (issues[i] || 0) + 1;
    const firms = [...new Set(mo.lobby.map((x) => x.registrant).filter(Boolean))];
    return `<section class="fp-time" id="fp-money"><h2 class="serif">Money timing</h2>
      <p class="muted-s">PAC payments (amber, sized by amount), federal lobbying reports (blue) and this family’s own events (white; coral = expired permit) on one timeline. Hover any mark for details. <b>Timing is not proof</b> of any connection.</p>
      <div class="tchart-wrap">${svg}</div>
      <div class="fp-two">
        ${topRec.length ? `<div><h3 class="fp-sub">Where the PAC money went</h3><ol class="hist">${topRec.map(([r, a]) => `<li><b>${esc(r)}</b><span class="when">${usd(a)} in recent cycles</span></li>`).join('')}</ol>
          <p class="note">From the PAC’s own FEC reports. Recipients are candidates and political committees, in their public roles.</p></div>` : ''}
        ${mo.lobby.length ? `<div><h3 class="fp-sub">What they lobbied on</h3><ol class="hist">${Object.entries(issues).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([i, n]) => `<li><b>${esc(i)}</b><span class="when">${num(n)} report${n === 1 ? '' : 's'}</span></li>`).join('')}</ol>
          <p class="note">Lobbying firms: ${firms.slice(0, 5).map(esc).join(', ')}${firms.length > 5 ? '…' : ''}. Source: federal Lobbying Disclosure Act reports (lda.gov), matched by exact client name.</p></div>` : ''}
      </div></section>`;
  }

  // ---- Fair comparisons
  function fairHtml(f) {
    if (!f || (!f.per_inspection && !f.per_100k_tons)) return f ? `<p class="note">Not enough inspections or production on record (2000 on) to compare this mine fairly.</p>` : '';
    const line = (rate, pct, n, unit) => `<div class="row"><span class="lbl">Citations ${unit}</span><span><b>${rate}</b> · <span class="${pct >= 75 ? 'hot' : pct <= 25 ? 'good' : ''}">higher than ${pct}% of ${n} Harlan mines</span></span></div>`;
    return `<div class="fair"><p class="eyebrow">FAIR COMPARISON · ${esc(f.window.toUpperCase())}</p>
      ${f.per_inspection != null ? line(f.per_inspection, f.per_inspection_pct, f.per_inspection_n, 'per inspection') : ''}
      ${f.per_100k_tons != null ? line(f.per_100k_tons, f.per_100k_tons_pct, f.per_100k_tons_n, 'per 100,000 tons mined') : ''}
      <p class="note">${num(f.citations_2000)} citations over ${num(f.inspections)} inspections${f.tons ? ' and ' + num(f.tons) + ' tons' : ''}. Rates, not raw counts, so big old mines and small new ones compare fairly.</p></div>`;
  }

  // ---- Research links (search by name: results must be checked, never assumed)
  function researchHtml(name, type) {
    if (!name || isPersonCtl(name, type)) return '';
    const q = encodeURIComponent(name);
    return `<details><summary>Look this company up</summary><ul class="mines-list">
      <li><a class="rlink" href="https://www.sec.gov/cgi-bin/browse-edgar?company=${q}&owner=include&count=40" target="_blank" rel="noopener">SEC EDGAR filings (public companies, subsidiaries)</a></li>
      <li><a class="rlink" href="https://opencorporates.com/companies?q=${q}" target="_blank" rel="noopener">OpenCorporates (state and foreign registries)</a></li>
      <li><a class="rlink" href="https://search.gleif.org/#/search/simpleSearch=${q}" target="_blank" rel="noopener">GLEIF (global legal entities and parents)</a></li>
      <li><a class="rlink" href="https://www.courtlistener.com/?q=%22${q}%22" target="_blank" rel="noopener">CourtListener (lawsuits and bankruptcies)</a></li>
    </ul><p class="note">These search by name, so a result may be a different company with a similar name. Match addresses, officers or ID numbers before relying on one.</p></details>`;
  }

  // ---- Open EJ Score: our own open formula (NOT EPA's EJScreen). Score = Σ(weight × percentile) ÷ Σ weights,
  // over the ingredients available for that neighborhood. Weights live in this browser only.
  const EJ_ING = [
    { k: 'sites', name: 'Problem sites nearby', src: 'EPA sites with silence flags (high counts double), inside or within a mile', c: '#EE7D67' },
    { k: 'exceed', name: 'Discharges over permit limits', src: 'EPA discharge reports over limits, last 3 years', c: '#E3A44E' },
    { k: 'tri_lbs', name: 'Toxic releases (pounds)', src: 'EPA TRI, latest year, factories reporting in the last 3 years', c: '#C39BD3' },
    { k: 'mine_cit', name: 'Mine safety citations', src: 'MSHA citations at mines, last 5 years', c: '#D9963F' },
    { k: 'water', name: 'Drinking-water violations', src: 'Health-based violations (5 yrs) of the water systems whose service area covers it', c: '#4FC3D3' },
    { k: 'vuln', name: 'Vulnerability (income, age)', src: 'Census ACS 5-yr: below 2× poverty, under 5, over 64 (vs. the whole state)', c: '#86B6CC' },
  ];
  const EJ_PRESETS = { Balanced: { sites: 3, exceed: 3, tri_lbs: 2, mine_cit: 2, water: 3, vuln: 3 }, 'Water first': { sites: 1, exceed: 5, tri_lbs: 1, mine_cit: 0, water: 5, vuln: 2 }, 'Mining first': { sites: 2, exceed: 2, tri_lbs: 0, mine_cit: 5, water: 1, vuln: 2 } };
  let ejW = (() => { try { return JSON.parse(localStorage.getItem('pcf.ejw')) || { ...EJ_PRESETS.Balanced }; } catch (e) { return { ...EJ_PRESETS.Balanced }; } })();
  let ejSel = null;
  function ejOne(p) {
    const pct = typeof p.pct === 'string' ? JSON.parse(p.pct) : p.pct || {};
    let sw = 0, s = 0; const parts = [];
    for (const g of EJ_ING) {
      const v = pct[g.k], w = ejW[g.k] || 0;
      if (v == null) { parts.push({ ...g, v: null, w, contrib: 0 }); continue; }
      sw += w; s += w * v; parts.push({ ...g, v, w });
    }
    for (const x of parts) x.contrib = sw && x.v != null ? (x.w * x.v) / sw : 0;
    return { score: sw ? Math.round(s / sw) : null, parts };
  }
  function ejScore() {
    if (!ejData) return;
    for (const f of ejData.features) f.properties.score = ejOne(f.properties).score;
    if (map.getSource && map.getSource('ej')) map.getSource('ej').setData(ejData);
  }
  function ejPanelHtml() {
    const preset = Object.entries(EJ_PRESETS).find(([, v]) => EJ_ING.every((g) => (v[g.k] || 0) === (ejW[g.k] || 0)))?.[0];
    return `<div class="ejpanel"><div class="ejrow"><b>What counts, and how much</b><button type="button" class="linkbtn" data-ejpreset="Balanced">Reset</button></div>
      <div class="ejpresets">${Object.keys(EJ_PRESETS).map((k) => `<button type="button" class="pbadge ${k === preset ? 'open' : ''}" data-ejpreset="${esc(k)}">${esc(k)}</button>`).join('')}</div>
      ${EJ_ING.map((g) => `<div class="ejw"><label for="ejw-${g.k}"><span>${esc(g.name)}</span><b>${ejW[g.k] || 0}</b></label>
        <input type="range" id="ejw-${g.k}" min="0" max="5" step="1" value="${ejW[g.k] || 0}" data-ejw="${g.k}"><span class="when">${esc(g.src)}</span></div>`).join('')}
      <p class="mono-s">score = Σ (weight × percentile) ÷ Σ weights, over what’s available for that area</p>
      <div class="ejlegend">${[['#1E2630', '0–20'], ['#33505E', '20–40'], ['#7E8A6A', '40–60'], ['#D9963F', '60–80'], ['#EE7D67', '80–100']].map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('')}</div></div>`;
  }
  function ejNote() {
    return `<div class="ejnote"><p class="eyebrow">READ THIS FIRST</p><ul>
      <li>It counts records near people, not exposure or illness. Same place does not mean cause.</li>
      <li>Census numbers are estimates with margins of error; small areas swing.</li>
      <li>Missing data is shown as missing, never as zero.</li>
      <li>Our own open formula. Not EPA’s EJScreen.</li></ul></div>`;
  }
  function showEJPanel() {
    show(`<p class="eyebrow">OPEN EJ SCORE · BY CENSUS BLOCK GROUP</p><h2 class="card-title">Where the burden piles up</h2>
      <p class="muted-s">Pollution and enforcement records plus Census conditions, one score per neighborhood. Drag a weight and the map redraws. Click any area to see how its score is built.</p>
      ${ejPanelHtml()}${ejNote()}`);
  }
  function showEJ(geoid) {
    const f = ejData?.features.find((x) => x.properties.geoid === geoid); if (!f) return;
    ejSel = geoid;
    const p = f.properties, r = ejOne(p);
    const peers = ejData.features.filter((x) => x.properties.area === p.area && x.properties.score != null);
    const below = peers.filter((x) => x.properties.score < r.score).length;
    const raw = p.raw || {};
    const rawTxt = { sites: `${num(p.n_sites || 0)} flagged site${p.n_sites === 1 ? '' : 's'}`, exceed: `${num(raw.exceed || 0)} readings over limit`, tri_lbs: `${num(raw.tri_lbs || 0)} lbs`, mine_cit: `${num(raw.mine_cit || 0)} citations (weighted)`, water: (p.water_systems && (typeof p.water_systems === 'string' ? JSON.parse(p.water_systems) : p.water_systems).length) ? (typeof p.water_systems === 'string' ? JSON.parse(p.water_systems) : p.water_systems).map((w) => `${w.name}: ${w.health_last5} health-based`).join('; ') : 'no matched water system',
      vuln: p.low_income_pct != null ? `${p.low_income_pct}% low income · ${p.age_pct}% under 5 or over 64` : 'no Census estimate' };
    show(`<p class="eyebrow">OPEN EJ SCORE · ${esc(p.county)}</p>
      <h2 class="card-title">${esc(p.name)}</h2>
      <div class="ejbig"><span>${r.score == null ? '—' : r.score}</span><small>/ 100</small></div>
      <p class="muted-s">${r.score == null ? 'Not enough data to score this area.' : `Higher than ${Math.round((below / Math.max(1, peers.length)) * 100)}% of block groups in ${esc(p.county)} with these weights.`} About ${num(p.pop)} people (Census estimate).</p>
      <h3 class="fp-sub">How this score is built</h3>
      <div class="ejparts">${r.parts.map((x) => `<div class="ejpart"><span>${esc(x.name)}${x.v == null ? ' <i class="muted-s">(not available)</i>' : x.w === 0 ? ' <i class="muted-s">(weight 0)</i>' : ''}</span>
        <span class="ejbar"><i style="width:${Math.max(x.contrib ? 1 : 0, Math.round(x.contrib))}%;background:${x.c}"></i></span>
        <span class="mono-s">${x.v == null ? '—' : x.v + 'th pct'} · ${esc(rawTxt[x.k])}</span></div>`).join('')}</div>
      <div class="btns"><button type="button" class="btn" data-ejadjust="1">Adjust weights</button>${packBtn('ej', { ...p, score: r.score, weights: { ...ejW } }, p.name + ' · ' + p.county + ' (Open EJ Score)')}</div>
      ${ejNote()}
      <p class="src">SOURCES: US Census ACS ${esc(p.acs_year)} 5-year estimates (<a href="${esc(p.census_url)}" target="_blank" rel="noopener">Census profile</a>) and TIGER block groups; EPA ECHO, ICIS-NPDES and TRI; MSHA. Records count fully inside the area and half within a mile of it; record percentiles are within the county, Census percentiles within the state. Pulled ${esc(p.as_of)}.</p>`);
  }
  document.addEventListener('input', (e) => {
    const k = e.target.dataset?.ejw; if (!k) return;
    ejW = { ...ejW, [k]: Number(e.target.value) };
    try { localStorage.setItem('pcf.ejw', JSON.stringify(ejW)); } catch (err) {}
    e.target.closest('.ejw').querySelector('b').textContent = e.target.value;
    ejScore();
  });
  document.addEventListener('click', (e) => {
    const pr = e.target.closest('[data-ejpreset]');
    if (pr) { ejW = { ...EJ_PRESETS[pr.dataset.ejpreset] }; try { localStorage.setItem('pcf.ejw', JSON.stringify(ejW)); } catch (err) {} ejScore(); ejSel ? showEJ(ejSel) : showEJPanel(); return; }
    if (e.target.closest('[data-ejadjust]')) showEJPanel();
  });

  // ---- Evidence packs: a zip of exactly what's shown, the records behind it, and how to verify each one.
  const packs = {}; let packSeq = 0;
  function packBtn(kind, p, title) {
    const key = 'P' + (++packSeq);
    packs[key] = { kind, p, title };
    return `<button type="button" class="btn" data-pack="${key}">Download evidence pack ⤓</button>`;
  }
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zipStore(files) { // files: [{name, data: Uint8Array}] -> Blob (ZIP, no compression)
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    const d = new Date(), dt = ((d.getFullYear() - 1980) << 25) | ((d.getMonth() + 1) << 21) | (d.getDate() << 16) | (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), n = f.data.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint32(10, dt, true); h.setUint32(14, crc, true); h.setUint32(18, n, true); h.setUint32(22, n, true); h.setUint16(26, name.length, true);
      parts.push(new Uint8Array(h.buffer), name, f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint32(12, dt, true); c.setUint32(16, crc, true); c.setUint32(20, n, true); c.setUint32(24, n, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + n;
    }
    const cs = central.reduce((a, x) => a + x.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cs, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
  }
  async function sha256hex(u8) {
    const h = await crypto.subtle.digest('SHA-256', u8);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const deep = (v) => { if (typeof v === 'string' && /^[\[{]/.test(v)) { try { return deep(JSON.parse(v)); } catch (e) { return v; } } if (Array.isArray(v)) return v.map(deep); if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = deep(x); return o; } return v; };
  function archivedFor(kind, rec) {
    const files = archiveIdx?.files || [];
    const pick = (fn) => files.filter(fn);
    const permitIds = new Set([...(rec.permits || []), ...(rec.epa || []).flatMap((e) => e.permits || [])].map((x) => x.id));
    const want = [];
    if (kind === 'mine' || kind === 'family' || kind === 'ej') want.push(...pick((f) => f.source === 'msha'));
    if (kind === 'ej') want.push(...pick((f) => ['census-tiger', 'echo', 'epa-npdes', 'epa-tri-basic'].includes(f.source)));
    if (kind === 'facility' || kind === 'mine' || kind === 'family') {
      want.push(...pick((f) => f.source === 'epa-npdes'));
      want.push(...pick((f) => f.source === 'epa-effluent' && [...permitIds].some((id) => f.file === `effluent-${id}.csv`)));
    }
    if (kind === 'facility') want.push(...pick((f) => f.source === 'echo'));
    if (kind === 'tri' || rec.tri) want.push(...pick((f) => f.source === 'envirofacts' && /^tri-/.test(f.file)), ...pick((f) => f.source === 'epa-tri-basic'));
    if ((rec.ky_permits || []).length || kind === 'family') want.push(...pick((f) => f.source === 'ky-mine-permits'));
    if ((rec.pending || []).length) want.push(...pick((f) => f.source === 'ky-esearch'));
    if (kind === 'family') {
      want.push(...pick((f) => f.source === 'gleif' && (rec.leis || []).some((l) => f.file === `lei-${l}.json`)));
      want.push(...pick((f) => f.source === 'ky-sos' && (rec.registry_files || []).some((n) => f.file.startsWith(n.replace(/\.html$/, '')))));
    }
    return [...new Map(want.map((f) => [f.path, f])).values()];
  }
  function liveSources(kind, rec) {
    const out = [];
    const add = (what, url, when) => url && out.push({ what, url, when: when || '' });
    add('Record page', rec.source_url, rec.as_of);
    for (const e of rec.epa || []) add(`EPA facility report: ${e.name}`, e.source_url, '');
    for (const pm of rec.permits || []) if (pm.exceed?.url) add(`EPA effluent charts: ${pm.id}`, pm.exceed.url, '');
    for (const i of rec.pending || []) add(`State pending action: ${i.name}`, i.url, i.stage_date);
    for (const a of rec.money_awards || []) add(`USAspending: ${a.recipient}`, a.url, a.date);
    for (const c of rec.court_cases || []) add(`Court docket: ${c.case}`, c.url, c.filed);
    for (const r of rec.registry || []) add(`Kentucky business record: ${r.legal_name}`, r.url, r.pulled);
    for (const l of rec.lei_records || []) add(`GLEIF: ${l.legal_name}`, l.url, '');
    return out;
  }
  async function buildPack(key) {
    const P = packs[key]; if (!P) return;
    const shown = (P.kind === 'family' ? $('familyPage') : $('detailBody')).cloneNode(true);
    shown.querySelectorAll('button, textarea, .btns').forEach((x) => x.remove());
    const rec = deep(P.p);
    if (P.kind === 'family') {
      const names = [rec.controller, ...(rec.operators || []).map((o) => o.name)];
      const lei = leiFor(names), reg = regFor(names), mo = moneyFor(names);
      rec.mines_records = (rec.mines || []).map((m) => mineById[m.id] ? deep(mineById[m.id].properties) : m);
      rec.epa = rec.mines_records.flatMap((m) => m.epa || []);
      rec.lei_records = lei.map((x) => x.e); rec.leis = rec.lei_records.flatMap((e) => [e.lei, e.direct_parent?.lei, e.ultimate_parent?.lei].filter(Boolean));
      rec.registry = reg.map((x) => x.r); rec.registry_files = rec.registry.flatMap((r) => r.archived || []);
      rec.money_awards = mo.awards; rec.court_cases = mo.cases; rec.pacs = mo.pacs; rec.lobbying = mo.lobby;
    }
    const arch = archivedFor(P.kind, rec), live = liveSources(P.kind, rec);
    const made = new Date().toISOString();
    const enc = new TextEncoder();
    const recordsJson = enc.encode(JSON.stringify({ pack: { kind: P.kind, title: P.title, made_utc: made, data_pulled: meta.pulled, site: location.origin + location.pathname },
      record: rec, archived_originals: arch, archive_release: archiveIdx?.release || null }, null, 1));
    const packId = (await sha256hex(recordsJson)).slice(0, 16);
    const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const sourcesCsv = enc.encode(['kind,description,url_or_path,pulled_utc,sha256,bytes',
      ...arch.map((f) => ['archived original', `${f.source}/${f.file} (from ${f.url})`, f.path, f.pulled_utc, f.sha256, f.bytes].map(csvEsc).join(',')),
      ...live.map((x) => ['live source', x.what, x.url, x.when, '', ''].map(csvEsc).join(','))].join('\n'));
    const rel = archiveIdx?.release;
    const summary = enc.encode(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Evidence pack: ${esc(P.title)}</title>
<style>body{font:15px/1.5 Georgia,serif;max-width:860px;margin:32px auto;padding:0 20px;color:#111}h1{font-size:26px;margin:0 0 4px}.meta{font:12px/1.6 monospace;color:#444;border:1px solid #ccc;padding:10px 12px;border-radius:6px;margin:12px 0 24px}
.shown{border-top:2px solid #111;padding-top:12px}.shown *{color:#111!important;background:none!important;border-color:#bbb!important}.shown .hot{color:#a1260f!important;font-weight:600}.shown svg{display:none}
.row{display:flex;gap:12px;justify-content:space-between;border-bottom:1px solid #eee;padding:4px 0}.lbl{color:#555!important}table{border-collapse:collapse;width:100%;font:12px monospace}td,th{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top;word-break:break-all}
@media print{a{color:#111}}</style></head><body>
<h1>Evidence pack: ${esc(P.title)}</h1>
<div class="meta">Pack ID ${packId} · made ${made} · data pulled ${esc(meta.pulled || '?')} · from The People's Case (${esc(location.origin + location.pathname)})<br>
Everything below is what the site showed, built only from public records. “Linked to” never means “did this”. Flags are questions to ask, not findings of wrongdoing. Not legal advice.</div>
<div class="shown">${shown.innerHTML}</div>
<h2>Archived originals behind this record</h2>
<p>Unmodified copies saved when the data was pulled, each with its SHA-256 fingerprint. They are inside ${rel ? `<a href="${esc(rel.download)}">${esc(rel.asset)}</a> in the public release <a href="${esc(rel.page)}">${esc(rel.tag)}</a>` : 'the monthly archive release'}.</p>
<table><tr><th>File (path in archive)</th><th>Original source</th><th>Pulled (UTC)</th><th>SHA-256</th></tr>${arch.map((f) => `<tr><td>${esc(f.path)}</td><td>${esc(f.url)}</td><td>${esc(f.pulled_utc)}</td><td>${esc(f.sha256)}</td></tr>`).join('') || '<tr><td colspan="4">None archived on this pull date for this record; see live sources.</td></tr>'}</table>
<h2>Live sources</h2><table><tr><th>What</th><th>Link</th><th>Date</th></tr>${live.map((x) => `<tr><td>${esc(x.what)}</td><td><a href="${esc(x.url)}">${esc(x.url)}</a></td><td>${esc(x.when)}</td></tr>`).join('')}</table>
<h2>How to verify</h2><ol><li>Download the archive release above and extract it (join .part files first if it was split).</li><li>Run <code>sha256sum</code> on each file listed and compare with the fingerprints here.</li><li>Check SHA256SUMS.txt in this pack against the pack's own files.</li><li>Re-open each live source; agency records can change after the pull date.</li></ol>
</body></html>`);
    const readme = enc.encode(`The People's Case: evidence pack ${packId}\n\n${P.title}\nMade ${made}. Data pulled ${meta.pulled || '?'}.\n\nFiles:\n  summary.html   what the site showed, printable, with every source\n  records.json   the exact records behind it (machine-readable)\n  sources.csv    archived originals (path, original URL, pull time, SHA-256) and live sources\n  SHA256SUMS.txt fingerprints of the files in this pack\n\nArchived originals: ${rel ? rel.page : 'monthly GitHub release'}\n${rel ? rel.note : ''}\n\nPublic records only. "Linked to" never means "did this". Not legal advice.\n`);
    const files = [{ name: 'README.txt', data: readme }, { name: 'summary.html', data: summary }, { name: 'records.json', data: recordsJson }, { name: 'sources.csv', data: sourcesCsv }];
    const sums = [];
    for (const f of files) sums.push(`${await sha256hex(f.data)}  ${f.name}`);
    files.push({ name: 'SHA256SUMS.txt', data: enc.encode(sums.join('\n') + '\n') });
    const slug = P.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zipStore(files));
    a.download = `evidence-${slug}-${(meta.pulled || made).slice(0, 10)}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    return { packId, archived: arch.length, live: live.length };
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pack]'); if (!b) return;
    const old = b.textContent; b.textContent = 'Building…';
    buildPack(b.dataset.pack).then(() => { b.textContent = 'Downloaded ✓'; setTimeout(() => (b.textContent = old), 2500); }, (err) => { console.error(err); b.textContent = 'Could not build pack'; });
  });

  // ---- Records-request letters (open records / FOIA). Drafts only, not legal advice.
  const AGENCIES = {
    KY: { water: { to: 'Kentucky Energy and Environment Cabinet, Department for Environmental Protection, Division of Water', law: 'the Kentucky Open Records Act, KRS 61.870 to 61.884' },
          drink: { to: 'Kentucky Energy and Environment Cabinet, Division of Water, Drinking Water Branch', law: 'the Kentucky Open Records Act, KRS 61.870 to 61.884' } },
    MI: { water: { to: 'Michigan Department of Environment, Great Lakes, and Energy (EGLE), Water Resources Division', law: 'the Michigan Freedom of Information Act, MCL 15.231 et seq.' },
          drink: { to: 'Michigan Department of Environment, Great Lakes, and Energy (EGLE), Drinking Water and Environmental Health Division', law: 'the Michigan Freedom of Information Act, MCL 15.231 et seq.' } },
    MSHA: { to: 'U.S. Department of Labor, Mine Safety and Health Administration (MSHA), FOIA Office', law: 'the Freedom of Information Act, 5 U.S.C. § 552' },
  };
  let letterSeq = 0;
  const since = () => String(new Date().getFullYear() - 5) + '-01-01';
  function stateOf(coords, permits) {
    const pid = (permits && permits[0] && permits[0].id) || '';
    if (/^MI/.test(pid)) return 'MI'; if (/^KY/.test(pid)) return 'KY';
    return coords && coords[1] > 40 ? 'MI' : 'KY';
  }
  function regFacilityLetter(e, mineIds) {
    const permits = e.permits || [];
    const codes = new Set((e.flags || []).map((f) => f.code));
    const st = stateOf(e.coords || (mineIds ? [0, 36.9] : null), permits);
    const ag = AGENCIES[st].water;
    const pids = permits.map((x) => x.id);
    const items = [
      `All inspection reports, compliance evaluations and site-visit records for this facility${pids.length ? ' and permit ' + pids.join(', ') : ''} from ${since()} to the present.`,
      `All notices of violation, warning letters and correspondence between the agency and the permittee in that period.`,
    ];
    if (codes.has('serious_no_enforcement') || codes.has('violations_no_penalty') || codes.has('warnings_only')) items.push('Any records documenting enforcement decisions for this facility, including any decision not to pursue formal enforcement or penalties.');
    if (pids.length) items.push(`Discharge Monitoring Reports and noncompliance reports submitted under permit ${pids.join(', ')} from ${since()} to the present.`);
    const exc = permits.filter((x) => x.exceed?.exceedances);
    if (exc.length) items.push(`Records of the agency's review of, and response to, the reported permit limit exceedances (${exc.map((x) => x.exceed.parameters.slice(0, 3).map((y) => y.name).join(', ')).join('; ')}) from ${since()} to the present.`);
    if ((e.flags || []).some((f) => f.code === 'not_inspected' || f.code === 'no_inspection_record')) items.push('Any inspection schedule, targeting list or record explaining why this facility has not been inspected in that period.');
    if (codes.has('expired_permit')) items.push('Records showing the status of the permit renewal, including any renewal application, and any authorization to discharge after the permit expiration date.');
    items.push('Records identifying the current permittee and operator, and any transfer of the permit.');
    const key = 'L' + (++letterSeq);
    letters[key] = { to: ag.to, law: ag.law, subject: `Records request: ${e.name}${pids.length ? ' (permit ' + pids.join(', ') + ')' : ''}`,
      facts: (e.flags || []).map((f) => f.evidence), source: 'EPA ECHO and ICIS-NPDES public data', items,
      ids: [e.frs ? 'EPA FRS ID ' + e.frs : null, ...pids.map((x) => 'NPDES permit ' + x)].filter(Boolean) };
    return key;
  }
  function regBondLetter(p, ids) {
    const key = 'L' + (++letterSeq);
    const permits = parse(p.ky_permits, []).map((r) => r.permit);
    letters[key] = { to: 'Kentucky Energy and Environment Cabinet, Department for Natural Resources, Division of Mine Permits and Division of Mine Reclamation and Enforcement', law: 'the Kentucky Open Records Act, KRS 61.870 to 61.884',
      source: 'MSHA and Kentucky Division of Mine Permits', ids: [`MSHA mine ID ${ids.msha_mine}`, ...permits.map((x) => 'Kentucky permit ' + x)],
      subject: `Records request: reclamation bonds for ${p.name}${permits.length ? ' (KY permits ' + permits.join(', ') + ')' : ''}`,
      facts: [`MSHA mine ID ${ids.msha_mine}${p.operator ? ', operator ' + p.operator : ''}.`, permits.length ? `The mine sits inside Kentucky mine permit area(s) ${permits.join(', ')} (Division of Mine Permits boundary data).` : null].filter(Boolean),
      items: ['The current reclamation bond amount for each permit and increment, the bond type (surety, cash, self-bond or bond pool), and the surety company.',
        'Any bond increases, reductions, partial releases (Phase I, II, III) and their dates.',
        'Any notice of bond forfeiture, forfeiture orders, and the amount collected.',
        'The cabinet’s most recent estimate of the cost to reclaim each permit area, and any reclamation contracts paid from forfeited bonds or the bond pool.'] };
    return key;
  }
  function regMineLetter(p, ids, v) {
    const items = [
      `All inspection reports, citations and orders for mine ID ${ids.msha_mine} (${p.name}) from ${since()} to the present.`,
      `Legal Identity Reports (MSHA Form 2000-7) on file for this mine, showing the operator and controlling entities.`,
    ];
    const facts = [];
    if (v && v.due > 0) {
      facts.push(`MSHA data lists ${usd(v.due)} in assessed penalties at this mine, of which ${usd(v.paid)} is recorded as paid.`);
      items.push('Records showing the payment, delinquency and collection status of civil penalties assessed for this mine, including any referrals for collection.');
    }
    const key = 'L' + (++letterSeq);
    letters[key] = { to: AGENCIES.MSHA.to, law: AGENCIES.MSHA.law, subject: `FOIA request: MSHA records for mine ID ${ids.msha_mine}`,
      facts, source: 'MSHA Open Government Data', items, ids: ['MSHA mine ID ' + ids.msha_mine, ids.msha_controller ? 'MSHA controller ID ' + ids.msha_controller : null].filter(Boolean) };
    return key;
  }
  function regWaterLetter(sy, area) {
    const st = area === 'flint-mi' ? 'MI' : 'KY';
    const ag = AGENCIES[st].drink;
    const items = [
      `All violation notices, compliance orders and enforcement records for public water system ${sy.pwsid} (${sy.name}) from ${since()} to the present.`,
      'All lead and copper sampling results, sample site lists and lead service line inventories for this system.',
      'All public notices issued to customers of this system in that period.',
    ];
    const key = 'L' + (++letterSeq);
    letters[key] = { to: ag.to, law: ag.law, subject: `Records request: water system ${sy.name} (PWSID ${sy.pwsid})`,
      facts: [`EPA's Safe Drinking Water data lists ${sy.health_last5} health-based violations for this system in the last 5 years${sy.lead_copper ? ' and ' + sy.lead_copper + ' under the Lead and Copper Rule' : ''}.`],
      source: 'EPA Safe Drinking Water Information System', items, ids: ['PWSID ' + sy.pwsid] };
    return key;
  }
  function commentLetter(item, facts, extraIds) {
    const key = 'L' + (++letterSeq);
    letters[key] = { kind: 'comment', to: item.comment_to ? `Kentucky Division of Water, Surface Water Permits Branch (${item.comment_to})` : (item.id.startsWith('MI') ? 'Michigan EGLE, through the comment button on the MiEnviro Portal notice' : 'The agency named in the public notice'),
      subject: `Public comment: ${item.name}${item.type ? ' (' + item.type + ')' : ''}`, item, facts: facts || [], ids: [item.agency_id ? 'Agency Interest ID ' + item.agency_id : null, item.ky_mine_permit ? 'Kentucky mine permit ' + item.ky_mine_permit : null, ...(extraIds || [])].filter(Boolean) };
    return key;
  }
  function letterText(L) {
    const today = new Date().toISOString().slice(0, 10);
    if (L.kind === 'comment') {
      const it = L.item;
      return `[Your name]\n[Your mailing address or email]\n[Optional: how you are affected, e.g. you live downstream or get water from this area]\n\n${today}\n\nTo: ${L.to}\n\nRe: ${L.subject}\n${L.ids.length ? 'Identifiers: ' + L.ids.join('; ') + '\n' : ''}\nI submit these comments on the pending ${it.type || 'action'} for ${it.name}${it.town ? ' (' + it.town + ')' : ''}.\n\n${L.facts.length ? `Public records for the same site (inside the same state mine permit area; the companies named may differ from the applicant) show:\n${L.facts.map((x) => '- ' + x).join('\n')}\n\n` : ''}I ask the agency to:\n1. Hold a public hearing in the community before deciding.\n2. ${L.facts.length ? 'Explain in writing how the permit will prevent a repeat of the violations above, and what limits, monitoring and enforcement it includes.' : 'Explain in writing what limits, monitoring and enforcement the permit includes.'}\n3. Make the draft permit, fact sheet and the company's compliance history available online for the full comment period.\n4. Respond in writing to these comments and notify me of the final decision.\n\nThank you,\n[Your name]`;
    }
    return `[Your name]\n[Your mailing address or email]\n\n${today}\n\nTo: ${L.to}\n\nRe: ${L.subject}\n\nUnder ${L.law}, I request copies of the following public records:\n\n${L.items.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n${L.facts.length ? `For context, public data (${L.source}) shows:\n${L.facts.map((x) => '- ' + x).join('\n')}\n\n` : ''}Identifiers: ${L.ids.join('; ')}.\n\nI prefer electronic copies. If any part of this request is denied, please cite the specific exemption and release all parts that are not exempt. I ask that fees be waived because the records will be used to inform the public about environmental and public-health conditions; if fees will exceed $25, please tell me before proceeding.\n\nThank you,\n[Your name]`;
  }
  function showLetter(key) {
    const L = letters[key]; if (!L) return;
    const text = letterText(L);
    const isC = L.kind === 'comment';
    show(`<p class="eyebrow">${isC ? 'PUBLIC COMMENT · DRAFT' : 'RECORDS REQUEST · DRAFT'}</p>
      <h2 class="card-title">${isC ? 'Weigh in before they decide' : 'Ask the agency'}</h2>
      <p class="muted-s">${isC ? `Comments count only while the comment period is open. Check the official notice for the deadline and where to send it${L.item.url ? ` (<a href="${esc(L.item.url)}" target="_blank" rel="noopener">official record</a>)` : ''}. Add how it affects you, in your own words; that matters most.` : 'Fill in your name and contact, check the agency’s current records-request address or online portal, then send. Agencies must answer within deadlines set by law (often 5 business days for Kentucky and Michigan, 20 working days for federal FOIA).'}</p>
      <textarea id="letterBox" class="letter" rows="18" aria-label="Letter text">${esc(text)}</textarea>
      <div class="btns"><button type="button" class="btn primary" id="copyLetter">Copy letter</button><button type="button" class="btn" id="dlLetter">Download .txt</button></div>
      <details class="trackbox"><summary>Sent it? Track the deadline →</summary>
        <div class="rform"><label>Date sent<input type="date" id="trSent" value="${new Date().toISOString().slice(0, 10)}"></label>
          <label>How<select id="trHow"><option>Email</option><option>Online portal</option><option>Mail</option><option>In person</option></select></label>
          <label>Reference number (optional)<input id="trRef" placeholder="e.g. 2026-FOIA-1234"></label></div>
        <button type="button" class="btn primary" id="trSave">Start tracking</button>
        <p class="note">Saved only in this browser on this device. Nothing is sent to us or anyone else.</p></details>
      <p class="note">${isC ? 'A draft to help you take part in a public process. Not legal advice. A local legal aid office or law-school clinic can help with hearings and appeals.' : 'A draft to help you ask for public records. Not legal advice. Talk to legal aid or a lawyer about anything beyond a records request.'}</p>`);
    $('copyLetter').onclick = async () => { try { await navigator.clipboard.writeText($('letterBox').value); $('copyLetter').textContent = 'Copied'; } catch (err) { $('letterBox').select(); } };
    $('trSave').onclick = () => { const r = trackAdd(L, $('letterBox').value, $('trSent').value, $('trHow').value, $('trRef').value.trim()); location.hash = '#requests/' + r.id; };
    $('dlLetter').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([$('letterBox').value], { type: 'text/plain' })); a.download = isC ? 'public-comment.txt' : 'records-request.txt'; a.click(); };
  }

  $('detail').addEventListener('click', (e) => {
    const lt = e.target.closest('[data-letter]');
    if (lt) return showLetter(lt.dataset.letter);
    const fam = e.target.closest('[data-fam]');
    if (fam) { location.hash = '#family/' + encodeURIComponent(fam.dataset.fam); return; }
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
          `<li><button type="button" data-fam="${esc(f.controller_id)}"><span>${isPersonCtl(f.controller, f.controller_type) ? esc(leadCompany((f.operators || []).map((o) => o.name))) + ' <span class="muted-s">· listed controller: ' + esc(f.controller) + ' (individual)</span>' : esc(f.controller)}</span><span class="count">${num((f.mines || []).length)} mines</span></button></li>`).join('')}</ul></details>` : ''}
        ${mines.length ? `<details open><summary>Mines (${mines.length})</summary><ul class="mines-list">${mines.map((f) =>
          `<li><button type="button" data-mine="${esc(f.properties.ids.msha_mine)}"><span>${esc(f.properties.name)}</span><span class="count">${esc(mineStatus(f.properties.status))}</span></button></li>`).join('')}</ul></details>` : ''}`);
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

  let pendingMap = null;
  let markReady; const ready = new Promise((r) => (markReady = r));
  map.on('load', () => loadData().then(markReady, markReady));

  // ---- Home page vs map (hash routing: '' = home, '#map', '#map/harlan', '#map/flint', '#map/flags')
  // ---- Records-request tracker: browser-only (localStorage). Deadlines are approximate (federal holidays only).
  const LAWS = {
    KY: { name: 'Kentucky Open Records Act', days: 5, unit: 'business', cite: 'KRS 61.880(1)', ext: null,
      follow: 'Under KRS 61.880(1), the agency must respond within five business days of receiving the request.',
      appeal: { to: 'Office of the Attorney General, Open Records and Open Meetings Division, 700 Capital Avenue, Suite 118, Frankfort, KY 40601', cite: 'KRS 61.880(2)', note: 'Send the AG a copy of your request and the agency’s response (or a note that it never responded). The AG issues a written decision.' } },
    MI: { name: 'Michigan Freedom of Information Act', days: 5, unit: 'business', cite: 'MCL 15.235(2)', ext: 'The agency may extend once by up to 10 business days with written notice.',
      follow: 'Under MCL 15.235(2), the public body must respond within five business days (or ten more with a written extension notice). Under MCL 15.235(3), failing to respond counts as a final decision to deny.',
      appeal: { to: 'The head of the public body (written appeal under MCL 15.240), or the circuit court within 180 days', cite: 'MCL 15.240', note: 'Label it “Appeal” and say why the denial (or silence) is wrong.' } },
    FED: { name: 'Freedom of Information Act', days: 20, unit: 'working', cite: '5 U.S.C. § 552(a)(6)(A)(i)', ext: 'The agency may extend by 10 working days in “unusual circumstances” with written notice.',
      follow: 'Under 5 U.S.C. § 552(a)(6)(A)(i), the agency must determine whether to comply within 20 working days. I also ask for an estimated completion date under § 552(a)(7)(B).',
      appeal: { to: 'The agency’s FOIA appeals office (named in its response), within 90 days of its decision; the Office of Government Information Services (OGIS) can mediate', cite: '5 U.S.C. § 552(a)(6)(A)', note: 'If the agency misses its deadline, you may treat that as a denial and appeal or go to court.' } },
    COMMENT: { name: 'Public comment period', days: null, unit: null, cite: '', follow: '', appeal: null },
  };
  const lawOf = (L) => L.kind === 'comment' ? 'COMMENT' : /Kentucky/.test(L.law || '') ? 'KY' : /Michigan/.test(L.law || '') ? 'MI' : 'FED';
  function fedHolidays(y) {
    const nth = (m, wd, n) => { const d = new Date(Date.UTC(y, m, 1)); while (d.getUTCDay() !== wd) d.setUTCDate(d.getUTCDate() + 1); d.setUTCDate(d.getUTCDate() + 7 * (n - 1)); return d; };
    const last = (m, wd) => { const d = new Date(Date.UTC(y, m + 1, 0)); while (d.getUTCDay() !== wd) d.setUTCDate(d.getUTCDate() - 1); return d; };
    const fixed = (m, dd) => { const d = new Date(Date.UTC(y, m, dd)); if (d.getUTCDay() === 6) d.setUTCDate(dd - 1); if (d.getUTCDay() === 0) d.setUTCDate(dd + 1); return d; };
    return new Set([fixed(0, 1), nth(0, 1, 3), nth(1, 1, 3), last(4, 1), fixed(5, 19), fixed(6, 4), nth(8, 1, 1), nth(9, 1, 2), fixed(10, 11), nth(10, 4, 4), fixed(11, 25)].map((d) => d.toISOString().slice(0, 10)));
  }
  function addBusinessDays(iso, n) {
    const d = new Date(iso + 'T12:00:00Z'); let k = 0;
    while (k < n) { d.setUTCDate(d.getUTCDate() + 1); const s = d.toISOString().slice(0, 10); const wd = d.getUTCDay(); if (wd && wd !== 6 && !fedHolidays(d.getUTCFullYear()).has(s)) k++; }
    return d.toISOString().slice(0, 10);
  }
  const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);
  const todayISO = () => new Date().toISOString().slice(0, 10);
  let reqs = (() => { try { return JSON.parse(localStorage.getItem('pcf.requests')) || []; } catch (e) { return []; } })();
  const saveReqs = () => { try { localStorage.setItem('pcf.requests', JSON.stringify(reqs)); } catch (e) {} reqBadge(); };
  function dueOf(r) {
    if (r.law === 'COMMENT') return r.comment_ends || null;
    const law = LAWS[r.law];
    return addBusinessDays(r.sent, law.days + (r.extended ? (r.law === 'FED' ? 10 : 10) : 0));
  }
  function clockOf(r) {
    const due = dueOf(r);
    if (['answered', 'closed'].includes(r.status)) return { cls: 'done', txt: r.status === 'answered' ? 'Answered' : 'Closed', late: false };
    if (r.status === 'denied' || r.status === 'partial') return { cls: 'late', txt: r.status === 'denied' ? 'Denied: you can appeal' : 'Partly answered: you can appeal the rest', late: true };
    if (!due) return { cls: '', txt: 'No deadline known: check the notice', late: false };
    const left = daysBetween(todayISO(), due);
    return left < 0 ? { cls: 'late', txt: `${-left} day${left === -1 ? '' : 's'} past the deadline (${due})`, late: true }
      : { cls: '', txt: left === 0 ? `Due today (${due})` : `${left} day${left === 1 ? '' : 's'} left · due ${due}`, late: false };
  }
  function reqBadge() {
    const n = reqs.filter((r) => clockOf(r).late).length, b = $('reqBadge');
    if (!b) return; b.hidden = !n; b.textContent = n;
  }
  function trackAdd(L, text, sent, how, ref) {
    const r = { id: 'R' + Date.now().toString(36), created: todayISO(), sent: sent || todayISO(), how, ref, law: lawOf(L), to: L.to, subject: L.subject,
      text, status: 'waiting', extended: false, comment_ends: L.item?.ends || null, item_url: L.item?.url || null, events: [{ date: sent || todayISO(), what: `Sent by ${how.toLowerCase()}` }] };
    reqs.unshift(r); saveReqs(); return r;
  }
  function followText(r) {
    const law = LAWS[r.law];
    return `[Your name]\n[Your mailing address or email]\n\n${todayISO()}\n\nTo: ${r.to}\n\nRe: Follow-up on my request sent ${r.sent}${r.ref ? ' (reference ' + r.ref + ')' : ''}: ${r.subject}\n\nOn ${r.sent} I sent a request under the ${law.name}. ${law.follow}\nThe deadline was ${dueOf(r)}, and as of today I have not received ${r.status === 'partial' ? 'a complete response' : 'a response'}.\n\nPlease tell me in writing when you will provide the records, or which records you are withholding and the specific exemption for each. A copy of my original request is below.\n\nThank you,\n[Your name]\n\n----- Original request -----\n${r.text}`;
  }
  function appealText(r) {
    const law = LAWS[r.law]; if (!law.appeal) return '';
    return `[Your name]\n[Your mailing address or email]\n\n${todayISO()}\n\nTo: ${law.appeal.to}\n\nRe: APPEAL under ${law.appeal.cite}: request to ${r.to}, sent ${r.sent}${r.ref ? ' (reference ' + r.ref + ')' : ''}\n\nI appeal the ${r.status === 'waiting' ? 'failure to respond to' : r.status === 'partial' ? 'partial denial of' : 'denial of'} my request under the ${law.name}. ${r.status === 'waiting' ? `The response was due ${dueOf(r)} and none has arrived.` : 'The agency has not shown that each withheld record falls within a specific exemption.'}\n\nI ask that the records be released, or that each withheld record be identified with the exemption claimed and an explanation of how it applies, and that any reasonably segregable non-exempt portion be released.\n\nAttached: my original request${r.status !== 'waiting' ? ' and the agency’s response' : ''}.\n\nThank you,\n[Your name]\n\n----- Original request -----\n${r.text}`;
  }
  function reqCard(r) {
    const c = clockOf(r), law = LAWS[r.law];
    return `<article class="rcard ${c.late ? 'late' : ''}" id="req-${esc(r.id)}">
      <div class="rtop"><b>${esc(r.subject)}</b><span class="rclock ${c.cls}">${esc(c.txt)}</span></div>
      <span class="when">${esc(law.name)}${law.cite ? ' · ' + esc(law.cite) : ''} · to ${esc(r.to)} · sent ${esc(r.sent)} by ${esc((r.how || '').toLowerCase())}${r.ref ? ' · ref ' + esc(r.ref) : ''}</span>
      ${law.ext ? `<span class="when">${esc(law.ext)}${r.extended ? ' Extension noted: deadline moved.' : ''}</span>` : ''}
      <ol class="hist">${r.events.map((e) => `<li><span class="when">${esc(e.date)}</span> ${esc(e.what)}</li>`).join('')}</ol>
      <div class="racts">
        <select data-rstatus="${esc(r.id)}" aria-label="Status">${['waiting', 'answered', 'partial', 'denied', 'closed'].map((s) => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${{ waiting: 'Waiting for answer', answered: 'Answered in full', partial: 'Partly answered', denied: 'Denied', closed: 'Closed / dropped' }[s]}</option>`).join('')}</select>
        ${law.ext && !r.extended && r.status === 'waiting' ? `<button type="button" data-rext="${esc(r.id)}">They sent an extension notice</button>` : ''}
        ${r.law !== 'COMMENT' && (c.late || r.status === 'waiting') ? `<button type="button" data-rdraft="follow:${esc(r.id)}">Draft a follow-up</button>` : ''}
        ${law.appeal && (c.late || ['denied', 'partial'].includes(r.status)) ? `<button type="button" data-rdraft="appeal:${esc(r.id)}">Draft an appeal</button>` : ''}
        <button type="button" data-rdraft="orig:${esc(r.id)}">Original letter</button>
        <button type="button" data-rdel="${esc(r.id)}">Delete</button>
      </div>
      <div class="rdraft" id="rd-${esc(r.id)}"></div>
    </article>`;
  }
  function renderReqs(focus) {
    const el = $('reqPage');
    const late = reqs.filter((r) => clockOf(r).late).length;
    el.innerHTML = `<div class="fp-wrap"><div class="fp-crumb"><a href="#">Home</a> / <span>My requests</span></div>
      <p class="eyebrow">RECORDS REQUESTS AND COMMENTS · SAVED ONLY IN THIS BROWSER</p>
      <h1 class="serif">Hold them to the clock</h1>
      <p class="lede2">${reqs.length ? `${num(reqs.length)} tracked · ${late ? `<b class="hot">${num(late)} past due or denied</b>` : 'none overdue'}` : 'Nothing tracked yet. Draft a records request or comment from any card on the map, send it, then press “Track the deadline”.'}</p>
      <div class="btns"><a class="btn" href="#map">Find something to request →</a>${reqs.length ? '<button type="button" class="btn" id="reqExport">Back up (.json)</button>' : ''}<label class="btn">Restore backup<input type="file" id="reqImport" accept="application/json" hidden></label></div>
      <div class="rlist">${reqs.map(reqCard).join('')}</div>
      <p class="note">Deadlines are counted in business days, skipping weekends and federal holidays, so state holidays can shift them by a day. Check the law cited. Drafts are not legal advice; legal aid or a law-school clinic can help with appeals. Nothing here leaves your device unless you send it.</p></div>`;
    if (focus) document.getElementById('req-' + focus)?.scrollIntoView({ block: 'center' });
  }
  $('reqPage').addEventListener('click', (e) => {
    const t = e.target;
    const d = t.closest('[data-rdraft]');
    if (d) {
      const [kind, id] = d.dataset.rdraft.split(':'); const r = reqs.find((x) => x.id === id); if (!r) return;
      const text = kind === 'follow' ? followText(r) : kind === 'appeal' ? appealText(r) : r.text;
      const law = LAWS[r.law];
      $('rd-' + id).innerHTML = `${kind === 'appeal' && law.appeal ? `<p class="note">${esc(law.appeal.note)} Confirm the current address on the agency’s or Attorney General’s website before sending.</p>` : ''}<textarea class="letter" rows="14" aria-label="Draft">${esc(text)}</textarea><div class="racts"><button type="button" data-rcopy="${esc(id)}">Copy</button>${kind !== 'orig' ? `<button type="button" data-rlog="${esc(id)}:${kind}">I sent this</button>` : ''}</div>`;
      return;
    }
    const cp = t.closest('[data-rcopy]'); if (cp) { const ta = $('rd-' + cp.dataset.rcopy).querySelector('textarea'); navigator.clipboard?.writeText(ta.value).then(() => (cp.textContent = 'Copied'), () => ta.select()); return; }
    const lg = t.closest('[data-rlog]'); if (lg) { const [id, kind] = lg.dataset.rlog.split(':'); const r = reqs.find((x) => x.id === id); r.events.push({ date: todayISO(), what: kind === 'appeal' ? 'Appeal sent' : 'Follow-up sent' }); saveReqs(); renderReqs(id); return; }
    const ex = t.closest('[data-rext]'); if (ex) { const r = reqs.find((x) => x.id === ex.dataset.rext); r.extended = true; r.events.push({ date: todayISO(), what: 'Agency sent an extension notice' }); saveReqs(); renderReqs(r.id); return; }
    const del = t.closest('[data-rdel]'); if (del && confirmDel(del)) { reqs = reqs.filter((x) => x.id !== del.dataset.rdel); saveReqs(); renderReqs(); return; }
    if (t.id === 'reqExport') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(reqs, null, 1)], { type: 'application/json' })); a.download = `my-requests-${todayISO()}.json`; a.click(); }
  });
  function confirmDel(btn) { if (btn.dataset.armed) return true; btn.dataset.armed = '1'; btn.textContent = 'Press again to delete'; setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete'; }, 3000); return false; }
  $('reqPage').addEventListener('change', (e) => {
    const st = e.target.closest('[data-rstatus]');
    if (st) { const r = reqs.find((x) => x.id === st.dataset.rstatus); r.status = st.value; r.events.push({ date: todayISO(), what: 'Marked: ' + st.selectedOptions[0].textContent }); saveReqs(); renderReqs(r.id); return; }
    if (e.target.id === 'reqImport' && e.target.files[0]) {
      e.target.files[0].text().then((t) => { const arr = JSON.parse(t); if (!Array.isArray(arr)) throw new Error('not a backup'); const have = new Set(reqs.map((r) => r.id)); reqs = [...arr.filter((r) => r && r.id && !have.has(r.id)), ...reqs]; saveReqs(); renderReqs(); }).catch(() => alertNote('That file is not a requests backup.'));
    }
  });
  const alertNote = (m) => { const p = document.createElement('p'); p.className = 'flag'; p.textContent = m; $('reqPage').prepend(p); };
  reqBadge();

  // ---- World tree: any company with a Legal Entity Identifier, live from GLEIF (browser calls the public API directly).
  const GL = 'https://api.gleif.org/api/v1/';
  const glCache = new Map();
  async function gl(path) {
    if (glCache.has(path)) return glCache.get(path);
    const pr = fetch(GL + path, { headers: { Accept: 'application/vnd.api+json' } }).then((r) => (r.status === 404 ? null : r.ok ? r.json() : Promise.reject(new Error('GLEIF ' + r.status))));
    glCache.set(path, pr);
    return pr;
  }
  const glEnt = (d) => { const a = d.attributes || {}, e = a.entity || {}; return { lei: d.id, name: e.legalName?.name || d.id, country: e.legalAddress?.country, region: e.legalAddress?.region, city: e.legalAddress?.city,
    hq: e.headquartersAddress?.country, status: e.status, category: e.category, form: e.legalForm?.id, registered: (a.registration?.initialRegistrationDate || '').slice(0, 10), lastUpdate: (a.registration?.lastUpdateDate || '').slice(0, 10),
    regStatus: a.registration?.status, hasKids: !!(d.relationships || {})['direct-children'] }; };
  const ccTag = (c, home) => c ? `<span class="cc ${home && c !== home ? 'foreign' : ''}" title="${esc(CC[c] || c)}">${esc(c)}</span>` : '';
  const treeLink = (e, home) => `<a href="#tree/${esc(e.lei)}">${esc(e.name)}</a>${ccTag(e.country, home)}`;
  async function kidsOf(lei, max = 300) {
    const out = []; let page = 1, total = 0;
    while (out.length < max) {
      const j = await gl(`lei-records/${lei}/direct-children?page[size]=100&page[number]=${page}`);
      if (!j) break;
      total = j.meta?.pagination?.total || 0;
      out.push(...(j.data || []).map(glEnt));
      if (page >= (j.meta?.pagination?.lastPage || 1)) break;
      page++;
    }
    return { list: out, total };
  }
  async function renderTreeSearch(q, usOnly) {
    const el = $('treePage');
    el.innerHTML = `<div class="fp-wrap"><div class="fp-crumb"><a href="#">Home</a> / <span>World tree</span></div>
      <p class="eyebrow">WORLD TREE · GLOBAL LEGAL ENTITY IDENTIFIER INDEX</p>
      <h1 class="serif">Who owns what, anywhere</h1>
      <p class="lede2">Search any company that holds a Legal Entity Identifier (LEI): most large companies, banks, funds, and anything that trades in financial markets. See the parent it reports, and its subsidiaries in every country.</p>
      <form class="tsearch" id="treeForm"><input id="treeQ" type="search" placeholder="Try “Peabody Energy”, “Alpha Metallurgical”, “Javelin Global”" value="${esc(q || '')}" aria-label="Company name"><button>Search</button></form>
      <label class="muted-s"><input type="checkbox" id="treeUS" ${usOnly ? 'checked' : ''}> US-registered companies only</label>
      <div id="treeResults" class="tres" aria-live="polite">${q ? '<p class="muted-s">Searching…</p>' : ''}</div>
      <p class="note">Many small private companies (most Kentucky coal LLCs) have no LEI, so they won’t appear here; use the Harlan map and family pages for those. Parents are what each company reported about itself to GLEIF.</p></div>`;
    $('treeForm').onsubmit = (e) => { e.preventDefault(); const v = $('treeQ').value.trim(); if (v) location.hash = '#tree/q/' + encodeURIComponent(v) + ($('treeUS').checked ? '/us' : ''); };
    if (!q) return;
    try {
      const j = await gl(`lei-records?filter[fulltext]=${encodeURIComponent(q)}${usOnly ? '&filter[entity.legalAddress.country]=US' : ''}&page[size]=20`);
      const list = (j?.data || []).map(glEnt);
      $('treeResults').innerHTML = list.length ? list.map((e) => `<a href="#tree/${esc(e.lei)}"><span><b>${esc(e.name)}</b>${ccTag(e.country)}${e.status === 'INACTIVE' ? ' <span class="muted-s">inactive</span>' : ''}</span><span class="muted-s">${esc(e.city || '')} · LEI ${esc(e.lei)}</span></a>`).join('')
        + `<p class="muted-s">${num(j.meta?.pagination?.total || list.length)} match${(j.meta?.pagination?.total || list.length) === 1 ? '' : 'es'} in GLEIF${(j.meta?.pagination?.total || 0) > 20 ? '; showing the first 20. Add more of the name to narrow it.' : '.'}</p>`
        : '<p class="muted-s">No company with an LEI matches that name. It may not have one; try the legal name, or search the Harlan map.</p>';
    } catch (err) { $('treeResults').innerHTML = `<p class="flag">Could not reach GLEIF right now (${esc(err.message)}). Try again in a minute.</p>`; }
  }
  async function renderTree(lei) {
    const el = $('treePage');
    el.innerHTML = `<div class="fp-wrap"><p class="muted-s">Loading ${esc(lei)} from GLEIF…</p></div>`;
    try {
      const r = await gl(`lei-records/${lei}`);
      if (!r) { el.innerHTML = `<div class="fp-wrap"><p class="flag">No LEI record ${esc(lei)}.</p><a class="btn" href="#tree">Search again</a></div>`; return; }
      const me = glEnt(r.data);
      const pub = r.meta?.goldenCopy?.publishDate?.slice(0, 10);
      // walk up through direct parents
      const chain = []; let cur = me.lei, stop = null;
      for (let i = 0; i < 8; i++) {
        const p = await gl(`lei-records/${cur}/direct-parent`);
        if (p?.data) { const pe = glEnt(p.data); chain.unshift(pe); cur = pe.lei; continue; }
        const ex = await gl(`lei-records/${cur}/direct-parent-reporting-exception`);
        const code = ex?.data?.attributes?.reason || ex?.data?.attributes?.exceptionReason;
        stop = code ? { code, at: cur } : null;
        break;
      }
      const top = chain[0] || me;
      const kids = me.hasKids ? await kidsOf(me.lei) : { list: [], total: 0 };
      // countries across everything below (ultimate children), up to 1,000
      let all = [], allTotal = 0;
      if (me.hasKids) {
        for (let pg = 1; pg <= 5; pg++) {
          const j = await gl(`lei-records/${me.lei}/ultimate-children?page[size]=200&page[number]=${pg}`);
          if (!j) break; allTotal = j.meta?.pagination?.total || 0; all.push(...(j.data || []).map(glEnt));
          if (pg >= (j.meta?.pagination?.lastPage || 1)) break;
        }
      }
      const byC = {}; for (const k of all) byC[k.country || '?'] = (byC[k.country || '?'] || 0) + 1;
      const cs = Object.entries(byC).sort((a, b) => b[1] - a[1]); const mx = cs[0]?.[1] || 1;
      const home = me.country;
      const foreign = all.filter((k) => k.country && k.country !== home).length;
      const ours = Object.values(families).filter((f) => [f.controller, ...(f.operators || []).map((o) => o.name)].some((n) => normName(n) === normName(me.name)));
      const EXPL = { NATURAL_PERSONS: 'owned or controlled by one or more individuals (GLEIF does not name them)', NON_CONSOLIDATING: 'its parent does not consolidate it in financial statements', NO_KNOWN_PERSON: 'reports that no person or company controls it', NON_PUBLIC: 'parent kept private', BINDING_LEGAL_COMMITMENTS: 'parent kept private (legal commitment)', LEGAL_OBSTACLES: 'parent kept private (legal obstacle)', DISCLOSURE_DETRIMENTAL: 'parent kept private (says disclosure would be harmful)', DETRIMENT_NOT_EXCLUDED: 'parent kept private (says harm cannot be ruled out)', CONSENT_NOT_OBTAINED: 'parent kept private (no consent)', NO_LEI: 'parent exists but has no LEI' };
      const q = encodeURIComponent(me.name);
      el.innerHTML = `<div class="fp-wrap">
        <div class="fp-crumb"><a href="#">Home</a> / <a href="#tree">World tree</a> / <span>${esc(me.name)}</span></div>
        <section class="fp-head"><div class="fp-title">
          <p class="eyebrow">LEGAL ENTITY · ${esc(CC[me.country] || me.country || '?')}${me.status ? ' · ' + esc(me.status) : ''}</p>
          <h1 class="serif">${esc(me.name)}</h1>
          <p class="lede2">${me.hasKids ? `${num(kids.total)} direct subsidiar${kids.total === 1 ? 'y' : 'ies'} · ${num(allTotal)} companies in all below it · ${num(foreign)} outside ${esc(CC[home] || home || 'its home country')}` : 'Reports no subsidiaries with LEIs'}${chain.length ? ` · ${num(chain.length)} level${chain.length === 1 ? '' : 's'} of parents above it` : ''}</p>
          <div class="fp-ids"><span>LEI ${esc(me.lei)}</span>${me.city ? `<span>${esc(me.city)}${me.region ? ', ' + esc(me.region) : ''}</span>` : ''}${me.hq && me.hq !== me.country ? `<span>HQ ${esc(CC[me.hq] || me.hq)}</span>` : ''}${me.registered ? `<span>LEI since ${esc(me.registered)}</span>` : ''}${me.regStatus && me.regStatus !== 'ISSUED' ? `<span class="hot">LEI ${esc(me.regStatus.toLowerCase())}${me.lastUpdate ? ' since ' + esc(me.lastUpdate) : ''}</span>` : ''}</div>
        </div><div class="btns"><a class="btn" href="https://search.gleif.org/#/record/${esc(me.lei)}" target="_blank" rel="noopener">GLEIF record</a>${ours.length ? `<a class="btn primary" href="#family/${esc(ours[0].controller_id)}">Open its Harlan family →</a>` : ''}</div></section>
        <section class="fp-time"><h2 class="serif">Who’s above it</h2>
          <div class="tchain">${chain.map((c) => `<div class="tnode">${treeLink(c, home)}<span class="when">LEI ${esc(c.lei)}${c.city ? ' · ' + esc(c.city) : ''}</span></div><div class="tarrow"></div>`).join('')}
            <div class="tnode me"><b>${esc(me.name)}</b>${ccTag(me.country)}</div></div>
          ${stop ? `<p class="muted-s"><b class="warm">No parent reported above ${esc(stop.at === me.lei ? me.name : top.name)}.</b> Reason given: ${esc(EXPL[stop.code] || stop.code.replace(/_/g, ' ').toLowerCase())} (GLEIF code ${esc(stop.code)}).</p>` : (!chain.length ? '<p class="muted-s">No parent information reported.</p>' : '')}
        </section>
        ${me.hasKids ? `<section class="fp-time"><h2 class="serif">Where it reaches</h2><p class="muted-s">Every company that reports it as its ultimate parent, by country of registration${allTotal > all.length ? ` (first ${num(all.length)} of ${num(allTotal)})` : ''}. Amber = outside its home country.</p>
          <div class="cbars">${cs.slice(0, 15).map(([c, n]) => `<div class="cbar"><span>${esc(CC[c] || c)}</span><i class="${c !== home ? 'foreign' : ''}" style="width:${Math.max(2, (n / mx) * 100)}%"></i><span>${num(n)}</span></div>`).join('')}</div>${cs.length > 15 ? `<p class="muted-s">…and ${num(cs.length - 15)} more countries.</p>` : ''}</section>
        <section class="fp-time"><h2 class="serif">Direct subsidiaries</h2><p class="muted-s">Click ▸ to open a branch. Each one is a company that reported this one as its direct parent.</p>
          <ul class="tkids" id="treeKids">${kids.list.map((k) => `<li data-lei="${esc(k.lei)}">${treeLink(k, home)}${k.status === 'INACTIVE' ? ' <span class="muted-s">inactive</span>' : ''}${k.hasKids ? ' <button type="button" class="exp" data-kids="' + esc(k.lei) + '">▸ subsidiaries</button>' : ''}</li>`).join('')}</ul>
          ${kids.total > kids.list.length ? `<p class="muted-s">Showing ${num(kids.list.length)} of ${num(kids.total)}. <a href="https://search.gleif.org/#/record/${esc(me.lei)}" target="_blank" rel="noopener">See all in GLEIF</a></p>` : ''}</section>` : ''}
        <section class="fp-time"><h2 class="serif">Dig further</h2><ul class="mines-list">
          <li><a class="rlink" href="https://www.sec.gov/edgar/search/#/q=%22${q}%22" target="_blank" rel="noopener">SEC filings mentioning it (subsidiary lists are Exhibit 21; mine lists are Exhibit 95)</a></li>
          <li><a class="rlink" href="https://www.opensanctions.org/search/?q=${q}" target="_blank" rel="noopener">OpenSanctions (sanctions, politically exposed, debarment lists)</a></li>
          <li><a class="rlink" href="https://opencorporates.com/companies?q=${q}" target="_blank" rel="noopener">OpenCorporates (state and foreign registries)</a></li>
          <li><a class="rlink" href="https://www.courtlistener.com/?q=%22${q}%22" target="_blank" rel="noopener">CourtListener (lawsuits and bankruptcies)</a></li></ul>
          <p class="note">These search by name, so results can include different companies with similar names.</p></section>
        <p class="src">SOURCE: GLEIF Global LEI Index (api.gleif.org)${pub ? ', golden copy published ' + esc(pub) : ''}, read live. Companies report their own parents; GLEIF and local registrars check them. Only legal entities appear, never private individuals. “Linked to” never means “did this.”</p>
      </div>`;
    } catch (err) { el.innerHTML = `<div class="fp-wrap"><p class="flag">Could not reach GLEIF right now (${esc(err.message)}).</p><a class="btn" href="#tree">Back to search</a></div>`; }
  }
  $('treePage').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-kids]'); if (!b) return;
    const li = b.closest('li'); b.disabled = true; b.textContent = '…';
    try {
      const { list, total } = await kidsOf(b.dataset.kids, 100);
      const home = null;
      li.insertAdjacentHTML('beforeend', `<ul class="tkids">${list.map((k) => `<li>${treeLink(k, home)}${k.hasKids ? ' <button type="button" class="exp" data-kids="' + esc(k.lei) + '">▸ subsidiaries</button>' : ''}</li>`).join('')}${total > list.length ? `<li class="muted-s">+${num(total - list.length)} more in GLEIF</li>` : ''}</ul>`);
      b.remove();
    } catch (err) { b.textContent = 'retry'; b.disabled = false; }
  });

  const PLACES = { harlan: { center: [-83.25, 36.87], zoom: 10 }, flint: { center: [-83.69, 43.01], zoom: 11 } };
  async function route() {
    const h = location.hash.replace(/^#/, '');
    const onMap = h.startsWith('map');
    const onFam = h.startsWith('family/');
    const onTree = h === 'tree' || h.startsWith('tree/');
    const onReq = h === 'requests' || h.startsWith('requests/');
    const onHow = h === 'how' || h.startsWith('how-'), onCorr = h === 'corrections', onCheck = h === 'check';
    document.body.classList.toggle('on-how', onHow);
    document.body.classList.toggle('on-corr', onCorr);
    document.body.classList.toggle('on-check', onCheck);
    if (onHow || onCorr || onCheck) {
      document.body.classList.remove('on-home', 'on-family', 'on-tree', 'on-req');
      if (onCheck) { window.scrollTo(0, 0); await ready; await recLoaded; renderCheck(); return; }
      if (onCorr) { window.scrollTo(0, 0); await recLoaded; renderCorrections(); return; }
      const t = h.startsWith('how-') && document.getElementById(h);
      if (t) t.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0);
      return;
    }
    document.body.classList.toggle('on-req', onReq);
    if (onReq) { document.body.classList.remove('on-home', 'on-family', 'on-tree'); window.scrollTo(0, 0); renderReqs(h.split('/')[1]); return; }
    document.body.classList.toggle('on-home', !onMap && !onFam && !onTree);
    document.body.classList.toggle('on-family', onFam);
    document.body.classList.toggle('on-tree', onTree);
    if (onTree) {
      window.scrollTo(0, 0);
      const parts = h.split('/');
      if (parts[1] === 'q') { renderTreeSearch(decodeURIComponent(parts[2] || ''), parts[3] === 'us'); return; }
      if (parts[1] && /^[A-Z0-9]{20}$/i.test(parts[1])) { await ready; renderTree(parts[1].toUpperCase()); return; }
      renderTreeSearch('', false); return;
    }
    if (onFam) { window.scrollTo(0, 0); await ready; renderFamilyPage(decodeURIComponent(h.split('/')[1]), { asOf: 'all' }); return; }
    if (!onMap) { window.scrollTo(0, 0); return; }
    requestAnimationFrame(() => map.resize());
    const sub = h.split('/')[1];
    if (PLACES[sub]) map.jumpTo(PLACES[sub]);
    if (pendingMap) { await ready; const fn = pendingMap; pendingMap = null; fn(); }
    if (sub === 'flags') {
      await ready;
      const cb = $('flagOnly'); if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
    }
  }
  window.addEventListener('hashchange', route);
  route();

  $('homeSearch').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('hq').value.trim(); if (!v) return;
    $('q').value = v;
    location.hash = '#map';
    await ready;
    $('search').requestSubmit();
  });

  $('homePending')?.addEventListener('click', (e) => {
    const lt = e.target.closest('[data-letter]'); if (!lt) return;
    const key = lt.dataset.letter;
    pendingMap = () => showLetter(key);
    location.hash = '#map/harlan';
  });
  ready.then(() => {
    renderHomePending();
    const mines = Object.values(mineById);
    const facs = facFeatures;
    const flagged = facs.filter((f) => f.properties.flag_level === 2).length;
    const linked = mines.filter((f) => f.properties.has_epa).length;
    const cites = mines.reduce((a, f) => a + (f.properties.citations || 0), 0);
    if (meta.sample) return;
    $('homeStats').innerHTML = [
      [num(mines.length), 'Harlan County mines mapped'],
      [num(cites), 'mine safety citations rolled up'],
      [num(facs.length), 'EPA-regulated sites'],
      [num(flagged), 'high-priority silence flags'],
      [esc(meta.pulled), 'records pulled, archived'],
    ].map(([v, k]) => `<div><span class="v">${v}</span><span class="k">${k}</span></div>`).join('');
    $('caseHarlan').textContent = `${num(mines.length)} mines, ${num(Object.keys(families).length)} controllers, ${num(linked)} mines linked to EPA water permits.`;
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // Install as an app (Chrome/Edge on desktop + Android). Hidden once installed or when the browser can't.
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; const b = $('installBtn'); if (b) b.hidden = false; });
  window.addEventListener('appinstalled', () => { installEvt = null; const b = $('installBtn'); if (b) b.hidden = true; });
  if ($('installBtn')) $('installBtn').onclick = async () => {
    if (!installEvt) return;
    installEvt.prompt();
    try { await installEvt.userChoice; } catch (e) {}
    installEvt = null; $('installBtn').hidden = true;
  };
})();
