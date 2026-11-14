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
  let facFeatures = [];
  const water = {};       // area id -> {label, systems}
  const letters = {};     // key -> letter spec
  let money = null;       // money.json: USAspending / FEC / CourtListener by normalized name
  let parents = null;     // parents.json: GLEIF legal-entity records by normalized name
  let registry = null;    // registry.json: Kentucky Secretary of State records by normalized name
  let pendingData = null; // comments.json: permit actions pending with the state (public-comment alerts)
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
      if (map.getLayer(id + '-line')) map.setLayoutProperty(id + '-line', 'visibility', e.target.checked ? 'visible' : 'none');
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
      (e.permits && e.permits.length ? e.permits.map((pm) => `<span class="when">Water permit ${esc(pm.id)}: <span class="${pm.status_code === 'EXP' ? 'hot' : ''}">${esc(pm.status)}</span>${pm.expiration ? ' · expires/expired ' + esc(pm.expiration) : ''}${pm.effluent_qtrs ? ' · discharge limits exceeded ' + esc(pm.effluent_qtrs) + ' of 12 quarters' : ''}</span>` +
        (pm.exceed?.exceedances ? `<span class="when hot">Over its limits ${num(pm.exceed.exceedances)}× in 3 yrs · worst: ${esc(pm.exceed.parameters[0]?.name || '')} ${pct(Math.max(...pm.exceed.parameters.map((x) => x.max_pct)))} over</span>` : '') +
        (pm.informal?.last5 >= 3 && !pm.formal?.last5 ? `<span class="when hot">${num(pm.informal.last5)} warning letters in 5 yrs, no formal action</span>` : '')).join('') : '') +
      (e.tri && e.tri.parent ? `<span class="when">Parent company reported to EPA (TRI): ${esc(e.tri.parent)}</span>` : '') +
      (e.flags && e.flags.length ? `<span class="when" style="color:var(--coral)">⚑ ${e.severity ? esc(e.severity.toUpperCase()) + ' PRIORITY · ' : ''}${e.flags.map((f) => esc(f.label)).join(' · ')}</span>` +
        `<span class="when"><button type="button" class="linkbtn" data-letter="${esc(regFacilityLetter(e, ids))}">Draft a records request about this permit →</button></span>` : '') +
      `<span class="when">${e.confidence === 'high' ? 'Same site (high confidence, state permit record)' : 'Possibly the same site (' + esc(e.confidence) + ' confidence, inferred)'}: ${esc((e.basis || []).join(' · '))}</span>` +
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
      ${kyPermitsHtml(parse(p.ky_permits, []))}
      ${pendingCardHtml(p)}
      <div class="btns"><button type="button" class="btn" data-letter="${esc(regMineLetter(p, ids, v))}">Request this mine’s MSHA records →</button></div>
      <p class="note">Owned by a public company? Its annual report lists the mine by ID (Exhibit 95): <a href="https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(`"${ids.msha_mine}" OR "${String(ids.msha_mine).slice(0, 2)}-${String(ids.msha_mine).slice(2)}"`)}" target="_blank" rel="noopener">search SEC filings for ${esc(ids.msha_mine)}</a>.</p>
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
      ${pendingCardHtml(p)}
      ${permits.map(permitHtml).join('')}
      ${kyPermitsHtml(parse(p.ky_permits, []))}
      ${triInfo && triInfo.parent ? `<div class="row"><span class="lbl">Parent company (reported to EPA TRI)</span><span>${esc(triInfo.parent)}${triInfo.foreign_parent ? ' · foreign parent ' + esc(triInfo.foreign_parent) : ''}</span></div>` : ''}
      <div class="row"><span class="lbl">Last inspection, any EPA program</span><span>${esc(p.last_inspection || 'none on record')}</span></div>
      <div class="row"><span class="lbl">Formal enforcement, 5 yrs</span><span>${p.formal_actions_5y ?? '—'}</span></div>
      ${link ? `<div class="btns"><button type="button" class="btn" data-mine="${esc(link.mine_id)}">${link.confidence === 'high' ? 'Same Kentucky mine permit as' : 'Possibly the same site as'} mine: ${esc(link.mine)} →</button></div>` : ''}
      <p class="src">SOURCE: ${p.source_url ? `<a href="${esc(p.source_url)}" target="_blank" rel="noopener">EPA ECHO facility report</a>` : 'EPA ECHO'} · ICIS-NPDES permits, inspections and enforcement · ECHO effluent charts · pulled ${esc(p.as_of)}</p>
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
      <p class="eyebrow">${esc(String(p.kind || 'TRI facility').toUpperCase())}</p>
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
        const o = ops[h.operator_id || h.operator] ||= { id: h.operator_id, name: h.operator || 'Unnamed operator', mines: {} };
        const mm = o.mines[m.id] ||= { feat, periods: [] };
        mm.periods.push({ start: h.ctl_start || h.op_start || '', end: h.ctl_end || '', op_start: h.op_start, op_end: h.op_end });
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
    return `<div class="par-card"><p class="eyebrow">${esc(asName)}</p><div class="par-ent">${entLine(e)}${e.registered_at ? `<span class="when">LEI since ${esc(e.registered_at)}</span>` : ''}</div>
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
    const isPerson = (f.controller_type || '').toUpperCase().startsWith('P');
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
        <span class="nm">${esc(p.name)}</span><span class="ct">${num(p.citations || 0)} citations</span>
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
      panel = `<p class="eyebrow">MINE · ${esc((p.status || '').toUpperCase())}</p><h3 class="fp-ptitle">${esc(p.name)}</h3>
        <div class="fp-conf"><span>Link to this controller</span><b class="steel">High · agency record</b></div>
        <ol class="hist">${per.map((x) => `<li>Run by <b>${esc(x.op)}</b><span class="when">under this controller ${esc(x.start || '?')} → ${esc(x.end || 'now')}</span></li>`).join('')}</ol>
        ${violStats(mv, 'at this mine')}
        ${fairHtml(parse(p.fair, null))}
        ${parse(p.epa, []).map((e) => `<div class="fp-epa ${e.severity === 'high' ? 'hi' : ''}"><b>${esc(e.name)}</b><span class="when">EPA site, ${e.confidence === 'high' ? 'same Kentucky mine permit (high confidence)' : 'possibly the same place (' + esc(e.confidence) + ' confidence, inferred)'}: ${esc((e.basis || []).join(' · '))}</span>
          ${(e.permits || []).map((pm) => `<span class="when">Permit ${esc(pm.id)}: <span class="${pm.status_code === 'EXP' ? 'hot' : ''}">${esc(pm.status)}</span></span>`).join('')}
          ${(e.flags || []).length ? `<span class="when hot">⚑ ${e.flags.map((x) => esc(x.label)).join(' · ')}</span><button type="button" class="linkbtn" data-letter="${esc(regFacilityLetter(e, parse(p.ids, {})))}">Draft a records request →</button>` : ''}</div>`).join('')}
        <div class="btns"><button type="button" class="btn" data-fpmap="${esc(famState.sel.slice(2))}">Open on the map →</button></div>`;
    } else {
      panel = `<p class="eyebrow">WHY THESE ARE ONE FAMILY</p><h3 class="fp-ptitle">${personLabel(f.controller, f.controller_type)}</h3>
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
          <p class="eyebrow">CONTROLLER · ${esc((f.controller_type || 'unknown').toUpperCase())} · MSHA RECORDS</p>
          <h1 class="serif">${isPerson ? esc(f.controller) + ' <span class="muted-s" style="font-family:var(--sans);font-size:15px">(individual, as named in MSHA records)</span>' : esc(f.controller)}</h1>
          <p class="lede2">${num(allMines.length)} mine${allMines.length === 1 ? '' : 's'} pulled into one family from MSHA records · ${num(opList.length)} operating compan${opList.length === 1 ? 'y' : 'ies'} · ${esc(yr(M.first) || '?')}–${M.last ? esc(yr(M.last)) : 'now'}</p>
          <div class="fp-ids"><span>MSHA controller ${esc(f.controller_id)}</span>${opList.slice(0, 4).map((o) => o.id ? `<span class="pro">operator ${esc(o.id)}</span>` : '').join('')}${(() => { const l = leiFor([isPerson ? null : f.controller].filter(Boolean)); return l.length ? l.map((x) => `<span>LEI ${esc(x.e.lei)}</span>`).join('') : `<span>LEI · ${parents ? 'none found' : 'not linked yet'}</span>`; })()}<span>State registry · not linked yet</span></div>
        </div>
        <div class="btns"><button type="button" class="btn" data-fpmap="__all">Show on the map</button><button type="button" class="btn primary" data-letter="${esc(famLetter)}">Request MSHA records</button></div>
      </section>
      <section class="fp-kpis" aria-label="Family totals">
        ${kpi('Mines in family', num(allMines.length), `${num(active)} active now · ${num(opList.length)} companies`, 'MSHA · ' + esc(f.as_of))}
        ${kpi('Safety citations', num(v.total || 0), `${num(v.last5 || 0)} in the last 5 years`, 'MSHA violations', (v.last5 || 0) > 0 ? '' : '')}
        ${kpi('Serious (S&amp;S)', num(v.sig_sub || 0), 'likely to cause injury', 'MSHA violations')}
        ${kpi('Penalties owed', usd(v.due || 0), paidPct == null ? '—' : `${paidPct}% paid (${usd(v.paid || 0)})`, 'MSHA assessments', paidPct != null && paidPct < 50 ? 'hotk' : '')}
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
          <button type="button" class="fp-root ${famState.sel ? '' : 'sel'}" data-fpsel="">${esc(f.controller)}<span class="muted-s">Controller · MSHA ${esc(f.controller_id)}</span></button>
          <div class="fp-ops">${graph}</div>
        </div>
        <aside class="fp-panel" aria-live="polite">${panel}</aside>
      </section>
      <section class="fp-pats" aria-label="Patterns">
        <article class="pat coral"><span class="eyebrow">LIABILITY PATTERN</span><h3>Operator changes: ${num(changes)} of ${num(allMines.length)} mines</h3>
          <p>These mines changed operating company at least once.${bk.length ? ` Bankruptcy-court dockets found by name: ${bk.slice(0, 3).map((c) => `<a href="${esc(c.url || '#')}" target="_blank" rel="noopener">${esc(c.case)}</a> (${esc(c.court_id)}, ${esc(c.filed || '')})`).join('; ')}.` : ''}</p>
          <p class="emptynote">${courtsOn ? 'Reclamation-bond records: not collected yet' : 'Bankruptcy records need a free CourtListener token · bond records not collected yet'}</p></article>
        <article class="pat amber"><span class="eyebrow">SILENCE DETECTOR</span><h3>${highEpa.length ? num(highEpa.length) + ' high-priority EPA site' + (highEpa.length === 1 ? '' : 's') : 'No high-priority EPA flags'}</h3>
          ${highEpa.slice(0, 2).map((e) => `<p><b>${esc(e.name)}</b> · ${esc((e.flags || [])[0]?.label || '')}</p>`).join('') || '<p>No linked EPA site has a high-priority flag.</p>'}
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
      <section class="fp-time"><h2 class="serif">Who ran what, when</h2><p class="muted-s">Each bar is an operating company while this controller held it (MSHA controller records). Open bars are still running.</p>${timeline}</section>
      <p class="src">SOURCES: MSHA Controller/Operator History, Violations, Inspections, Production · EPA ECHO + ICIS-NPDES (inferred site links) · USAspending, FEC, lobbying reports, CourtListener, GLEIF, Kentucky Secretary of State (matched by name) · Kentucky mine permits · pulled ${esc(f.as_of)}. “Linked to” never means “did this.” Not legal advice.</p>
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
      <p class="note">${isC ? 'A draft to help you take part in a public process. Not legal advice. A local legal aid office or law-school clinic can help with hearings and appeals.' : 'A draft to help you ask for public records. Not legal advice. Talk to legal aid or a lawyer about anything beyond a records request.'}</p>`);
    $('copyLetter').onclick = async () => { try { await navigator.clipboard.writeText($('letterBox').value); $('copyLetter').textContent = 'Copied'; } catch (err) { $('letterBox').select(); } };
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

  let pendingMap = null;
  let markReady; const ready = new Promise((r) => (markReady = r));
  map.on('load', () => loadData().then(markReady, markReady));

  // ---- Home page vs map (hash routing: '' = home, '#map', '#map/harlan', '#map/flint', '#map/flags')
  const PLACES = { harlan: { center: [-83.25, 36.87], zoom: 10 }, flint: { center: [-83.69, 43.01], zoom: 11 } };
  async function route() {
    const h = location.hash.replace(/^#/, '');
    const onMap = h.startsWith('map');
    const onFam = h.startsWith('family/');
    document.body.classList.toggle('on-home', !onMap && !onFam);
    document.body.classList.toggle('on-family', onFam);
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
})();
