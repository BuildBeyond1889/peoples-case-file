#!/usr/bin/env python3
"""People's Case File collector.

Pulls public records, archives every raw file unchanged (with a SHA-256 and the
source URL + pull time), and builds the small files the website reads.

Sources so far:
  * MSHA Open Government Data: Mines + Controller/Operator History (bulk files).
    This is the backbone of the Curtain Puller for mining: who operated and who
    controlled every mine, with start and end dates, back to 1983.
  * EPA ECHO: regulated facilities in each pilot area (REST service).

Rules (see CLAUDE.md):
  * Raw files are archived unchanged. Never overwrite a snapshot.
  * Records are joined on official IDs (MSHA mine / operator / controller IDs,
    EPA FRS registry IDs), never on names.
  * Every published fact carries source, source_url, as_of.
  * A source that fails must not kill the run.

Standard library only, so it runs anywhere.
"""
import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARCHIVE = os.path.join(ROOT, 'archive')
OUT = os.path.join(ROOT, 'site', 'data')
TODAY = dt.date.today().isoformat()
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'

# Pilot areas. bbox = [min_lon, min_lat, max_lon, max_lat]
AREAS = {
    'flint-mi': {'bbox': [-83.80, 42.95, -83.60, 43.10]},
    'harlan-ky': {'bbox': [-83.55, 36.70, -82.95, 37.05], 'msha': {'state': 'KY', 'county': 'HARLAN'}},
}

csv.field_size_limit(10 ** 9)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def fetch(url, params=None, headers=None, timeout=300):
    if params:
        url = url + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'User-Agent': UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
    if body[:2] == b'\x1f\x8b':      # some servers gzip even when not asked
        import gzip
        body = gzip.decompress(body)
    time.sleep(1)  # be polite
    return url, body


def archive(source, name, url, body):
    """Save raw bytes exactly as received, plus provenance in manifest.json."""
    d = os.path.join(ARCHIVE, source, TODAY)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, name)
    if not os.path.exists(path):  # never overwrite a snapshot
        with open(path, 'wb') as f:
            f.write(body)
    man_path = os.path.join(d, 'manifest.json')
    man = json.load(open(man_path)) if os.path.exists(man_path) else []
    if not any(m['file'] == name for m in man):
        man.append({'file': name, 'url': url, 'pulled_utc': dt.datetime.utcnow().isoformat() + 'Z',
                    'sha256': hashlib.sha256(body).hexdigest(), 'bytes': len(body)})
        json.dump(man, open(man_path, 'w'), indent=1)
    return path


# ---------------------------------------------------------------- MSHA ----
MSHA_INDEX = 'https://arlweb.msha.gov/OpenGovernmentData/OGIMSHA.asp'
MSHA_BASE = 'https://arlweb.msha.gov/OpenGovernmentData/'


def msha_links():
    """Find the dataset zip links on MSHA's index page instead of guessing file names."""
    url, body = fetch(MSHA_INDEX)
    archive('msha', 'index.html', url, body)
    html = body.decode('latin-1')
    links = sorted(set(re.findall(r'href=["\']([^"\']+?\.zip)["\']', html, re.I)))
    full = [urllib.parse.urljoin(MSHA_BASE, l) for l in links]
    log('MSHA zip links found:\n  ' + '\n  '.join(full))
    return full


def pick(links, *words):
    for l in links:
        name = l.rsplit('/', 1)[-1].lower()
        if all(w in name for w in words):
            return l
    return None


def read_pipe_zip(body):
    """MSHA files: one pipe-delimited text file inside a zip, header on line 1."""
    z = zipfile.ZipFile(io.BytesIO(body))
    name = [n for n in z.namelist() if n.lower().endswith(('.txt', '.csv'))][0]
    text = z.read(name).decode('latin-1')
    rows = csv.DictReader(io.StringIO(text), delimiter='|')
    rows.fieldnames = [f.strip().upper() for f in rows.fieldnames]
    log(f'  {name}: columns = {rows.fieldnames}')
    for r in rows:
        yield {k: (v or '').strip() for k, v in r.items() if k}


def col(row, *names):
    for n in names:
        if row.get(n):
            return row[n]
    return ''


def msha_date(s):
    """MSHA dates come as MM/DD/YYYY or YYYY-MM-DD. Return ISO or ''."""
    s = (s or '').strip()
    for fmt in ('%m/%d/%Y', '%Y-%m-%d', '%m/%d/%Y %H:%M:%S'):
        try:
            return dt.datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    return s


def coord(lat, lon):
    """Return (lon, lat) or None. MSHA longitudes are sometimes stored without the
    minus sign; a positive longitude for a US mine is flipped and flagged."""
    try:
        la, lo = float(lat), float(lon)
    except (TypeError, ValueError):
        return None, None
    flag = None
    if lo > 0:
        lo, flag = -lo, 'longitude sign corrected (stored positive)'
    if not (17 < la < 72 and -180 < lo < -60):
        return None, None
    return (round(lo, 5), round(la, 5)), flag


def money(v):
    try:
        return float(str(v).replace('$', '').replace(',', '') or 0)
    except ValueError:
        return 0.0


def new_tally():
    return {'total': 0, 'sig_sub': 0, 'last5': 0, 'proposed': 0.0, 'due': 0.0, 'paid': 0.0,
            'first': '', 'last': '', 'vacated': 0, 'contractor': 0, 'since2000': 0}


def add_viol(t, r, cutoff):
    day = msha_date(col(r, 'VIOLATION_ISSUE_DT'))
    if col(r, 'VACATE_DT'):
        t['vacated'] += 1          # vacated citations are kept out of the totals
        return
    t['total'] += 1
    if col(r, 'SIG_SUB').upper() in ('Y', 'YES'):
        t['sig_sub'] += 1
    if day and day >= cutoff:
        t['last5'] += 1
    if day and day >= '2000-01-01':
        t['since2000'] += 1
    t['proposed'] += money(col(r, 'PROPOSED_PENALTY'))
    t['due'] += money(col(r, 'AMOUNT_DUE'))
    t['paid'] += money(col(r, 'AMOUNT_PAID'))
    if day:
        t['first'] = min(t['first'] or day, day)
        t['last'] = max(t['last'], day)


def round_tally(t):
    for k in ('proposed', 'due', 'paid'):
        t[k] = round(t[k], 2)
    return t


def msha_violations(links, mine_ids):
    """Stream MSHA Violations.txt (very large) and tally only the pilot mines.
    Each citation is credited to the operator and controller MSHA recorded AT THE TIME it was issued."""
    url = next((l for l in links if l.lower().endswith('/violations.zip')), MSHA_BASE + 'DataSets/Violations.zip')
    url, body = fetch(url, timeout=900)
    archive('msha', 'Violations.zip', url, body)
    z = zipfile.ZipFile(io.BytesIO(body))
    name = [n for n in z.namelist() if n.lower().endswith(('.txt', '.csv'))][0]
    cutoff = str(int(TODAY[:4]) - 5) + TODAY[4:]
    by_mine, by_ctl, rows_seen = {}, {}, 0
    with z.open(name) as raw:
        reader = csv.reader(io.TextIOWrapper(raw, encoding='latin-1', newline=''), delimiter='|')
        header = [h.strip().upper() for h in next(reader)]
        log('  Violations columns:', header)
        for rec in reader:
            rows_seen += 1
            r = dict(zip(header, (x.strip() for x in rec)))
            mid = r.get('MINE_ID')
            if mid not in mine_ids:
                continue
            m = by_mine.setdefault(mid, new_tally())
            if 'contractor' in col(r, 'VIOLATOR_TYPE_CD').lower():
                m['contractor'] += 1   # cited to a contractor, not the operator
                continue
            add_viol(m, r, cutoff)
            cid = col(r, 'CONTROLLER_ID')
            if cid:
                c = by_ctl.setdefault(cid, dict(new_tally(), mines=set()))
                add_viol(c, r, cutoff)
                c['mines'].add(mid)
    for c in by_ctl.values():
        c['mines'] = len(c['mines'])
    log(f'  Violations: scanned {rows_seen:,} rows; {len(by_mine)} pilot mines with citations')
    return ({k: round_tally(v) for k, v in by_mine.items()},
            {k: round_tally(v) for k, v in by_ctl.items()}, cutoff)


def msha(areas):
    links = msha_links()
    mines_url = next((l for l in links if l.lower().endswith('/mines.zip')), None) or MSHA_BASE + 'DataSets/Mines.zip'
    hist_url = pick(links, 'controller') or pick(links, 'operator', 'hist')
    if not hist_url:
        raise RuntimeError('Controller/Operator History link not found on MSHA index page')

    url, body = fetch(mines_url)
    archive('msha', 'Mines.zip', url, body)
    mines = {}
    for r in read_pipe_zip(body):
        mines[r.get('MINE_ID')] = r

    url, body = fetch(hist_url)
    archive('msha', hist_url.rsplit('/', 1)[-1], url, body)
    history = {}
    for r in read_pipe_zip(body):
        history.setdefault(r.get('MINE_ID'), []).append(r)

    feats, families = [], {}
    for area_id, area in areas.items():
        sel = area.get('msha')
        if not sel:
            continue
        for mid, m in mines.items():
            if col(m, 'STATE', 'STATE_ABBR') != sel['state']:
                continue
            if sel['county'] not in col(m, 'FIPS_CNTY_NM', 'COUNTY_NM', 'COUNTY').upper():
                continue
            if col(m, 'COAL_METAL_IND') not in ('C', ''):
                continue
            hist = sorted(history.get(mid, []), key=lambda h: msha_date(col(h, 'OPERATOR_START_DT')))
            ops = [{
                'operator': col(h, 'OPERATOR_NAME'), 'operator_id': col(h, 'OPERATOR_ID'),
                'controller': col(h, 'CONTROLLER_NAME'), 'controller_id': col(h, 'CONTROLLER_ID'),
                'controller_type': col(h, 'CONTROLLER_TYPE'),
                'op_start': msha_date(col(h, 'OPERATOR_START_DT')), 'op_end': msha_date(col(h, 'OPERATOR_END_DT')),
                'ctl_start': msha_date(col(h, 'CONTROLLER_START_DT')), 'ctl_end': msha_date(col(h, 'CONTROLLER_END_DT')),
            } for h in hist]
            cur_ctl_id = col(m, 'CURRENT_CONTROLLER_ID', 'CONTROLLER_ID')
            cur_ctl = col(m, 'CURRENT_CONTROLLER_NAME', 'CONTROLLER_NAME')
            cur_op = col(m, 'CURRENT_OPERATOR_NAME', 'OPERATOR_NAME')
            name = col(m, 'CURRENT_MINE_NAME', 'MINE_NAME')
            status = col(m, 'CURRENT_MINE_STATUS', 'MINE_STATUS')
            # Families: group every mine ever under a controller, by controller ID (official ID, not name).
            for o in ops:
                if not o['controller_id']:
                    continue
                fam = families.setdefault(o['controller_id'], {
                    'controller_id': o['controller_id'], 'controller': o['controller'],
                    'controller_type': o['controller_type'], 'operators': {}, 'mines': {}})
                fam['operators'].setdefault(o['operator_id'], o['operator'])
                fam['mines'][mid] = name
            xy, flag = coord(col(m, 'LATITUDE'), col(m, 'LONGITUDE'))
            if not xy:
                continue
            feats.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': list(xy)}, 'properties': {
                'name': name or f'Mine {mid}',
                'kind': f"{col(m, 'CURRENT_MINE_TYPE', 'MINE_TYPE') or 'Mine'} coal mine · {status or 'status unknown'}",
                'status': status, 'operator': cur_op, 'parent': cur_ctl, 'parent_confidence': 'high (MSHA controller record)' if cur_ctl else None,
                'history': ops,
                'source': 'MSHA Open Government Data',
                'source_url': 'https://www.msha.gov/mine-data-retrieval-system',  # look up by mine ID
                'as_of': TODAY,
                'flags': [flag] if flag else [],
                'ids': {'msha_mine': mid, 'msha_controller': cur_ctl_id},
            }})
    viol_note = None
    try:
        by_mine, by_ctl, cutoff = msha_violations(links, {x['properties']['ids']['msha_mine'] for x in feats})
        for x in feats:
            x['properties']['viol'] = by_mine.get(x['properties']['ids']['msha_mine'], round_tally(new_tally()))
            x['properties']['citations'] = x['properties']['viol']['total']  # flat copy for map styling
        for cid, f in families.items():
            f['viol'] = by_ctl.get(cid)
        try:
            msha_fairness(links, feats)
        except Exception as e:
            log('MSHA fairness failed:', repr(e))
        viol_note = {'source': 'MSHA Violations (Open Government Data)', 'last5_from': cutoff,
                     'rule': 'Operator citations only; vacated citations excluded; each citation counted under the controller MSHA recorded when it was issued.'}
    except Exception as e:
        log('MSHA violations failed:', repr(e))
    for f in families.values():
        f['operators'] = [{'id': k, 'name': v} for k, v in f['operators'].items()]
        f['mines'] = [{'id': k, 'name': v} for k, v in f['mines'].items()]
        f['source'] = 'MSHA Controller/Operator History'
        f['as_of'] = TODAY
    log(f'MSHA: {len(feats)} mapped mines, {len(families)} controller families')
    fams = sorted(families.values(), key=lambda f: -len(f['mines']))
    multi_op = sum(1 for x in feats if len({h['operator_id'] for h in x['properties']['history']}) > 1)
    recent = sum(1 for x in feats if any((h['op_start'] or '') >= str(int(TODAY[:4]) - 5) for h in x['properties']['history'][1:]))
    active = sum(1 for x in feats if 'Active' in x['properties']['kind'])
    persons = sum(1 for f in fams if (f['controller_type'] or '').lower().startswith('p'))
    summary = {
        'pilot': 'Harlan County, KY (coal)', 'mapped_mines': len(feats), 'active_mines': active,
        'mines_with_more_than_one_operator': multi_op, 'mines_with_operator_change_last_5_years': recent,
        'controller_families': len(fams), 'controllers_that_are_people': persons,
        'top_controllers_by_mines': [{'controller': f['controller'], 'id': f['controller_id'], 'type': f['controller_type'],
                                      'mines': len(f['mines']), 'operators': len(f['operators'])} for f in fams[:15]],
    }
    if viol_note:
        summary['violations_rule'] = viol_note
        lead = sorted((f for f in fams if f.get('viol')), key=lambda f: -f['viol']['total'])[:15]
        summary['top_controllers_by_citations'] = [{'controller': f['controller'], 'id': f['controller_id'], 'type': f['controller_type'],
                                                    'citations': f['viol']['total'], 'sig_sub': f['viol']['sig_sub'],
                                                    'due': f['viol']['due'], 'paid': f['viol']['paid']} for f in lead]
    write_json('summary.json', summary)
    log('SUMMARY', json.dumps(summary, indent=1))
    return feats, fams


# ---------------------------------------------------------------- ECHO ----
ECHO = 'https://echodata.epa.gov/echo/echo_rest_services'
PAGES_URL = 'https://buildbeyond1889.github.io/peoples-case-file/'


_ECHO_COLS = None


def echo_columns():
    """Look up the column ids for the fields we need from ECHO's metadata service."""
    global _ECHO_COLS
    if _ECHO_COLS is not None:
        return _ECHO_COLS
    want = {'FacName', 'FacLat', 'FacLong', 'RegistryID', 'FacQtrsWithNC', 'FacTotalPenalties', 'FacSICDescs', 'FacSICCodes', 'FacNAICSCodes',
            # silence-detector inputs
            'FacSNCFlg', 'FacFormalActionCount', 'FacInspectionCount', 'FacDaysLastInspection', 'FacDateLastInspection',
            'FacDateLastFormalAction', 'FacDateLastPenalty', 'FacComplianceStatus', 'CWAComplianceStatus', 'CWAPermitTypes',
            'CWAFormalActionCount', 'CWAInspectionCount', 'CWADaysLastInspection', 'NPDESIDs', 'TRIIDs'}
    try:
        url, body = fetch(ECHO + '.metadata', {'output': 'JSON'})
        archive('echo', 'metadata.json', url, body)
        cols = json.loads(body).get('Results', {}).get('ResultColumns', [])
        # also take any permit-status / expiration column ECHO offers, so expired permits can be flagged
        extra = {c.get('ObjectName') for c in cols if re.search(r'Expir|PermitStatus|PermitStat', c.get('ObjectName') or '')}
        log('ECHO permit-status/expiry columns offered:', sorted(extra))
        want |= extra
        ids = [str(c.get('ColumnID')) for c in cols if c.get('ObjectName') in want]
        log('ECHO metadata columns matched:', [c.get('ObjectName') for c in cols if c.get('ObjectName') in want])
        _ECHO_COLS = ','.join(ids)
    except Exception as e:
        log('ECHO metadata failed:', repr(e))
        _ECHO_COLS = ''
    return _ECHO_COLS


def silence_flags(f):
    """Silence detector: patterns where the records show problems but little or no response.
    Each flag is a QUESTION worth asking, with its evidence, never an accusation."""
    flags = []
    qnc = _int(f.get('FacQtrsWithNC')) or 0
    snc = (f.get('FacSNCFlg') or '').upper() == 'Y'
    formal = _int(f.get('FacFormalActionCount'))
    pen = _num(f.get('FacTotalPenalties')) or 0
    days = _int(f.get('FacDaysLastInspection'))
    last_insp = f.get('FacDateLastInspection')
    if snc and formal == 0:
        flags.append({'code': 'serious_no_enforcement', 'label': 'Serious noncompliance, no formal enforcement',
                      'evidence': f'EPA flags significant noncompliance; formal enforcement actions in 5 years: 0'})
    if qnc >= 4 and pen == 0:
        flags.append({'code': 'violations_no_penalty', 'label': 'Repeated violations, no penalties',
                      'evidence': f'Out of compliance {qnc} of the last 12 quarters; penalties on record: $0'})
    if days is not None and days > 5 * 365:
        flags.append({'code': 'not_inspected', 'label': 'Not inspected in over 5 years',
                      'evidence': f'Last inspection on record: {last_insp or "unknown"} ({days // 365} years ago)'})
    elif (days is None and not last_insp) and qnc >= 4:
        flags.append({'code': 'no_inspection_record', 'label': 'No inspection on record',
                      'evidence': f'No inspection date in EPA data, while out of compliance {qnc} of 12 quarters'})
    for k, v in f.items():
        if re.search(r'Expir|PermitStatus|PermitStat', k) and v and 'expired' in str(v).lower():
            flags.append({'code': 'expired_permit', 'label': 'Permit marked expired',
                          'evidence': f'{k}: {v}' + (f'; still out of compliance {qnc} of 12 quarters' if qnc else '')})
            break
    return flags


def echo_facilities(area_id, bbox):
    url, body = fetch(ECHO + '.get_facilities', {
        'output': 'JSON', 'p_c1lon': bbox[0], 'p_c1lat': bbox[1], 'p_c2lon': bbox[2], 'p_c2lat': bbox[3],
    })
    archive('echo', f'{area_id}-query.json', url, body)
    qid = json.loads(body).get('Results', {}).get('QueryID')
    if not qid:
        log('ECHO: no QueryID; response keys:', list(json.loads(body).get('Results', {}).keys()))
        return []
    feats, page = [], 1
    while page <= 50:
        params = {'output': 'JSON', 'qid': qid, 'pageno': page}
        if echo_columns():
            params['qcolumns'] = echo_columns()
        url, body = fetch(ECHO + '.get_qid', params)
        archive('echo', f'{area_id}-qid-p{page}.json', url, body)
        facs = json.loads(body).get('Results', {}).get('Facilities', []) or []
        if page == 1 and facs:
            log('ECHO fields:', sorted(facs[0].keys()))
        for f in facs:
            try:
                lon, lat = float(f.get('FacLong')), float(f.get('FacLat'))
            except (TypeError, ValueError):
                continue
            frs = f.get('RegistryID')
            feats.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [lon, lat]}, 'properties': {
                'name': f.get('FacName'),
                'kind': f.get('FacSICDescs') or 'EPA-regulated facility',
                'sic': f.get('FacSICCodes') or '', 'naics': f.get('FacNAICSCodes') or '',
                # FacQtrsWithNC = number of quarters in non-compliance (recent 3 years), NOT a violation count.
                'qtrs_noncompliance': _int(f.get('FacQtrsWithNC')),
                'penalties': _num(f.get('FacTotalPenalties')),
                'flags': silence_flags(f),
                'flag_count': 0,
                'npdes_ids': [x for x in re.split(r'[\s,;]+', f.get('NPDESIDs') or '') if x],
                'qtrs_nc_raw': _int(f.get('FacQtrsWithNC')) or 0,
                'last_inspection': f.get('FacDateLastInspection') or None,
                'formal_actions_5y': _int(f.get('FacFormalActionCount')),
                'snc': (f.get('FacSNCFlg') or '').upper() == 'Y',
                'source': 'EPA ECHO',
                'source_url': f'https://echo.epa.gov/detailed-facility-report?fid={frs}' if frs else None,
                'as_of': TODAY,
                'ids': {'frs': frs},
            }})
        if not facs:
            break
        page += 1
    for x in feats:
        x['properties']['flag_count'] = len(x['properties']['flags'])  # flat copy for map styling
    return feats


def _int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _num(v):
    try:
        return float(str(v).replace('$', '').replace(',', ''))
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- main ----
# ------------------------------------------------- mine <-> EPA linking ----
STOP = {'mine', 'mines', 'mining', 'coal', 'llc', 'inc', 'co', 'corp', 'company', 'no', 'the', 'of', 'and',
        'energy', 'resources', 'ky', 'prep', 'plant', 'surface', 'underground', 'strip', 'auger', 'job', 'site'}


def tokens(*names):
    out = set()
    for n in names:
        for t in re.findall(r'[a-z0-9]+', (n or '').lower()):
            if len(t) > 2 and t not in STOP and not t.isdigit():
                out.add(t)
    return out


def meters(a, b):
    from math import radians, sin, cos, asin, sqrt
    lon1, lat1, lon2, lat2 = map(radians, (a[0], a[1], b[0], b[1]))
    h = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * asin(sqrt(h))


KY_PERMITS = 'https://kygisserver.ky.gov/arcgis/rest/services/WGS84WM_Services/Ky_Permitted_Mine_Boundaries_WGS84WM/MapServer/0/query'
KY_PERMIT_STATUS = {'ACT': 'Active', 'INACT': 'Inactive (reclaimed, forfeited or abandoned)', 'TRNS': 'Transferred (old number, replaced when ownership changed)',
                    'XREF': 'Record not found'}


def _in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][:2]
        xj, yj = ring[j][:2]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def _in_geom(x, y, g):
    polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
    for poly in polys:
        if poly and _in_ring(x, y, poly[0]) and not any(_in_ring(x, y, h) for h in poly[1:]):
            return True
    return False


def ky_permits(mines, facilities, bbox):
    """Kentucky Division of Mine Permits: permitted mine areas (polygons) with permit number and permittee.
    A mine and an EPA site inside the same permit area are tied by a state record, not just distance."""
    feats, offset = [], 0
    while True:
        url, body = fetch(KY_PERMITS, {'where': '1=1', 'geometry': ','.join(map(str, bbox)), 'geometryType': 'esriGeometryEnvelope',
                                       'inSR': 4326, 'outSR': 4326, 'spatialRel': 'esriSpatialRelIntersects',
                                       'outFields': 'PermitNo,PER_NAME,Type_Flag,ACT_INAC,MINE_STATU,DATE_ISS,ORIG_PERM,FeatCLS,Calc_Acres,PER_TYPE,PERM_ACT',
                                       'returnGeometry': 'true', 'geometryPrecision': 5, 'maxAllowableOffset': 0.0002,
                                       'f': 'geojson', 'resultOffset': offset, 'resultRecordCount': 1000}, timeout=300)
        archive('ky-mine-permits', f'ky-permits-{offset}.geojson', url, body)
        page = json.loads(body).get('features', [])
        feats += page
        if len(page) < 1000:
            break
        offset += 1000
    def rec(p):
        d = p.get('DATE_ISS')
        return {'permit': p.get('PermitNo'), 'permittee': (p.get('PER_NAME') or '').strip() or None,
                'status': KY_PERMIT_STATUS.get(p.get('Type_Flag'), p.get('Type_Flag')), 'flag': p.get('Type_Flag'),
                'state': p.get('ACT_INAC'), 'kind': {'SF': 'surface', 'UG': 'underground'}.get(p.get('FeatCLS'), p.get('FeatCLS')),
                'issued': dt.datetime.fromtimestamp(d / 1000, dt.timezone.utc).date().isoformat() if isinstance(d, (int, float)) else None,
                'original': p.get('ORIG_PERM'), 'acres': round(p.get('Calc_Acres') or 0)}
    index = []
    for f in feats:
        g = f.get('geometry')
        if not g or g['type'] not in ('Polygon', 'MultiPolygon'):
            continue
        xs = [pt[0] for poly in (g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]) for pt in poly[0]]
        ys = [pt[1] for poly in (g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]) for pt in poly[0]]
        index.append(((min(xs), min(ys), max(xs), max(ys)), g, rec(f.get('properties') or {})))
    def within(x, y):
        out = {}
        for (a, b, c, d), g, r in index:
            if a <= x <= c and b <= y <= d and _in_geom(x, y, g):
                out.setdefault(r['permit'], r)
        res = sorted(out.values(), key=lambda r: r['issued'] or '', reverse=True)
        return sorted(res, key=lambda r: r['flag'] == 'TRNS')
    nm = nf = 0
    for m in mines:
        hit = within(*m['geometry']['coordinates'])
        if hit:
            m['properties']['ky_permits'] = hit
            nm += 1
    for f in facilities:
        hit = within(*f['geometry']['coordinates'])
        if hit:
            f['properties']['ky_permits'] = hit
            nf += 1
    log(f'KY permits: {len(feats)} permit areas; {nm} mines and {nf} EPA sites sit inside one')
    layer = {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'geometry': g, 'properties': {**r, 'source': 'Kentucky Division of Mine Permits (permitted mine boundaries)',
                                                          'source_url': 'https://eec.ky.gov/Natural-Resources/Mining/Mine-Permits/Pages/maps-spatial-data.aspx',
                                                          'as_of': TODAY}}
        for _, g, r in index if r['flag'] != 'TRNS']}
    return {'permit_areas': len(feats), 'mines_inside': nm, 'epa_inside': nf}, layer


def link_mines_epa(mines, facilities, max_m=500):
    """Possible same-site matches between MSHA mines and EPA facilities.
    No shared official ID exists between the two systems, so every match is INFERRED and labelled:
    it needs location (within max_m) plus a coal-mining permit code or a shared distinctive name word."""
    grid = {}
    for m in mines:
        x, y = m['geometry']['coordinates']
        grid.setdefault((round(x, 2), round(y, 2)), []).append(m)
    links = 0
    for f in facilities:
        fx, fy = f['geometry']['coordinates']
        fp = f['properties']
        coal = fp.get('sic', '').startswith('12') or ' 12' in ' ' + fp.get('sic', '') or '2121' in fp.get('naics', '') \
            or 'coal' in (fp.get('kind') or '').lower()
        ftok = tokens(fp.get('name'))
        best = None
        fperm = {r['permit']: r for r in fp.get('ky_permits', [])}
        if fperm:
            for m in mines:
                mperm = {r['permit'] for r in m['properties'].get('ky_permits', [])}
                common = sorted(mperm & set(fperm))
                if not common:
                    continue
                d = meters((fx, fy), m['geometry']['coordinates'])
                r = fperm[common[0]]
                mp_ = m['properties']
                named = ftok & tokens(r.get('permittee'), mp_.get('name'), mp_.get('operator'), *[h.get('operator') for h in mp_.get('history', [])])
                if not (coal or named):
                    continue   # being inside a big permit area alone is not enough: stores and plants sit over old underground mines
                basis = [f"both inside Kentucky mine permit {r['permit']}" + (f" (permittee {r['permittee']})" if r.get('permittee') else ''), f'{int(d)} m apart']
                if coal:
                    basis.append('EPA lists it as coal mining')
                if named:
                    basis.append('shared name: ' + ', '.join(sorted(named)[:3]))
                conf = 'high' if coal else 'medium'
                cand = (2 if conf == 'high' else 1, -d, m, basis, conf, d)
                if best is None or cand[:2] > best[:2]:
                    best = cand
        for dx in (-0.01, 0, 0.01):
            for dy in (-0.01, 0, 0.01):
                for m in grid.get((round(fx + dx, 2), round(fy + dy, 2)), []):
                    d = meters((fx, fy), m['geometry']['coordinates'])
                    if d > max_m:
                        continue
                    mp = m['properties']
                    shared = ftok & tokens(mp.get('name'), mp.get('operator'), *[h.get('operator') for h in mp.get('history', [])])
                    if not (coal or shared):
                        continue
                    basis = [f'{int(d)} m apart']
                    if coal:
                        basis.append('EPA lists it as coal mining')
                    if shared:
                        basis.append('shared name: ' + ', '.join(sorted(shared)[:3]))
                    conf = 'medium' if (coal and (shared or d < 150)) else 'low'
                    cand = (1 if conf == 'medium' else 0, -d, m, basis, conf, d)
                    if best is None or cand[:2] > best[:2]:
                        best = cand
        if not best:
            continue
        _, _, m, basis, conf, d = best
        mp = m['properties']
        mp.setdefault('epa', []).append({
            'frs': fp['ids'].get('frs'), 'name': fp.get('name'), 'kind': fp.get('kind'),
            'qtrs_noncompliance': fp.get('qtrs_noncompliance'), 'penalties': fp.get('penalties'),
            'source_url': fp.get('source_url'), 'distance_m': int(d), 'basis': basis, 'confidence': conf,
            'flags': fp.get('flags', []), 'severity': fp.get('severity'), 'permits': fp.get('permits', []),
            'tri': fp.get('tri'), 'last_inspection': fp.get('last_inspection')})
        if fp.get('flag_level') == 2:
            mp['epa_flagged'] = True
        mp['has_epa'] = True
        fp['mine_link'] = {'mine_id': mp['ids']['msha_mine'], 'mine': mp.get('name'), 'basis': basis, 'confidence': conf}
        links += 1
    log(f'Mine<->EPA: {links} facilities linked to mines (inferred, labelled)')
    return links


# ------------------------------------------------ fair comparisons (MSHA) ----
def stream_pipe(body):
    z = zipfile.ZipFile(io.BytesIO(body))
    name = [n for n in z.namelist() if n.lower().endswith(('.txt', '.csv'))][0]
    with z.open(name) as raw:
        reader = csv.reader(io.TextIOWrapper(raw, encoding='latin-1', newline=''), delimiter='|')
        header = [h.strip().upper() for h in next(reader)]
        for rec in reader:
            yield dict(zip(header, (x.strip() for x in rec)))


def pct_rank(values, v):
    """Share of the group with a LOWER value (0-100)."""
    if not values:
        return None
    return round(100 * sum(1 for x in values if x < v) / len(values))


def msha_fairness(links, feats, min_insp=10):
    """Citations per inspection and per 100,000 tons, 2000 onward, ranked against the other pilot mines.
    Counts alone favour big, long-running mines; rates make the comparison fair."""
    ids = {x['properties']['ids']['msha_mine'] for x in feats}
    insp, hours = {}, {}
    url = next((l for l in links if l.lower().endswith('/inspections.zip')), MSHA_BASE + 'DataSets/Inspections.zip')
    url, body = fetch(url, timeout=900)
    archive('msha', 'Inspections.zip', url, body)
    for r in stream_pipe(body):
        mid = r.get('MINE_ID', '').strip('"')
        if mid in ids and (msha_date(r.get('INSPECTION_BEGIN_DT', '').strip('"')) or '') >= '2000-01-01':
            insp[mid] = insp.get(mid, 0) + 1
    url = next((l for l in links if l.lower().endswith('/minesprodyearly.zip')), MSHA_BASE + 'DataSets/MinesProdYearly.zip')
    url, body = fetch(url, timeout=600)
    archive('msha', 'MinesProdYearly.zip', url, body)
    tons, years = {}, {}
    for r in stream_pipe(body):
        mid = r.get('MINE_ID', '').strip('"')
        if mid not in ids:
            continue
        t = money(r.get('ANNUAL_COAL_PROD', '').strip('"'))
        if t > 0:
            tons[mid] = tons.get(mid, 0) + t
            years.setdefault(mid, set()).add(r.get('CALENDAR_YR', '').strip('"'))
    rows = []
    for x in feats:
        p = x['properties']
        mid = p['ids']['msha_mine']
        c = (p.get('viol') or {}).get('since2000', 0)
        fair = {'inspections': insp.get(mid, 0), 'tons': round(tons.get(mid, 0)), 'producing_years': len(years.get(mid, ())),
                'citations_2000': c, 'window': '2000 to now'}
        if fair['inspections'] >= min_insp:
            fair['per_inspection'] = round(c / fair['inspections'], 2)
        if fair['tons'] >= 100000:
            fair['per_100k_tons'] = round(c / (fair['tons'] / 100000), 2)
        p['fair'] = fair
        rows.append(fair)
    for key in ('per_inspection', 'per_100k_tons'):
        vals = [r[key] for r in rows if key in r]
        for r in rows:
            if key in r:
                r[key + '_pct'] = pct_rank(vals, r[key])
                r[key + '_n'] = len(vals)
    log(f'Fairness: {sum(1 for r in rows if "per_inspection" in r)} mines rated per inspection, '
        f'{sum(1 for r in rows if "per_100k_tons" in r)} per 100k tons')


# ------------------------------------------ EPA water permits (ICIS-NPDES) ----
NPDES_ZIP = 'https://echo.epa.gov/files/echodownloads/npdes_downloads.zip'
PERMIT_STATUS = {'EFF': 'Effective', 'EXP': 'Expired', 'ADC': 'Administratively continued (expired, kept in force while renewal is pending)',
                 'TRM': 'Terminated', 'RET': 'Retired', 'PND': 'Pending', 'NOT': 'Not needed'}


def stream_csv(z, name):
    with z.open(name) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding='latin-1', newline=''))


def last_quarters(n=12):
    y, q = int(TODAY[:4]), (int(TODAY[5:7]) - 1) // 3 + 1
    out = []
    for _ in range(n):
        out.append(f'{y}{q}')
        q -= 1
        if q == 0:
            y, q = y - 1, 4
    return set(out)


def npdes_enrich(facilities):
    """Attach water-permit status/expiration and pollution-vs-paperwork quarter counts, joined on NPDES ID."""
    want = {i for f in facilities for i in f['properties'].get('npdes_ids', [])}
    if not want:
        log('NPDES: facilities carry no NPDES IDs; skipping')
        return 0
    url, body = fetch(NPDES_ZIP, timeout=900)
    archive('epa-npdes', 'npdes_downloads.zip', url, body)
    z = zipfile.ZipFile(io.BytesIO(body))
    permits = {}
    for r in stream_csv(z, 'ICIS_PERMITS.csv'):
        pid = r.get('EXTERNAL_PERMIT_NMBR')
        if pid in want:
            v = _int(r.get('VERSION_NMBR')) or 0
            if pid not in permits or v >= permits[pid]['_v']:
                code = r.get('PERMIT_STATUS_CODE') or ''
                permits[pid] = {'_v': v, 'id': pid, 'status_code': code, 'status': PERMIT_STATUS.get(code, code or 'unknown'),
                                'expiration': msha_date(r.get('EXPIRATION_DATE')), 'issued': msha_date(r.get('ISSUE_DATE')),
                                'permit_name': r.get('PERMIT_NAME'), 'type': r.get('PERMIT_TYPE_CODE'),
                                'water_body': r.get('STATE_WATER_BODY_NAME') or None}
    qs = last_quarters(12)
    qn = {}
    for r in stream_csv(z, 'NPDES_QNCR_HISTORY.csv'):
        pid = r.get('NPDES_ID')
        if pid in want and r.get('YEARQTR') in qs:
            t = qn.setdefault(pid, {'effluent_qtrs': 0, 'reporting_qtrs': 0, 'other_qtrs': 0})
            if (_int(r.get('NUME90Q')) or 0) > 0:
                t['effluent_qtrs'] += 1          # pollution: discharge limits exceeded
            if (_int(r.get('NUMD8090Q')) or 0) > 0 or (_int(r.get('NUMPSCH')) or 0) > 0:
                t['reporting_qtrs'] += 1         # paperwork: missing reports / schedules
            if (_int(r.get('NUMCVDT')) or 0) > 0 or (_int(r.get('NUMSVCD')) or 0) > 0:
                t['other_qtrs'] += 1
    # Enforcement history per permit: inspections, informal (warning letters / NOVs), formal actions + penalties,
    # and single-event violations (spills, failed toxicity tests...) with the agency's own notes.
    since = str(int(TODAY[:4]) - 10)
    hist = {pid: {'inspections': [], 'informal': [], 'formal': [], 'events': []} for pid in want}
    for r in stream_csv(z, 'NPDES_INSPECTIONS.csv'):
        pid = r.get('NPDES_ID')
        if pid in hist:
            d = msha_date(r.get('ACTUAL_END_DATE') or r.get('ACTUAL_BEGIN_DATE'))
            hist[pid]['inspections'].append({'date': d, 'type': r.get('COMP_MONITOR_TYPE_DESC'), 'by': 'EPA' if r.get('STATE_EPA_FLAG') == 'E' else 'State'})
    for r in stream_csv(z, 'NPDES_INFORMAL_ENFORCEMENT_ACTIONS.csv'):
        pid = r.get('NPDES_ID')
        if pid in hist:
            hist[pid]['informal'].append({'date': msha_date(r.get('ACHIEVED_DATE')), 'type': r.get('ENF_TYPE_DESC'), 'by': r.get('AGENCY'), 'id': r.get('ENF_IDENTIFIER')})
    for r in stream_csv(z, 'NPDES_FORMAL_ENFORCEMENT_ACTIONS.csv'):
        pid = r.get('NPDES_ID')
        if pid in hist:
            hist[pid]['formal'].append({'date': msha_date(r.get('SETTLEMENT_ENTERED_DATE')), 'type': r.get('ENF_TYPE_DESC'), 'by': r.get('AGENCY'),
                                        'id': r.get('ENF_IDENTIFIER'), 'fed_penalty': _num(r.get('FED_PENALTY_ASSESSED_AMT')) or 0,
                                        'state_penalty': _num(r.get('STATE_LOCAL_PENALTY_AMT')) or 0})
    for r in stream_csv(z, 'NPDES_SE_VIOLATIONS.csv'):
        pid = r.get('NPDES_ID')
        if pid in hist:
            d = msha_date(r.get('SINGLE_EVENT_VIOLATION_DATE'))
            if (d or '') >= since:
                hist[pid]['events'].append({'date': d, 'what': r.get('VIOLATION_DESC'),
                                            'note': re.sub(r'\s+', ' ', (r.get('SINGLE_EVENT_VIOLATION_COMMENT') or '')).strip()[:400] or None})
    for h in hist.values():
        for k in h:
            h[k].sort(key=lambda x: x.get('date') or '', reverse=True)
    n = 0
    for f in facilities:
        fp = f['properties']
        plist = []
        for pid in fp.get('npdes_ids', []):
            if pid in permits:
                pm = {k: v for k, v in permits[pid].items() if k != '_v'}
                pm.update(qn.get(pid, {}))
                h = hist.get(pid, {})
                ins = h.get('inspections', [])
                pm['inspections'] = {'count': len(ins), 'last': ins[0]['date'] if ins else None, 'recent': ins[:5]}
                c5 = str(int(TODAY[:4]) - 5) + TODAY[4:]
                inf = h.get('informal', [])
                pm['informal'] = {'count': len(inf), 'last5': sum(1 for x in inf if (x.get('date') or '') >= c5), 'recent': inf[:8]}
                fo = h.get('formal', [])
                pm['formal'] = {'count': len(fo), 'last5': sum(1 for x in fo if (x.get('date') or '') >= c5),
                                'penalties': round(sum(x['fed_penalty'] + x['state_penalty'] for x in fo)), 'recent': fo[:8]}
                pm['events'] = h.get('events', [])[:12]
                plist.append(pm)
        if not plist:
            continue
        n += 1
        fp['permits'] = plist
        fp['effluent_qtrs'] = max((p.get('effluent_qtrs', 0) for p in plist), default=0)
        cut5 = str(int(TODAY[:4]) - 5) + TODAY[4:]
        warns = sum(p['informal']['last5'] for p in plist)
        formal5 = sum(p['formal']['last5'] for p in plist)
        if warns >= 3 and formal5 == 0:
            fp['flags'].append({'code': 'warnings_only', 'label': 'Warning letters only, no formal action',
                                'evidence': f'{warns} warning letters / notices of violation in 5 years; formal enforcement actions in 5 years: 0'})
        for pm in plist:
            if pm['status_code'] == 'EXP':
                ev = f"Permit {pm['id']} status: Expired (expiration {pm['expiration'] or 'unknown'})"
                if fp.get('qtrs_nc_raw'):
                    ev += f"; still out of compliance {fp['qtrs_nc_raw']} of 12 quarters"
                if pm.get('effluent_qtrs'):
                    ev += f"; discharge limits exceeded in {pm['effluent_qtrs']} of the last 12 quarters"
                fp['flags'].append({'code': 'expired_permit', 'label': 'Permit expired, still reporting violations' if fp.get('qtrs_nc_raw') else 'Permit expired', 'evidence': ev})
                break
    log(f'NPDES: {len(permits)} permits matched; {n} facilities enriched')
    refine_inspection_flags(facilities)
    return n


def refine_inspection_flags(facilities):
    """Tighten 'not inspected': only where it matters (a live water permit or a record of problems),
    using the permit's own inspection history when we have it. Not being inspected is only a silence
    if there was something to look at."""
    cut5 = str(int(TODAY[:4]) - 5) + TODAY[4:]
    dropped = kept = 0
    for f in facilities:
        fp = f['properties']
        flags = fp.get('flags', [])
        if not any(x['code'] in ('not_inspected', 'no_inspection_record') for x in flags):
            continue
        plist = fp.get('permits') or []
        live = [p for p in plist if p.get('status_code') in ('EFF', 'ADC', 'EXP', 'NON', 'PND')]
        problems = (fp.get('qtrs_nc_raw') or 0) >= 4 or (fp.get('effluent_qtrs') or 0) > 0 or any(p.get('events') for p in plist)
        last = max((p.get('inspections', {}).get('last') or '' for p in plist), default='') if plist else ''
        flags = [x for x in flags if x['code'] not in ('not_inspected', 'no_inspection_record')]
        if (live or not plist) and problems and (not last or last < cut5):
            if last:
                flags.append({'code': 'not_inspected', 'label': 'Problems on record, not inspected in over 5 years',
                              'evidence': f'Last water-permit inspection: {last}; ' + (f"discharge limits exceeded in {fp.get('effluent_qtrs')} of the last 12 quarters" if fp.get('effluent_qtrs') else f"out of compliance {fp.get('qtrs_nc_raw') or 0} of 12 quarters")})
            else:
                flags.append({'code': 'no_inspection_record', 'label': 'Problems on record, no inspection on record',
                              'evidence': ('No inspection in the permit history' if plist else 'No inspection date in EPA data') + f"; out of compliance {fp.get('qtrs_nc_raw') or 0} of 12 quarters"})
            kept += 1
        else:
            dropped += 1
        fp['flags'] = flags
    log(f'Inspection flags: kept {kept} where there were problems to inspect; dropped {dropped} with nothing on record to look at')


EFF_URL = 'https://echodata.epa.gov/echo/eff_rest_services.download_effluent_chart'


def effluent(facilities, max_permits=150, refresh_days=14, years=3):
    """How far over the limit: monthly Discharge Monitoring Reports for permits that exceeded limits, from ECHO Effluent Charts.
    Each exceedance is a reading the facility itself reported above its permit limit (EPA computes the %)."""
    prev = {}
    try:
        prev = json.loads(fetch(PAGES_URL + 'data/effluent.json')[1]).get('by_permit', {})
    except Exception as e:
        log('Effluent: no previous run to reuse', repr(e))
    cutoff = (dt.date.fromisoformat(TODAY) - dt.timedelta(days=refresh_days)).isoformat()
    start = (dt.date.fromisoformat(TODAY) - dt.timedelta(days=365 * years)).strftime('%m/%d/%Y')
    end = dt.date.fromisoformat(TODAY).strftime('%m/%d/%Y')
    cands = []
    for f in facilities:
        for pm in f['properties'].get('permits', []) or []:
            if pm.get('effluent_qtrs') or f['properties'].get('flag_level') == 2:
                cands.append((pm.get('effluent_qtrs') or 0, pm['id']))
    cands = [pid for _, pid in sorted(set(cands), reverse=True)][:max_permits]
    out = {'as_of': TODAY, 'window': [start, end], 'source': 'EPA ECHO Effluent Charts (Discharge Monitoring Reports)',
           'rule': 'Counted once per reported value above a permit limit. Exceedance % is EPA\'s: how far the reported value was over the limit.',
           'by_permit': {}}
    fresh = 0
    for pid in cands:
        old = prev.get(pid)
        if old and old.get('checked', '') >= cutoff:
            out['by_permit'][pid] = old
            continue
        try:
            url, body = fetch(EFF_URL, {'p_id': pid, 'start_date': start, 'end_date': end}, timeout=300)
        except Exception as e:
            log('Effluent failed for', pid, repr(e))
            if old:
                out['by_permit'][pid] = old
            continue
        fresh += 1
        archive('epa-effluent', f'effluent-{pid}.csv', url, body)
        seen, params, months = set(), {}, set()
        for r in csv.DictReader(io.StringIO(body.decode('latin-1'))):
            pct = _num(r.get('exceedence_pct'))
            if not pct or pct <= 0:
                continue
            key = r.get('dmr_value_id') or (r.get('parameter_code'), r.get('monitoring_period_end_date'), r.get('statistical_base_code'), r.get('perm_feature_nmbr'))
            if key in seen:
                continue
            seen.add(key)
            d = msha_date(r.get('monitoring_period_end_date'))
            months.add((d or '')[:7])
            p = params.setdefault(r.get('parameter_desc') or r.get('parameter_code'), {'count': 0, 'pcts': [], 'last': None, 'worst': None})
            p['count'] += 1
            p['pcts'].append(pct)
            if (d or '') > (p['last'] or ''):
                p['last'] = d
            if not p['worst'] or pct > p['worst']['pct']:
                p['worst'] = {'pct': pct, 'date': d, 'value': r.get('dmr_value_standard_units') or r.get('dmr_value_nmbr'),
                              'limit': r.get('limit_value_standard_units') or r.get('limit_value_nmbr'),
                              'unit': r.get('standard_unit_desc') or r.get('limit_unit_desc'), 'stat': r.get('statistical_base_short_desc'),
                              'outfall': r.get('perm_feature_nmbr')}
        plist = []
        for name, p in params.items():
            pc = sorted(p['pcts'])
            plist.append({'name': name, 'count': p['count'], 'max_pct': round(pc[-1]), 'median_pct': round(pc[len(pc) // 2]),
                          'last': p['last'], 'worst': p['worst']})
        plist.sort(key=lambda x: (-x['count'], -x['max_pct']))
        out['by_permit'][pid] = {'checked': TODAY, 'exceedances': len(seen), 'months': len(months - {''}),
                                 'parameters': plist[:10],
                                 'url': f'https://echo.epa.gov/trends/loading-tool/reports/effluent-charts#{pid}'}
    log(f'Effluent: {len(out["by_permit"])} permits ({fresh} refreshed); '
        f'{sum(1 for v in out["by_permit"].values() if v.get("exceedances"))} with readings over their limits')
    for f in facilities:
        for pm in f['properties'].get('permits', []) or []:
            e = out['by_permit'].get(pm['id'])
            if e:
                pm['exceed'] = {k: e[k] for k in ('exceedances', 'months', 'parameters', 'url')}
    return out


SEVERE = {'serious_no_enforcement', 'expired_permit'}  # warnings_only becomes high when paired with real pollution (effluent_qtrs)


def rank_flags(facilities):
    """high = serious response gap or pollution; medium = everything else flagged."""
    for f in facilities:
        fp = f['properties']
        flags = fp.get('flags', [])
        level = 0
        if flags:
            level = 1
            codes = {x['code'] for x in flags}
            eff = fp.get('effluent_qtrs', 0)
            qnc = fp.get('qtrs_nc_raw', 0)
            if codes & SEVERE or eff >= 2 or (('violations_no_penalty' in codes) and qnc >= 8) or ('not_inspected' in codes and qnc >= 4):
                level = 2
        fp['flag_level'] = level
        fp['severity'] = {2: 'high', 1: 'medium'}.get(level)
        fp['flag_count'] = len(flags)


# --------------------------------------------- Envirofacts: TRI + SDWIS ----
EF = 'https://data.epa.gov/efservice/'
EF_AREAS = {'harlan-ky': {'state': 'KY', 'county': 'Harlan', 'center': [-83.32, 36.86], 'label': 'Harlan County, KY', 'box': [-83.65, 36.55, -82.85, 37.15],
                          'towns': ['HARLAN', 'CUMBERLAND', 'EVARTS', 'BENHAM', 'LYNCH', 'LOYALL', 'WALLINS CREEK', 'BAXTER', 'TOTZ', 'PUTNEY']},
            'flint-mi': {'state': 'MI', 'county': 'Genesee', 'center': [-83.69, 43.02], 'label': 'Genesee County, MI (Flint)', 'box': [-84.05, 42.75, -83.40, 43.25]}}


def ef(path, name):
    url, body = fetch(EF + path, timeout=180)
    archive('envirofacts', name, url, body)
    data = json.loads(body)
    return data if isinstance(data, list) else []


def tri(facilities):
    by_frs = {f['properties']['ids'].get('frs'): f for f in facilities}
    feats = []
    for aid, a in EF_AREAS.items():
        rows = ef(f"tri_facility/state_abbr/{a['state']}/county_name/{a['county'].upper()}/JSON", f'tri-{aid}.json')
        for r in rows:
            parent = r.get('standardized_parent_company') or (r.get('parent_co_name') if r.get('parent_co_name') not in (None, 'NA') else None)
            frs = r.get('epa_registry_id') or r.get('frs_id')
            info = {'tri_id': r.get('tri_facility_id'), 'parent': parent, 'closed': r.get('fac_closed_ind') == '1',
                    'foreign_parent': r.get('foreign_parent_co_name') if r.get('foreign_parent_co_name') not in (None, 'NA') else None}
            lat = r.get('pref_latitude') or r.get('fac_latitude')
            lon = r.get('pref_longitude') or r.get('fac_longitude')
            echo = by_frs.get(frs)
            if echo:
                echo['properties']['tri'] = info      # same FRS ID: official join, high confidence
            xy, note = None, None
            def dms(v):
                # some TRI rows store degrees-minutes-seconds packed as DDMMSS (e.g. 425439 = 42°54'39")
                v = abs(float(v))
                if v > 1000:
                    d, rem = divmod(v, 10000)
                    m, sec = divmod(rem, 100)
                    return d + m / 60 + sec / 3600, True
                return v, False
            try:
                la, c1 = dms(lat)
                lo, c2 = dms(lon)
                xy = [-round(lo, 6), round(la, 6)]
                if c1 or c2:
                    note = 'TRI location was stored as degrees-minutes-seconds; converted'
            except (TypeError, ValueError):
                pass
            b = a['box']
            if xy and not (b[0] <= xy[0] <= b[2] and b[1] <= xy[1] <= b[3]):
                note = f'TRI location {lat}, {lon} is outside {a["label"]}; '  # noqa
                xy = None
            if not xy and echo:
                xy = echo['geometry']['coordinates']
                note = (note or '') + 'shown at the EPA facility location (same FRS ID)'
            if not xy:
                log('TRI: dropped (no usable location):', r.get('facility_name'), lat, lon)
                continue
            feats.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': xy}, 'properties': {
                'name': r.get('facility_name'), 'kind': 'Toxics Release Inventory facility' + (' (closed)' if info['closed'] else ''),
                'tri': info, 'city': r.get('city_name'), 'flags': [note] if note else [],
                'source': 'EPA Toxics Release Inventory (Envirofacts)',
                'source_url': f'https://echo.epa.gov/detailed-facility-report?fid={frs}' if frs else None,
                'as_of': TODAY, 'ids': {'tri': r.get('tri_facility_id'), 'frs': frs}}})
    log(f'TRI: {len(feats)} facilities mapped')
    return feats


TRI_BASIC = 'https://data.epa.gov/efservice/downloads/tri/mv_tri_basic_download/{year}_{state}/csv'


def tri_releases(tri_feats, years=10):
    """Pounds released per facility per year (TRI Basic files, one per state and year), and the latest year's chemicals.
    Self-reported by the facility to EPA. Releases are legal unless they break a permit; this shows amounts, not violations."""
    want = {f['properties']['ids'].get('tri'): f for f in tri_feats if f['properties']['ids'].get('tri')}
    if not want:
        return 0
    states = sorted({a['state'] for a in EF_AREAS.values()})
    agg = {}
    y0 = int(TODAY[:4]) - 1
    for state in states:
        for year in range(y0, y0 - years - 1, -1):
            try:
                url, body = fetch(TRI_BASIC.format(year=year, state=state), timeout=300)
            except Exception as e:
                log(f'TRI basic {year} {state}: not available ({e!r})')
                continue
            if len(body) < 500:
                continue
            archive('epa-tri-basic', f'tri-basic-{year}-{state}.csv', url, body)
            rd = csv.reader(io.StringIO(body.decode('latin-1')))
            head = [re.sub(r'^\d+\.\s*', '', h).strip().upper() for h in next(rd)]
            def ix(*names):
                for n in names:
                    if n in head:
                        return head.index(n)
                return None
            I = {k: ix(*v) for k, v in {'id': ('TRIFD',), 'chem': ('CHEMICAL',), 'unit': ('UNIT OF MEASURE',),
                                         'fug': ('5.1 - FUGITIVE AIR',), 'stack': ('5.2 - STACK AIR',), 'water': ('5.3 - WATER',),
                                         'onsite': ('ON-SITE RELEASE TOTAL',), 'offsite': ('OFF-SITE RELEASE TOTAL', 'OFF-SITE RELEASE TOTALS'),
                                         'total': ('TOTAL RELEASES',), 'carc': ('CARCINOGEN',), 'pfas': ('PFAS',), 'pbt': ('PBT',)}.items()}
            if I['id'] is None or I['chem'] is None:
                log('TRI basic: unexpected columns', head[:10])
                continue
            hits = 0
            for r in rd:
                fid = r[I['id']] if len(r) > I['id'] else None
                if fid not in want:
                    continue
                hits += 1
                g = lambda k: (_num(r[I[k]]) or 0) if I[k] is not None and I[k] < len(r) else 0
                k = 1 / 453.59237 if (r[I['unit']] if I['unit'] is not None else '').lower().startswith('gram') else 1
                tot = g('total') or (g('onsite') + g('offsite'))
                a = agg.setdefault(fid, {}).setdefault(year, {'total': 0, 'air': 0, 'water': 0, 'chems': {}})
                a['total'] += tot * k
                a['air'] += (g('fug') + g('stack')) * k
                a['water'] += g('water') * k
                c = a['chems'].setdefault(r[I['chem']], {'lbs': 0, 'air': 0, 'water': 0, 'carcinogen': False, 'pfas': False, 'pbt': False})
                c['lbs'] += tot * k
                c['air'] += (g('fug') + g('stack')) * k
                c['water'] += g('water') * k
                for flag in ('carc', 'pfas', 'pbt'):
                    if I[flag] is not None and I[flag] < len(r) and r[I[flag]].upper() in ('YES', 'Y', 'TRUE'):
                        c['carcinogen' if flag == 'carc' else flag] = True
            log(f'TRI basic {year} {state}: {hits} rows for our facilities')
    n = 0
    for fid, by_year in agg.items():
        f = want[fid]
        latest = max(by_year)
        ch = sorted(by_year[latest]['chems'].items(), key=lambda kv: -kv[1]['lbs'])
        f['properties']['releases'] = {
            'unit': 'pounds', 'source': 'EPA TRI Basic Data Files (self-reported by the facility)',
            'source_url': f'https://enviro.epa.gov/triexplorer/release_fac_profile?TRI={fid}',
            'by_year': {str(y): round(v['total']) for y, v in sorted(by_year.items())},
            'latest_year': latest, 'latest_total': round(by_year[latest]['total']),
            'latest_air': round(by_year[latest]['air']), 'latest_water': round(by_year[latest]['water']),
            'chemicals': [{'name': k, 'lbs': round(v['lbs'], 1), 'air': round(v['air'], 1), 'water': round(v['water'], 1),
                           'carcinogen': v['carcinogen'], 'pfas': v['pfas'], 'pbt': v['pbt']} for k, v in ch[:10]],
            'chemical_count': len(ch)}
        n += 1
    log(f'TRI releases: amounts for {n} of {len(want)} facilities')
    return n


VIOL_CAT = {'MCL': 'Over the legal limit', 'MRDL': 'Over the disinfectant limit', 'TT': 'Treatment technique not met',
            'MR': 'Monitoring or reporting', 'MON': 'Monitoring', 'RPT': 'Reporting', 'Other': 'Other'}


def sdwis():
    out = []
    cutoff = str(int(TODAY[:4]) - 5) + TODAY[4:]
    for aid, a in EF_AREAS.items():
        areas = []
        for cty in (a['county'], a['county'].upper(), a['county'] + ' County', a['county'].upper() + ' COUNTY'):
            areas = ef(f"GEOGRAPHIC_AREA/STATE_SERVED/{a['state']}/COUNTY_SERVED/{urllib.parse.quote(cty)}/JSON", f'sdwis-geo-{aid}.json')
            if areas:
                break
        if not areas:
            # some states record city, not county: sample what this state uses so it can be fixed
            sample = ef(f"GEOGRAPHIC_AREA/STATE_SERVED/{a['state']}/rows/0:400/JSON", f'sdwis-geo-sample-{aid}.json')
            log(f"SDWIS {aid}: no rows for county; sample counties:", sorted({str(r.get('county_served')) for r in sample})[:40])
            log(f"SDWIS {aid}: sample cities:", sorted({str(r.get('city_served')) for r in sample if 'ARLAN' in str(r.get('city_served')).upper() or 'ARLAN' in str(r.get('county_served')).upper()}))
        log(f"SDWIS {aid}: {len(areas)} area rows; activity/type mix:", sorted({(r.get('pws_activity_code'), r.get('pws_type_code')) for r in areas}))
        pwsids = sorted({r['pwsid'] for r in areas if r.get('pws_activity_code') == 'A' and r.get('pws_type_code') == 'CWS'})  # community systems (homes)
        basis = 'county served (EPA SDWIS)'
        if not pwsids and a.get('towns'):
            # Kentucky's active systems often lack a county-served record; fall back to the system's listed city
            for town in a['towns']:
                for w in ef(f"WATER_SYSTEM/STATE_CODE/{a['state']}/CITY_NAME/{urllib.parse.quote(town)}/JSON", f"sdwis-city-{aid}-{town.replace(' ', '_')}.json"):
                    if w.get('pws_activity_code') == 'A' and w.get('pws_type_code') == 'CWS':
                        pwsids.append(w['pwsid'])
            pwsids = sorted(set(pwsids))
            basis = "system's listed city is in the county (county-served records missing)"
        systems = []
        for pid in pwsids:
            ws = ef(f'WATER_SYSTEM/PWSID/{pid}/JSON', f'sdwis-ws-{pid}.json')
            if not ws:
                continue
            w = ws[0]
            v = ef(f'VIOLATION/PWSID/{pid}/JSON', f'sdwis-viol-{pid}.json')
            def day(x):
                return (x.get('compl_per_begin_date') or '')[:10]
            recent = [x for x in v if day(x) >= cutoff]
            systems.append({
                'pwsid': pid, 'name': w.get('pws_name'), 'type': w.get('pws_type_code'), 'source': w.get('gw_sw_code'),
                'population': w.get('population_served_count'), 'city': w.get('city_name'),
                'violations': len(v), 'health_based': sum(1 for x in v if x.get('is_health_based_ind') == 'Y'),
                'last5': len(recent), 'health_last5': sum(1 for x in recent if x.get('is_health_based_ind') == 'Y'),
                'lead_copper': sum(1 for x in v if str(x.get('rule_code')) == '350'),
                'open': sum(1 for x in v if x.get('compliance_status_code') in ('O', 'K')),
                'by_category': {VIOL_CAT.get(k, k): sum(1 for x in v if x.get('violation_category_code') == k)
                                for k in sorted({x.get('violation_category_code') for x in v if x.get('violation_category_code')})},
                'latest': max((day(x) for x in v), default=None),
            })
        systems.sort(key=lambda s: (-(s['health_last5']), -(s['health_based']), -(s['population'] or 0)))
        out.append({'area': aid, 'label': a['label'], 'center': a['center'], 'systems': systems, 'basis': basis,
                    'source': 'EPA Safe Drinking Water Information System (Envirofacts)', 'as_of': TODAY})
        log(f"SDWIS {aid}: {len(systems)} active systems")
    feats = [{'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': o['center']}, 'properties': {
        'name': 'Water systems serving ' + o['label'], 'area': o['area'], 'kind': 'Drinking water systems',
        'count': len(o['systems']), 'health_last5': sum(s['health_last5'] for s in o['systems'])}} for o in out]
    return out, feats


# ------------------------------------- money in, money out, courts (by name) ----
# None of these sources share an ID with MSHA, so every match is BY NAME and labelled:
#   medium = same name after removing suffixes AND a KY/VA/WV/TN address; low = similar name only (not counted).
SUFFIX = re.compile(r'\b(llc|l\.l\.c|inc|incorporated|co|corp|corporation|company|ltd|lp|llp|the|of)\b\.?', re.I)
REGION = {'KY', 'VA', 'WV', 'TN'}


def norm_name(n):
    n = SUFFIX.sub(' ', (n or '').lower())
    return ' '.join(re.findall(r'[a-z0-9]+', n))


def post_json(url, body, timeout=90):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={'User-Agent': UA, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = r.read()
    time.sleep(0.6)
    return out


AWARD_GROUPS = {'contracts': ['A', 'B', 'C', 'D'], 'grants': ['02', '03', '04', '05'], 'loans': ['07', '08']}


def usaspending(name):
    res = {}
    for group, codes in AWARD_GROUPS.items():
        body = {'filters': {'recipient_search_text': [name], 'award_type_codes': codes,
                            'time_period': [{'start_date': '2007-10-01', 'end_date': TODAY}]},
                'fields': ['Award ID', 'Recipient Name', 'Award Amount', 'Loan Value', 'Awarding Agency', 'Start Date', 'Description',
                           'Place of Performance State Code', 'Recipient Location', 'generated_internal_id'],
                'limit': 50, 'page': 1, 'sort': 'Award Amount' if group != 'loans' else 'Loan Value', 'order': 'desc'}
        try:
            data = json.loads(post_json('https://api.usaspending.gov/api/v2/search/spending_by_award/', body))
        except Exception as e:
            log('USAspending failed for', name, repr(e))
            continue
        kept, similar = [], 0
        for r in data.get('results', []):
            loc = r.get('Recipient Location') or {}
            st = loc.get('state_code') if isinstance(loc, dict) else None
            same = norm_name(r.get('Recipient Name')) == norm_name(name)
            if same:  # exact name after removing suffixes; big companies are often headquartered out of region
                amt = r.get('Loan Value') if group == 'loans' else r.get('Award Amount')
                kept.append({'id': r.get('Award ID'), 'recipient': r.get('Recipient Name'), 'amount': amt or 0,
                             'agency': r.get('Awarding Agency'), 'date': r.get('Start Date'), 'what': (r.get('Description') or '')[:140],
                             'state': st, 'in_region': st in REGION or r.get('Place of Performance State Code') in REGION,
                             'url': f"https://www.usaspending.gov/award/{r.get('generated_internal_id')}" if r.get('generated_internal_id') else None})
            else:
                similar += 1
        if kept or similar:
            res[group] = {'total': round(sum(float(k['amount'] or 0) for k in kept), 2), 'count': len(kept), 'top': kept[:5], 'similar_not_counted': similar}
    return res


def fec(name, key):
    try:
        url, body = fetch('https://api.open.fec.gov/v1/committees/', {'q': name, 'api_key': key, 'per_page': 5})
    except Exception as e:
        log('FEC failed for', name, repr(e))
        return None
    out = []
    for c in json.loads(body).get('results', []):
        org = c.get('affiliated_committee_name') or c.get('name') or ''
        if norm_name(name) and norm_name(name) in norm_name(org):
            item = {'committee_id': c.get('committee_id'), 'committee': c.get('name'), 'connected_org': c.get('affiliated_committee_name'),
                    'type': c.get('committee_type_full'), 'cycles': c.get('cycles', []),
                    'url': f"https://www.fec.gov/data/committee/{c.get('committee_id')}/"}
            # who the PAC gave to (federal candidates and committees: public roles)
            try:
                _, b2 = fetch('https://api.open.fec.gov/v1/schedules/schedule_b/by_recipient/', {'committee_id': c.get('committee_id'), 'api_key': key, 'per_page': 8, 'sort': '-total'})
                item['top_recipients'] = [{'recipient': r.get('recipient_name'), 'total': r.get('total'), 'cycle': r.get('cycle')}
                                          for r in json.loads(b2).get('results', [])]
            except Exception as e:
                log('FEC schedule_b failed', c.get('committee_id'), repr(e))
            out.append(item)
    return out


CL_STOP = {'until': None}  # set when CourtListener says the daily quota is used up


def courtlistener(name, token):
    if CL_STOP['until']:
        return None            # quota used up this run: keep previous results
    q = urllib.parse.quote(f'"{name}"')
    req = urllib.request.Request(f'https://www.courtlistener.com/api/rest/v4/search/?q={q}&type=r&order_by=dateFiled%20desc',
                                 headers={'User-Agent': UA, 'Authorization': f'Token {token}'})
    data = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read())
            time.sleep(4)          # stay well under CourtListener's search rate limit
            break
        except urllib.error.HTTPError as e:
            if e.code == 429:      # rate limited: wait (honour Retry-After) and try again
                wait = int(e.headers.get('Retry-After') or 0) or 30 * (attempt + 1)
                if wait > 300:     # daily quota: stop asking for the rest of this run
                    CL_STOP['until'] = wait
                    log(f'CourtListener quota used up (retry in {wait}s); skipping courts for the rest of this run')
                    return None
                log(f'CourtListener rate limit; waiting {wait}s ({name})')
                time.sleep(min(wait, 180))
                continue
            log('CourtListener failed for', name, repr(e))
            return None
        except Exception as e:
            log('CourtListener failed for', name, repr(e))
            return None
    if data is None:
        log('CourtListener gave up for', name)
        return None
    cases = []
    for d in data.get('results', [])[:25]:
        court = d.get('court_id') or ''
        cases.append({'case': d.get('caseName'), 'court': d.get('court') or court, 'court_id': court, 'filed': d.get('dateFiled'),
                      'docket': d.get('docketNumber'), 'nature': d.get('suitNature'),
                      'bankruptcy': court.endswith('b'),
                      'party': norm_name(name) in norm_name(d.get('caseName')),  # named in the case title, not just mentioned
                      'url': 'https://www.courtlistener.com' + d['docket_absolute_url'] if d.get('docket_absolute_url') else None})
    return {'count': data.get('count', len(cases)), 'cases': cases}


LDA = 'https://lda.gov/api/v1/'


def get_json_retry(url, params=None, headers=None, tries=4, pause=0.5, label=''):
    """GET JSON with polite pacing and retries on rate limits / timeouts."""
    q = url + ('?' + urllib.parse.urlencode(params) if params else '')
    for attempt in range(tries):
        req = urllib.request.Request(q, headers={'User-Agent': UA, 'Accept': 'application/json', **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                data = json.loads(r.read())
            time.sleep(pause)
            return data
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503, 504):
                wait = int(e.headers.get('Retry-After') or 0) or 20 * (attempt + 1)
                log(f'{label} {e.code}; waiting {wait}s')
                time.sleep(min(wait, 180))
                continue
            log(f'{label} failed: HTTP {e.code}')
            return None
        except Exception as e:
            log(f'{label} failed: {e!r}')
            time.sleep(5)
    return None


def lobbying(name, key):
    """Federal lobbying reports (LD-2) where this company is the CLIENT. Matched by exact normalized client name."""
    hdr = {'Authorization': f'Token {key}'} if key else {}
    data = get_json_retry(LDA + 'filings/', {'client_name': name, 'page_size': 100, 'ordering': '-dt_posted'}, hdr, pause=1.5, label=f'LDA {name}')
    if data is None:
        return None
    out = []
    for f in data.get('results', []):
        cl = (f.get('client') or {}).get('name')
        if norm_name(cl) != norm_name(name):
            continue
        acts = f.get('lobbying_activities') or []
        out.append({'year': f.get('filing_year'), 'period': f.get('filing_period_display') or f.get('filing_period'),
                    'type': f.get('filing_type_display'), 'registrant': (f.get('registrant') or {}).get('name'),
                    'amount': f.get('income') or f.get('expenses'), 'posted': (f.get('dt_posted') or '')[:10],
                    'issues': sorted({a.get('general_issue_code_display') for a in acts if a.get('general_issue_code_display')}),
                    'topics': [(a.get('description') or '')[:160] for a in acts if a.get('description')][:3],
                    'entities': sorted({g.get('name') for a in acts for g in (a.get('government_entities') or []) if g.get('name')})[:8],
                    'url': f.get('filing_document_url')})
    return out


def fec_itemized(committee_id, key, cycles=3):
    """Dated disbursements from a company PAC to candidates and committees (public roles), recent cycles."""
    rows = []
    yr = int(TODAY[:4])
    cyc = yr if yr % 2 == 0 else yr + 1
    for c in range(cyc, cyc - 2 * cycles, -2):
        data = get_json_retry('https://api.open.fec.gov/v1/schedules/schedule_b/',
                              {'committee_id': committee_id, 'two_year_transaction_period': c, 'per_page': 100,
                               'sort': '-disbursement_date', 'api_key': key}, pause=0.6, label=f'FEC sched B {committee_id} {c}')
        for r in (data or {}).get('results', []):
            rows.append({'date': (r.get('disbursement_date') or '')[:10], 'amount': r.get('disbursement_amount'),
                         'recipient': r.get('recipient_name'), 'state': r.get('recipient_state'),
                         'purpose': (r.get('disbursement_description') or '')[:80]})
    return rows


def money_and_courts(families, max_controllers=40, refresh_days=7, max_new_courts=25):
    """Look up the biggest company controllers and their operating companies in USAspending, FEC, LDA and CourtListener.
    Results from the last run are reused for up to refresh_days so the daily build stays fast and polite."""
    fec_key = os.environ.get('FEC_API_KEY') or 'DEMO_KEY'
    cl_token = os.environ.get('COURTLISTENER_TOKEN')
    lda_key = os.environ.get('LDA_API_KEY')
    prev = {}
    try:
        prev = json.loads(fetch(PAGES_URL + 'data/money.json')[1]).get('by_name', {})
        log(f'Money/courts: reusing previous run ({len(prev)} names)')
    except Exception as e:
        log('Money/courts: no previous run to reuse', repr(e))
    cutoff = (dt.date.fromisoformat(TODAY) - dt.timedelta(days=refresh_days)).isoformat()
    top = [f for f in families if not (f.get('controller_type') or '').upper().startswith('P') and f.get('viol')]
    top = sorted(top, key=lambda f: -(f['viol'] or {}).get('total', 0))[:max_controllers]
    names = []
    for f in top:
        names.append(f['controller'])
        names += [o['name'] for o in f.get('operators', [])[:4] if o.get('name')]
    names = list(dict.fromkeys(n for n in names if n and norm_name(n)))
    out = {'as_of': TODAY, 'rules': 'Matched by name. Counted only when the name matches exactly after removing suffixes (LLC, Inc...). '
           'Similar names are listed as not counted. Each award shows the recipient state.',
           'fec_key': 'personal' if fec_key != 'DEMO_KEY' else 'demo', 'courts': 'on' if cl_token else 'needs_token',
           'lobbying': 'on', 'by_name': {}}
    fec_budget = 600 if fec_key != 'DEMO_KEY' else 12
    new_courts = 0
    for n in names:
        old = prev.get(norm_name(n), {})
        fresh = lambda k: old.get('checked', {}).get(k, '') >= cutoff and k in old
        rec = {'name': n, 'checked': dict(old.get('checked', {}))}
        for k, fn in (('usaspending', lambda: usaspending(n)), ('lobbying', lambda: lobbying(n, lda_key))):
            if fresh(k):
                rec[k] = old[k]
            else:
                v = fn()
                if v is not None:
                    rec[k], rec['checked'][k] = v, TODAY
                elif k in old:
                    rec[k] = old[k]
        if fresh('fec'):
            rec['fec'] = old['fec']
        elif fec_budget > 0:
            v = fec(n, fec_key)
            fec_budget -= 2
            if v is not None:
                for c in v:
                    c['itemized'] = fec_itemized(c['committee_id'], fec_key) if fec_key != 'DEMO_KEY' else []
                    fec_budget -= 3
                rec['fec'], rec['checked']['fec'] = v, TODAY
            elif 'fec' in old:
                rec['fec'] = old['fec']
        if cl_token:
            if fresh('courts'):
                rec['courts'] = old['courts']
            elif new_courts < max_new_courts:
                v = courtlistener(n, cl_token)
                new_courts += 1
                if v is not None:
                    rec['courts'], rec['checked']['courts'] = v, TODAY
                elif 'courts' in old:
                    rec['courts'] = old['courts']
            elif 'courts' in old:
                rec['courts'] = old['courts']
        out['by_name'][norm_name(n)] = rec
    log(f"Money/courts: {len(names)} names; courts {'on' if cl_token else 'off (no token)'} ({new_courts} refreshed); "
        f"FEC key {out['fec_key']}; lobbying filings found for {sum(1 for r in out['by_name'].values() if r.get('lobbying'))} names")
    return out


GLEIF = 'https://api.gleif.org/api/v1/'
GLEIF_EXCEPTIONS = {
    'NATURAL_PERSONS': 'owned or controlled by one or more individuals (GLEIF does not name them)',
    'NON_CONSOLIDATING': 'its parent does not consolidate it in financial statements',
    'NO_KNOWN_PERSON': 'reports that no person or company controls it',
    'NON_PUBLIC': 'parent kept private (company says disclosure is not allowed or would be harmful)',
    'BINDING_LEGAL_COMMITMENTS': 'parent kept private (cites a legal commitment)',
    'LEGAL_OBSTACLES': 'parent kept private (cites a legal obstacle)',
    'DISCLOSURE_DETRIMENTAL': 'parent kept private (says disclosure would be harmful)',
    'DETRIMENT_NOT_EXCLUDED': 'parent kept private (says harm cannot be ruled out)',
    'CONSENT_NOT_OBTAINED': 'parent kept private (parent did not consent)',
    'NO_LEI': 'parent exists but has no LEI of its own',
}


def gleif_get(path, params=None):
    try:
        return json.loads(fetch(GLEIF + path, params, headers={'Accept': 'application/vnd.api+json'}, timeout=60)[1])
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def gleif_entity(d):
    a = d.get('attributes', {})
    e = a.get('entity', {})
    addr = e.get('legalAddress', {}) or {}
    hq = e.get('headquartersAddress', {}) or {}
    return {'lei': d.get('id') or a.get('lei'), 'legal_name': (e.get('legalName') or {}).get('name'),
            'country': addr.get('country'), 'region': addr.get('region'), 'hq_country': hq.get('country'),
            'status': e.get('status'), 'category': e.get('category'), 'legal_form': (e.get('legalForm') or {}).get('id'),
            'registered_at': (a.get('registration') or {}).get('initialRegistrationDate', '')[:10] or None,
            'url': f"https://search.gleif.org/#/record/{d.get('id') or a.get('lei')}"}


def gleif_lookup(name):
    """Exact-name match only: GLEIF's suggestions are kept only when the normalized names are identical."""
    want = norm_name(name)
    j = gleif_get('fuzzycompletions', {'field': 'entity.legalName', 'q': name}) or {}
    leis = []
    for d in j.get('data', []):
        v = (d.get('attributes') or {}).get('value', '')
        lid = (((d.get('relationships') or {}).get('lei-records') or {}).get('data') or {}).get('id')
        if lid and norm_name(v) == want:
            leis.append(lid)
    out = []
    for lid in list(dict.fromkeys(leis))[:3]:
        r = gleif_get(f'lei-records/{lid}')
        if not r:
            continue
        archive('gleif', f'lei-{lid}.json', GLEIF + f'lei-records/{lid}', json.dumps(r).encode())
        ent = gleif_entity(r['data'])
        for rel in ('direct', 'ultimate'):
            p = gleif_get(f'lei-records/{lid}/{rel}-parent')
            if p and p.get('data'):
                ent[f'{rel}_parent'] = gleif_entity(p['data'])
            else:
                ex = gleif_get(f'lei-records/{lid}/{rel}-parent-reporting-exception')
                at = ((ex or {}).get('data') or {}).get('attributes') or {}
                code = at.get('reason') or at.get('exceptionReason')
                if code:
                    ent[f'{rel}_exception'] = {'code': code, 'plain': GLEIF_EXCEPTIONS.get(code, code.replace('_', ' ').lower())}
        ch = gleif_get(f'lei-records/{lid}/direct-children', {'page[size]': 50})
        if ch and ch.get('data'):
            ent['children'] = [gleif_entity(c) for c in ch['data']]
            ent['children_total'] = ((ch.get('meta') or {}).get('pagination') or {}).get('total', len(ent['children']))
        out.append(ent)
    return out


def parents(families, max_controllers=80, ops_per=3, refresh_days=30):
    """Corporate parents v1.
    1. Same-name MSHA controller IDs (inferred: a company can sit under several controller IDs).
    2. GLEIF legal-entity records (official LEI, home country, reported direct/ultimate parent or the reason none is reported).
    SEC EDGAR (Exhibit 21 subsidiaries, Exhibit 95 mine lists) blocks GitHub's servers, so it is offered as research links."""
    by_norm = {}
    for f in families:
        if (f.get('controller_type') or '').upper().startswith('P'):
            continue  # people: never merged by name
        by_norm.setdefault(norm_name(f['controller']), []).append(f)
    groups = 0
    for k, fs in by_norm.items():
        if k and len(fs) > 1:
            groups += 1
            for f in fs:
                f['same_name_ids'] = [{'id': g['controller_id'], 'name': g['controller'], 'mines': len(g.get('mines', []))}
                                      for g in fs if g is not f]
    prev = {}
    try:
        prev = json.loads(fetch(PAGES_URL + 'data/parents.json')[1]).get('by_name', {})
    except Exception as e:
        log('Parents: no previous run to reuse', repr(e))
    cutoff = (dt.date.fromisoformat(TODAY) - dt.timedelta(days=refresh_days)).isoformat()
    comp = [f for f in families if not (f.get('controller_type') or '').upper().startswith('P')]
    comp = sorted(comp, key=lambda f: (-((f.get('viol') or {}).get('total') or 0), -len(f.get('mines', []))))[:max_controllers]
    names = []
    for f in comp:
        names.append(f['controller'])
        names += [o['name'] for o in f.get('operators', [])[:ops_per] if o.get('name')]
    names = list({norm_name(n): n for n in reversed(names) if norm_name(n)}.values())[::-1]
    out = {'as_of': TODAY, 'source': 'GLEIF Global LEI Index (api.gleif.org)', 'same_name_groups': groups,
           'rules': 'GLEIF records are counted only when the legal name matches exactly after removing suffixes (LLC, Inc...). '
                    'Parents are what the company itself reported to GLEIF; "no parent reported" shows the reason it gave.',
           'sec': 'SEC EDGAR blocks our build server; use the EDGAR links (Exhibit 21 lists subsidiaries, Exhibit 95 lists mines by MSHA ID).',
           'by_name': {}}
    fails = 0
    for n in names:
        k = norm_name(n)
        old = prev.get(k)
        if old and old.get('checked', '') >= cutoff:
            out['by_name'][k] = old
            continue
        try:
            out['by_name'][k] = {'name': n, 'checked': TODAY, 'gleif': gleif_lookup(n)}
        except Exception as e:
            fails += 1
            log('GLEIF failed for', n, repr(e))
            if old:
                out['by_name'][k] = old
            if fails > 8:
                log('Parents: too many GLEIF failures, stopping early')
                break
    hits = sum(1 for r in out['by_name'].values() if r.get('gleif'))
    log(f'Parents: {groups} same-name controller groups; GLEIF {hits}/{len(out["by_name"])} names matched')
    out['matched'] = hits
    return out


KY_SOS = 'https://sosbes.sos.ky.gov/BusSearchNProfile/'
COMPANY_WORDS = re.compile(r'\b(llc|l\.l\.c|inc|incorporated|corp|corporation|company|co|ltd|lp|llp|plc|gmbh|trust|holdings|partners|group|fund|bank|associates)\b', re.I)
# Lu's rule: owners, executives, directors and managing members are named; administrative roles held by
# individuals (secretary, assistant, organizer, incorporator, clerk) stay private. Companies are always named.
HIDE_TITLES = re.compile(r'secretary|assistant|asst|organizer|incorporator|clerk|registered agent', re.I)


class _Session:
    def __init__(self):
        import http.cookiejar
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def get(self, url, form=None):
        data = urllib.parse.urlencode(form).encode() if form else None
        h = {'User-Agent': UA}
        if data:
            h['Content-Type'] = 'application/x-www-form-urlencoded'
        with self.op.open(urllib.request.Request(url, data=data, headers=h), timeout=90) as r:
            body = r.read().decode('utf-8', 'replace')
            final = r.geturl()
        time.sleep(1)
        return final, body


def _hidden(html):
    return {m.group(1): m.group(2) for m in re.finditer(r'<input type="hidden" name="([^"]+)"[^>]*value="([^"]*)"', html)}


def _clean(t):
    t = re.sub(r'<br\s*/?>', ' / ', t or '')
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', t)).replace('&amp;', '&').strip()


def ky_sos_profile(sess, url):
    final, html = sess.get(url)
    ctr = (re.search(r'ctr=(\d+)', final) or re.search(r'ctr=(\d+)', url))
    ctr = ctr.group(1) if ctr else str(abs(hash(final)))
    archive('ky-sos', f'profile-{ctr}.html', final, html.encode('utf-8'))
    info = {_clean(a).lower(): _clean(b) for a, b in re.findall(r'class="grid-label">(.*?)</div>\s*<div class="grid-value">(.*?)</div>', html, re.S)}
    officers = []
    for name, val in re.findall(r'<input type="submit" name="([^"]+)" value="([^"]+)"', html):
        if not re.search(r'Officer|Representative|Member|Manager', val, re.I):
            continue
        _, page = sess.get(final, {**_hidden(html), name: val})
        archive('ky-sos', f'profile-{ctr}-{name.split("$")[-1]}.html', final + ' (pressed ' + val + ')', page.encode('utf-8'))
        kind = 'initial' if 'Initial' in val or 'Founding' in val else 'current'
        mh = re.search(r'>\s*(?:Current|Initial|Founding) (?:Officers|Representatives)\s*<', page)
        if not mh:
            continue
        seg = page[mh.end():]
        tbl = re.search(r'<table.*?</table>', seg, re.S)
        if not tbl:
            continue
        for tr in re.findall(r'<tr.*?</tr>', tbl.group(0), re.S):
            cells = [_clean(c) for c in re.findall(r'<td.*?>(.*?)</td>', tr, re.S)]
            cells = [c for c in cells if c]
            if len(cells) >= 2:
                officers.append({'title': cells[0], 'name': cells[1], 'when': kind})
    def city_state(addr):
        parts = [x.strip() for x in (addr or '').split(' / ') if x.strip()]
        return parts[-1] if parts else None
    agent = info.get('registered agent', '')
    out = {'org_number': info.get('organization number'), 'legal_name': info.get('name'), 'type': info.get('company type'),
           'status': info.get('status'), 'standing': info.get('standing'), 'home_state': info.get('state'),
           'filed': info.get('file date'), 'authority': info.get('authority date'), 'last_annual_report': info.get('last annual report'),
           'office_city': city_state(info.get('principal office')),
           'agent': (agent.split(' / ')[0] if agent else None),
           'agent_is_state': 'SECRETARY OF STATE' in agent.upper(),
           'url': final, 'officers': [], 'archived': [f'profile-{ctr}.html'], 'pulled': TODAY}
    hidden = 0
    for o in officers:
        is_co = bool(COMPANY_WORDS.search(o['name']))
        if not is_co and HIDE_TITLES.search(o['title']):
            hidden += 1
            continue
        out['officers'].append({**o, 'company': is_co})
    out['hidden_admin'] = hidden
    return out


def ky_sos_lookup(sess, name):
    """Exact normalized-name matches only."""
    final, html = sess.get(KY_SOS + 'search.aspx')
    form = {**_hidden(html), 'ctl00$MainContent$ddlSearchBy': 'Business Name or Organization Number',
            'ctl00$MainContent$txtSearch': name[:60], 'ctl00$MainContent$BSearch': 'Search'}
    final, res = sess.get(KY_SOS + 'search.aspx', form)
    want = norm_name(name)
    if 'Profile.aspx' in final:                       # single hit: redirected straight to the profile
        p = ky_sos_profile(sess, final)
        return [p] if norm_name(p.get('legal_name')) == want else []
    rows = re.findall(r'href="(Profile\.aspx/?\?ctr=\d+)"><b>([^<]+)</b>.*?<font[^>]*>([^<]*)</font>.*?<font[^>]*>([^<]*)</font>', res, re.S)
    hits = [(h, _clean(n), st) for h, n, _, st in rows if norm_name(_clean(n)) == want]
    hits.sort(key=lambda x: not x[2].startswith('A'))   # active first
    return [ky_sos_profile(sess, urllib.parse.urljoin(KY_SOS, h.replace('&amp;', '&'))) for h, _, _ in hits[:2]]


def registry(families, mines, max_new=70, refresh_days=30):
    """Kentucky Secretary of State business records: standing, home state, officers/directors/members."""
    prev = {}
    try:
        prev = json.loads(fetch(PAGES_URL + 'data/registry.json')[1]).get('by_name', {})
    except Exception as e:
        log('Registry: no previous run to reuse', repr(e))
    cutoff = (dt.date.fromisoformat(TODAY) - dt.timedelta(days=refresh_days)).isoformat()
    comp = [f for f in families if not (f.get('controller_type') or '').upper().startswith('P')]
    comp = sorted(comp, key=lambda f: (-((f.get('viol') or {}).get('total') or 0), -len(f.get('mines', []))))[:80]
    names = []
    for f in comp:
        names.append(f['controller'])
        names += [o['name'] for o in f.get('operators', [])[:3] if o.get('name')]
    for m in mines:
        for r in m['properties'].get('ky_permits', [])[:2]:
            if r.get('permittee') and r.get('flag') != 'TRNS':
                names.append(r['permittee'])
    names = [n for n in dict.fromkeys(names) if n and COMPANY_WORDS.search(n)]
    names = list({norm_name(n): n for n in reversed(names) if norm_name(n)}.values())[::-1]
    out = {'as_of': TODAY, 'source': 'Kentucky Secretary of State, Business Entity Search (public records)',
           'rules': 'Exact name matches only (ignoring LLC, Inc...). Officers, directors, members and managers are shown as listed in the filing, '
                    'in their corporate role. Administrative roles held by individuals (secretary, assistant, organizer) are not shown. '
                    'Company addresses are shown as city and state only.', 'by_name': {}}
    sess, new, fails = _Session(), 0, 0
    for n in names:
        k = norm_name(n)
        old = prev.get(k)
        if old and old.get('checked', '') >= cutoff:
            out['by_name'][k] = old
            continue
        if new >= max_new or fails > 6:
            if old:
                out['by_name'][k] = old
            continue
        try:
            out['by_name'][k] = {'name': n, 'checked': TODAY, 'ky': ky_sos_lookup(sess, n)}
            new += 1
        except Exception as e:
            fails += 1
            log('KY SOS failed for', n, repr(e))
            if old:
                out['by_name'][k] = old
    hits = sum(1 for r in out['by_name'].values() if r.get('ky'))
    log(f'Registry: {len(out["by_name"])} names ({new} looked up); {hits} found in the Kentucky register')
    out['matched'] = hits
    return out


KY_ESEARCH_API = 'https://dep.gateway.ky.gov/eSearch.WebApi/api/PendingApproval/Search'
KY_ESEARCH = 'https://dep.gateway.ky.gov/eSearch/'
MI_NOTICES = 'https://mienviro.michigan.gov/ncore/ss/publicnoticeslist'
# Stages where the public can usually weigh in. 'Draft' = a draft permit/decision is out, which in Kentucky
# normally opens a 30-day public comment period. We say "usually" and link the official record.
OPEN_STAGES = re.compile(r'draft|public notice|comment|hearing', re.I)


def comments(mines, facilities):
    """Public-comment alerts: permit actions pending with the state, and which ones are at a stage where the public can weigh in."""
    out = {'as_of': TODAY, 'areas': {}}
    for aid, a in EF_AREAS.items():
        items, src = [], None
        try:
            if a['state'] == 'KY':
                src = {'name': 'Kentucky Department for Environmental Protection, eSearch Pending Actions/Approvals',
                       'url': KY_ESEARCH + 'Approvals/Pending?county=' + urllib.parse.quote(a['county'])}
                req = urllib.request.Request(KY_ESEARCH_API, data=json.dumps({'County': a['county']}).encode(),
                                             headers={'User-Agent': UA, 'Content-Type': 'application/json'})
                with urllib.request.urlopen(req, timeout=120) as r:
                    body = r.read()
                archive('ky-esearch', f'pending-{aid}.json', KY_ESEARCH_API, body)
                for x in json.loads(body) or []:
                    name = x.get('AgencyName') or ''
                    m = re.search(r'\((\d{3})-(\d{4})\)', name)
                    stage = x.get('CurrentMilestone') or ''
                    items.append({'id': f"KY-{x.get('AgencyId')}-{x.get('ActivityCode')}-{int(x.get('ActivityYear') or 0)}-{int(x.get('ActivityNum') or 0)}",
                                  'name': name, 'program': x.get('Program'), 'type': x.get('ActivityType'), 'stage': stage,
                                  'stage_date': (x.get('MilestoneDate') or '')[:10] or None, 'town': x.get('Municipality'),
                                  'open': bool(OPEN_STAGES.search(stage)), 'has_documents': bool(x.get('DetailRows')),
                                  'ky_mine_permit': (m.group(1) + m.group(2)) if m else None, 'agency_id': x.get('AgencyId'),
                                  'url': f"{KY_ESEARCH}agencydetails?agencyid={x.get('AgencyId')}",
                                  'comment_to': 'DOWPublicNotice@ky.gov' if (x.get('Program') or '') in ('Wastewater', 'Water Quality', 'Water Resources', 'Drinking Water') else None})
            elif a['state'] == 'MI':
                src = {'name': 'Michigan EGLE, MiEnviro Portal public notices', 'url': 'https://mienviro.michigan.gov/ncore/external/publicnotice/search'}
                url, body = fetch(MI_NOTICES, {'includeMetadataInResponse': 'false'}, headers={'Accept': 'application/json'}, timeout=120)
                archive('mi-mienviro', f'notices-{aid}.json', url, body)
                j = json.loads(body)
                rows = j.get('queryResults', j) if isinstance(j, dict) else j
                log('MiEnviro notices: keys', list(rows[0].keys())[:40] if rows else None, 'count', len(rows))
                for x in rows or []:
                    counties = ' '.join(str(x.get(k) or '') for k in ('countyDescription', 'publicNotificationCoverageCounties'))
                    if a['county'].lower() not in counties.lower():
                        continue
                    nm = x.get('contactNamePermit') or x.get('contactNameApplicant') or x.get('contactNameResponsibleParty') or 'Public notice'
                    items.append({'id': f"MI-{x.get('id')}", 'name': nm,
                                  'program': x.get('programAreaDescription'), 'type': x.get('publicNotificationTypeDescription'),
                                  'stage': 'Open for public comment', 'stage_date': str(x.get('startDate') or '')[:10] or None,
                                  'ends': str(x.get('endDate') or '')[:10] or None, 'town': x.get('city') or x.get('countyDescription'), 'open': True,
                                  'permit': x.get('permitNumber'), 'lat': x.get('latitude'), 'lon': x.get('longitude'),
                                  'url': f"https://mienviro.michigan.gov/ncore/external/publicnotice/info/{x.get('id')}/details"})
        except Exception as e:
            log(f'Comments {aid} failed:', repr(e))
            out['areas'][aid] = {'label': a['label'], 'source': src, 'error': 'not reachable this run', 'items': []}
            continue
        items.sort(key=lambda i: (not i['open'], -(int((i.get('stage_date') or '0000-00-00').replace('-', '')))))
        out['areas'][aid] = {'label': a['label'], 'source': src, 'items': items}
        log(f'Comments {aid}: {len(items)} pending actions, {sum(1 for i in items if i["open"])} at a public-comment stage')
    # tie pending actions to mines / EPA sites through the Kentucky mine permit number in the name
    by_permit = {}
    for area in out['areas'].values():
        for i in area['items']:
            if i.get('ky_mine_permit'):
                by_permit.setdefault(i['ky_mine_permit'], []).append(i)
    tied = 0
    for f in list(mines) + list(facilities):
        hits = [i for r in f['properties'].get('ky_permits', []) for i in by_permit.get(r['permit'], [])]
        if hits:
            f['properties']['pending'] = hits[:5]
            tied += 1
    out['tied_to_map'] = tied
    return out


RELEASE_BASE = 'https://github.com/BuildBeyond1889/peoples-case-file/releases'


def archive_index():
    """Public index of today's archived originals, so any record on the site can be traced to an unmodified,
    hashed copy in the monthly GitHub release."""
    tag = 'archive-' + TODAY[:7]
    asset = f'raw-{TODAY}.tar.gz'
    files = []
    for src in sorted(os.listdir(ARCHIVE)) if os.path.isdir(ARCHIVE) else []:
        mp = os.path.join(ARCHIVE, src, TODAY, 'manifest.json')
        if not os.path.exists(mp):
            continue
        for m in json.load(open(mp)):
            files.append({'source': src, 'file': m['file'], 'url': m['url'], 'pulled_utc': m['pulled_utc'],
                          'sha256': m['sha256'], 'bytes': m['bytes'], 'path': f'archive/{src}/{TODAY}/{m["file"]}'})
    return {'as_of': TODAY, 'release': {'tag': tag, 'asset': asset, 'page': f'{RELEASE_BASE}/tag/{tag}',
                                        'download': f'{RELEASE_BASE}/download/{tag}/{asset}',
                                        'note': 'If the archive is larger than 1.9 GB it is split into .part00, .part01... files; join them before extracting. '
                                                f'{asset}.sha256 lists the fingerprint of each part.'},
            'files': files}


def write_json(name, obj):
    os.makedirs(OUT, exist_ok=True)
    json.dump(obj, open(os.path.join(OUT, name), 'w'), separators=(',', ':'))
    return name


def main():
    layers, report = {}, {}
    feats, families = [], []
    try:
        feats, families = msha(AREAS)
        write_json('families.json', families)
        report['msha'] = {'mines': len(feats), 'families': len(families)}
    except Exception as e:
        log('MSHA failed:', repr(e))
        report['msha'] = {'error': repr(e)}

    facilities = []
    for area_id, area in AREAS.items():
        try:
            facilities += echo_facilities(area_id, area['bbox'])
        except Exception as e:
            log(f'ECHO {area_id} failed:', repr(e))
            report.setdefault('echo_errors', []).append(f'{area_id}: {e!r}')
    if facilities:
        try:
            report['npdes_enriched'] = npdes_enrich(facilities)
        except Exception as e:
            log('NPDES enrich failed:', repr(e))
        rank_flags(facilities)
        try:
            eff = effluent(facilities)
            write_json('effluent.json', eff)
            report['effluent_permits'] = sum(1 for v in eff['by_permit'].values() if v.get('exceedances'))
        except Exception as e:
            log('Effluent failed:', repr(e))
    tri_feats = []
    try:
        tri_feats = tri(facilities)
    except Exception as e:
        log('TRI failed:', repr(e))
    if tri_feats:
        try:
            report['tri_with_amounts'] = tri_releases(tri_feats)
        except Exception as e:
            log('TRI releases failed:', repr(e))
        layers['tri'] = write_json('tri.geojson', {'type': 'FeatureCollection', 'features': tri_feats})
    try:
        water, water_feats = sdwis()
        write_json('water.json', water)
        if water_feats:
            layers['water'] = write_json('water.geojson', {'type': 'FeatureCollection', 'features': water_feats})
        report['water_systems'] = sum(len(w['systems']) for w in water)
    except Exception as e:
        log('SDWIS failed:', repr(e))
    try:
        money = money_and_courts(families if feats else [])
        write_json('money.json', money)
        report['money_names'] = len(money['by_name'])
    except Exception as e:
        log('Money/courts failed:', repr(e))
    if feats:
        try:
            par = parents(families)
            write_json('parents.json', par)
            write_json('families.json', families)  # now carries same_name_ids
            report['parents'] = {'gleif_matched': par['matched'], 'names': len(par['by_name']), 'same_name_groups': par['same_name_groups']}
        except Exception as e:
            log('Parents failed:', repr(e))
    if feats:
        try:
            report['ky_permits'], kylayer = ky_permits(feats, facilities, AREAS['harlan-ky']['bbox'])
            if kylayer['features']:
                layers['kypermits'] = write_json('kypermits.geojson', kylayer)
        except Exception as e:
            log('KY permits failed:', repr(e))
    if feats:
        try:
            reg = registry(families, feats)
            write_json('registry.json', reg)
            report['registry'] = {'names': len(reg['by_name']), 'found': reg['matched']}
        except Exception as e:
            log('Registry failed:', repr(e))
    try:
        com = comments(feats, facilities)
        write_json('comments.json', com)
        report['comments'] = {k: len(v['items']) for k, v in com['areas'].items()}
    except Exception as e:
        log('Comments failed:', repr(e))
    if feats and facilities:
        try:
            report['mine_epa_links'] = link_mines_epa(feats, facilities)
        except Exception as e:
            log('Mine<->EPA linking failed:', repr(e))
    if feats:
        layers['mines'] = write_json('mines.geojson', {'type': 'FeatureCollection', 'features': feats})
    if facilities:
        layers['facilities'] = write_json('facilities.geojson', {'type': 'FeatureCollection', 'features': facilities})
    report['echo'] = {'facilities': len(facilities), 'silence_flagged': sum(1 for f in facilities if f['properties'].get('flags')),
                      'high_severity': sum(1 for f in facilities if f['properties'].get('flag_level') == 2)}
    report['tri'] = len(tri_feats)
    codes = {}
    for f in facilities:
        for fl in f['properties'].get('flags', []):
            codes[fl['code']] = codes.get(fl['code'], 0) + 1
    report['flag_codes'] = codes
    report['expired_examples'] = [f['properties']['name'] for f in facilities if any(fl['code'] == 'expired_permit' for fl in f['properties'].get('flags', []))][:10]

    try:
        ai = archive_index()
        write_json('archive.json', ai)
        report['archived_files'] = len(ai['files'])
    except Exception as e:
        log('Archive index failed:', repr(e))
    write_json('index.json', {'pulled': TODAY, 'layers': layers, 'report': report})
    log('REPORT', json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
