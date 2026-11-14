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
  let facFeatures = [];
  const water = {};       // area id -> {label, systems}
  const letters = {};     // key -> letter spec
  const intro = $('detailBody').innerHTML;

  async function loadData() {
    const byLayer = {};
    try {
      const idx = await getJSON('data/index.json');
      meta = { sample: false, pulled: idx.pulled };
      for (const [k, f] of Object.entries(idx.layers)) byLayer[k] = await getJSON('data/' + f);
      try { for (const f of await getJSON('data/families.json')) families[f.controller_id] = f; } catch (e) {}
      try { for (const w of await getJSON('data/water.json')) water[w.area] = w; } catch (e) {}
    } catch (e) {
      const s = await getJSON('data/sample.geojson');
      for (const L of LAYERS) byLayer[L.id] = { type: 'FeatureCollection', features: s.features.filter((f) => f.properties.layer === L.id) };
    }
    $('fresh').innerHTML = meta.sample ? '<span class="sample">SAMPLE DATA</span>' : 'DATA PULLED ' + esc(meta.pulled) + ' · ARCHIVED';
    for (const f of (byLayer.mines || { features: [] }).features) mineById[f.properties.ids?.msha_mine] = f;
    facFeatures = (byLayer.facilities || { features: [] }).features;

    for (const L of LAYERS) {
      const data = byLayer[L.id] || { type: 'FeatureCollection', features: [] };
      L.count = data.features.length;
      if (!L.count) L.on = false;
      map.addSource(L.id, { type: 'geojson', data });
      const isMine = L.id === 'mines';
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
      <p class="note">“Owed” is the current assessed amount. Unpaid amounts can include penalties still being contested or not yet final.</p>
      <p class="note pro">Proposed at issue: ${usd(v.proposed)} · vacated citations left out: ${num(v.vacated)}${v.contractor != null ? ' · cited to contractors (not counted): ' + num(v.contractor) : ''}</p>`;
  }

  function flagsHtml(flags, where, severity, letterKey) {
    if (!flags || !flags.length) return '';
    return `<div class="silence"><p class="eyebrow" style="color:var(--coral)">SILENCE DETECTOR${severity ? ' · ' + esc(severity.toUpperCase()) + ' PRIORITY' : ''}${where ? ' · ' + esc(where) : ''}</p><ul>${flags.map((f) =>
      `<li><b>${esc(f.label)}</b><span class="when">${esc(f.evidence)}</span></li>`).join('')}</ul>
      <p class="note">A question worth asking the agency, not a finding of wrongdoing. Check the EPA report.</p>
      ${letterKey ? `<div class="btns"><button type="button" class="btn primary" data-letter="${esc(letterKey)}">Draft a records request →</button></div>` : ''}</div>`;
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
    const epa = parse(p.epa, []);
    const epaHtml = epa.length ? `<details open><summary>EPA records at this site (${epa.length})</summary><ol class="hist">${epa.map((e) =>
      `<li><b>${esc(e.name)}</b> <span class="muted-s">${esc(e.kind || '')}</span>` +
      `<br>${e.qtrs_noncompliance != null ? `<span class="${e.qtrs_noncompliance >= 4 ? 'hot' : ''}">${esc(e.qtrs_noncompliance)} of last 12 quarters out of compliance</span>` : 'Compliance: not reported'}${e.penalties ? ' · penalties ' + usd(e.penalties) : ''}` +
      (e.permits && e.permits.length ? e.permits.map((pm) => `<span class="when">Water permit ${esc(pm.id)}: <span class="${pm.status_code === 'EXP' ? 'hot' : ''}">${esc(pm.status)}</span>${pm.expiration ? ' · expires/expired ' + esc(pm.expiration) : ''}${pm.effluent_qtrs ? ' · discharge limits exceeded ' + esc(pm.effluent_qtrs) + ' of 12 quarters' : ''}</span>`).join('') : '') +
      (e.tri && e.tri.parent ? `<span class="when">Parent company reported to EPA (TRI): ${esc(e.tri.parent)}</span>` : '') +
      (e.flags && e.flags.length ? `<span class="when" style="color:var(--coral)">⚑ ${e.severity ? esc(e.severity.toUpperCase()) + ' PRIORITY · ' : ''}${e.flags.map((f) => esc(f.label)).join(' · ')}</span>` +
        `<span class="when"><button type="button" class="linkbtn" data-letter="${esc(regFacilityLetter(e, ids))}">Draft a records request about this permit →</button></span>` : '') +
      `<span class="when">Possibly the same site (${esc(e.confidence)} confidence, inferred): ${esc((e.basis || []).join(' · '))}</span>` +
      (e.source_url ? `<span class="when"><a href="${esc(e.source_url)}" target="_blank" rel="noopener">EPA ECHO report</a>${e.frs ? ' <span class="pro">· FRS ' + esc(e.frs) + '</span>' : ''}</span>` : '') +
      `</li>`).join('')}</ol><p class="note">MSHA and EPA don’t share an ID number, so these matches come from location plus coal-mining permit codes or shared names. Check the EPA report before relying on one.</p></details>` : '';
    const histHtml = hist.length ? `<details ${hist.length <= 4 ? 'open' : ''}><summary>Who ran it, who controlled it (${hist.length})</summary><ol class="hist">${hist.slice().reverse().map((h) =>
      `<li><b>${esc(h.operator || 'Unknown operator')}</b> <span class="muted-s">operator</span>` +
      (h.controller ? `<br><span class="muted-s">controlled by</span> ${personLabel(h.controller, h.controller_type)}` : '') +
      `<span class="when">${esc(h.op_start || '?')} → ${esc(h.op_end || 'now')}</span></li>`).join('')}</ol></details>` : '';
    show(`
      ${meta.sample ? '<p><span class="sample">SAMPLE</span></p>' : ''}
      <p class="eyebrow">${esc((p.kind || 'Mine').toUpperCase())}</p>
      <h2 class="card-title">${esc(p.name)}</h2>
      ${violStats(v, 'at this mine')}
      ${fairHtml(parse(p.fair, null))}
      ${p.operator ? `<div class="row"><span class="lbl">Operator now</span><span>${esc(p.operator)}</span></div>` : ''}
      ${p.parent ? `<div class="row"><span class="lbl">Controller now</span><span>${esc(p.parent)}</span></div>` : ''}
      ${fam ? `<div class="btns"><button type="button" class="btn primary" data-fam="${esc(fam.controller_id)}">Pull the curtain on this controller →</button></div>` : ''}
      ${epaHtml}
      ${histHtml}
      <div class="btns"><button type="button" class="btn" data-letter="${esc(regMineLetter(p, ids, v))}">Request this mine’s MSHA records →</button></div>
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
      ${researchHtml(f.controller, f.controller_type)}
      <p class="src">SOURCE: MSHA Controller/Operator History + Violations · pulled ${esc(f.as_of)}</p>`);
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
      <p class="eyebrow">${esc(String(p.kind || 'EPA-regulated facility').toUpperCase())}</p>
      <h2 class="card-title">${esc(p.name)}</h2>
      <div class="stats">
        <div class="stat"><span class="k">Quarters out of compliance</span><span class="v ${p.qtrs_noncompliance >= 4 ? 'hot' : ''}">${p.qtrs_noncompliance ?? '—'}<span class="muted-s"> / 12</span></span><span class="s">last 3 years</span></div>
        <div class="stat"><span class="k">Penalties on record</span><span class="v">${p.penalties != null ? usd(p.penalties) : '—'}</span><span class="s">EPA programs</span></div>
      </div>
      ${flagsHtml(flags, '', p.severity, key)}
      ${permits.map((pm) => `<div class="row"><span class="lbl">Water permit ${esc(pm.id)}</span><span class="${pm.status_code === 'EXP' ? 'hot' : ''}">${esc(pm.status)}${pm.expiration ? ' · ' + esc(pm.expiration) : ''}</span></div>` +
        (pm.effluent_qtrs != null ? `<div class="row"><span class="lbl">Last 12 quarters</span><span>pollution limits exceeded: ${esc(pm.effluent_qtrs)} · reporting problems: ${esc(pm.reporting_qtrs || 0)}</span></div>` : '') +
        (pm.water_body ? `<div class="row"><span class="lbl">Discharges to</span><span>${esc(pm.water_body)}</span></div>` : '')).join('')}
      ${triInfo && triInfo.parent ? `<div class="row"><span class="lbl">Parent company (reported to EPA TRI)</span><span>${esc(triInfo.parent)}${triInfo.foreign_parent ? ' · foreign parent ' + esc(triInfo.foreign_parent) : ''}</span></div>` : ''}
      <div class="row"><span class="lbl">Last inspection on record</span><span>${esc(p.last_inspection || 'none on record')}</span></div>
      <div class="row"><span class="lbl">Formal enforcement, 5 yrs</span><span>${p.formal_actions_5y ?? '—'}</span></div>
      ${link ? `<div class="btns"><button type="button" class="btn" data-mine="${esc(link.mine_id)}">Possibly the same site as mine: ${esc(link.mine)} →</button></div>` : ''}
      <p class="src">SOURCE: ${p.source_url ? `<a href="${esc(p.source_url)}" target="_blank" rel="noopener">EPA ECHO facility report</a>` : 'EPA ECHO'} · ICIS-NPDES permits · pulled ${esc(p.as_of)}</p>
      <p class="src pro">IDS: FRS ${esc(ids.frs)}${permits.length ? ' · NPDES ' + permits.map((x) => esc(x.id)).join(', ') : ''}${triInfo ? ' · TRI ' + esc(triInfo.tri_id) : ''}</p>`);
  }

  function showTri(p) {
    const t = parse(p.tri, {});
    const ids = parse(p.ids, {});
    show(`
      <p class="eyebrow">${esc(String(p.kind || 'TRI facility').toUpperCase())}</p>
      <h2 class="card-title">${esc(p.name)}</h2>
      <div class="row"><span class="lbl">Parent company (reported by the facility)</span><span>${esc(t.parent || 'none reported')}</span></div>
      ${t.foreign_parent ? `<div class="row"><span class="lbl">Foreign parent</span><span>${esc(t.foreign_parent)}</span></div>` : ''}
      ${t.parent ? researchHtml(t.parent, 'COMPANY') : ''}
      <p class="note">Toxic release amounts by chemical and year are the next step for this layer.</p>
      <p class="src">SOURCE: ${p.source_url ? `<a href="${esc(p.source_url)}" target="_blank" rel="noopener">EPA facility report</a>` : 'EPA Toxics Release Inventory'} · pulled ${esc(p.as_of)}</p>
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
    if (!name || (type || '').toUpperCase().startsWith('P')) return '';
    const q = encodeURIComponent(name);
    return `<details><summary>Look this company up</summary><ul class="mines-list">
      <li><a class="rlink" href="https://www.sec.gov/cgi-bin/browse-edgar?company=${q}&owner=include&count=40" target="_blank" rel="noopener">SEC EDGAR filings (public companies, subsidiaries)</a></li>
      <li><a class="rlink" href="https://opencorporates.com/companies?q=${q}" target="_blank" rel="noopener">OpenCorporates (state and foreign registries)</a></li>
      <li><a class="rlink" href="https://search.gleif.org/#/search/simpleSearch=${q}" target="_blank" rel="noopener">GLEIF (global legal entities and parents)</a></li>
      <li><a class="rlink" href="https://www.courtlistener.com/?q=%22${q}%22" target="_blank" rel="noopener">CourtListener (lawsuits and bankruptcies)</a></li>
    </ul><p class="note">These search by name, so a result may be a different company with a similar name. Match addresses, officers or ID numbers before relying on one.</p></details>`;
  }

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
    if (codes.has('serious_no_enforcement') || codes.has('violations_no_penalty')) items.push('Any records documenting enforcement decisions for this facility, including any decision not to pursue formal enforcement or penalties.');
    if (pids.length) items.push(`Discharge Monitoring Reports and noncompliance reports submitted under permit ${pids.join(', ')} from ${since()} to the present.`);
    if (codes.has('expired_permit')) items.push('Records showing the status of the permit renewal, including any renewal application, and any authorization to discharge after the permit expiration date.');
    items.push('Records identifying the current permittee and operator, and any transfer of the permit.');
    const key = 'L' + (++letterSeq);
    letters[key] = { to: ag.to, law: ag.law, subject: `Records request: ${e.name}${pids.length ? ' (permit ' + pids.join(', ') + ')' : ''}`,
      facts: (e.flags || []).map((f) => f.evidence), source: 'EPA ECHO and ICIS-NPDES public data', items,
      ids: [e.frs ? 'EPA FRS ID ' + e.frs : null, ...pids.map((x) => 'NPDES permit ' + x)].filter(Boolean) };
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
  function letterText(L) {
    const today = new Date().toISOString().slice(0, 10);
    return `[Your name]\n[Your mailing address or email]\n\n${today}\n\nTo: ${L.to}\n\nRe: ${L.subject}\n\nUnder ${L.law}, I request copies of the following public records:\n\n${L.items.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n${L.facts.length ? `For context, public data (${L.source}) shows:\n${L.facts.map((x) => '- ' + x).join('\n')}\n\n` : ''}Identifiers: ${L.ids.join('; ')}.\n\nI prefer electronic copies. If any part of this request is denied, please cite the specific exemption and release all parts that are not exempt. I ask that fees be waived because the records will be used to inform the public about environmental and public-health conditions; if fees will exceed $25, please tell me before proceeding.\n\nThank you,\n[Your name]`;
  }
  function showLetter(key) {
    const L = letters[key]; if (!L) return;
    const text = letterText(L);
    show(`<p class="eyebrow">RECORDS REQUEST · DRAFT</p>
      <h2 class="card-title">Ask the agency</h2>
      <p class="muted-s">Fill in your name and contact, check the agency’s current records-request address or online portal, then send. Agencies must answer within deadlines set by law (often 5 business days for Kentucky and Michigan, 20 working days for federal FOIA).</p>
      <textarea id="letterBox" class="letter" rows="18" aria-label="Letter text">${esc(text)}</textarea>
      <div class="btns"><button type="button" class="btn primary" id="copyLetter">Copy letter</button><button type="button" class="btn" id="dlLetter">Download .txt</button></div>
      <p class="note">A draft to help you ask for public records. Not legal advice. Talk to legal aid or a lawyer about anything beyond a records request.</p>`);
    $('copyLetter').onclick = async () => { try { await navigator.clipboard.writeText($('letterBox').value); $('copyLetter').textContent = 'Copied'; } catch (err) { $('letterBox').select(); } };
    $('dlLetter').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([$('letterBox').value], { type: 'text/plain' })); a.download = 'records-request.txt'; a.click(); };
  }

  $('detail').addEventListener('click', (e) => {
    const lt = e.target.closest('[data-letter]');
    if (lt) return showLetter(lt.dataset.letter);
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

  let markReady; const ready = new Promise((r) => (markReady = r));
  map.on('load', () => loadData().then(markReady, markReady));

  // ---- Home page vs map (hash routing: '' = home, '#map', '#map/harlan', '#map/flint', '#map/flags')
  const PLACES = { harlan: { center: [-83.25, 36.87], zoom: 10 }, flint: { center: [-83.69, 43.01], zoom: 11 } };
  async function route() {
    const h = location.hash.replace(/^#/, '');
    const onMap = h.startsWith('map');
    document.body.classList.toggle('on-home', !onMap);
    if (!onMap) { window.scrollTo(0, 0); return; }
    requestAnimationFrame(() => map.resize());
    const sub = h.split('/')[1];
    if (PLACES[sub]) map.jumpTo(PLACES[sub]);
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

  ready.then(() => {
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
})();
