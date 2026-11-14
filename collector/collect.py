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
                'operator': cur_op, 'parent': cur_ctl, 'parent_confidence': 'high (MSHA controller record)' if cur_ctl else None,
                'history': ops,
                'source': 'MSHA Open Government Data',
                'source_url': 'https://www.msha.gov/mine-data-retrieval-system',  # look up by mine ID
                'as_of': TODAY,
                'flags': [flag] if flag else [],
                'ids': {'msha_mine': mid, 'msha_controller': cur_ctl_id},
            }})
    for f in families.values():
        f['operators'] = [{'id': k, 'name': v} for k, v in f['operators'].items()]
        f['mines'] = [{'id': k, 'name': v} for k, v in f['mines'].items()]
        f['source'] = 'MSHA Controller/Operator History'
        f['as_of'] = TODAY
    log(f'MSHA: {len(feats)} mapped mines, {len(families)} controller families')
    return feats, sorted(families.values(), key=lambda f: -len(f['mines']))


# ---------------------------------------------------------------- ECHO ----
ECHO = 'https://echodata.epa.gov/echo/echo_rest_services'


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
        url, body = fetch(ECHO + '.get_qid', {'output': 'JSON', 'qid': qid, 'pageno': page})
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
                'kind': 'EPA-regulated facility',
                # FacQtrsWithNC = number of quarters in non-compliance (recent 3 years), NOT a violation count.
                'qtrs_noncompliance': _int(f.get('FacQtrsWithNC')),
                'penalties': _num(f.get('FacTotalPenalties')),
                'source': 'EPA ECHO',
                'source_url': f'https://echo.epa.gov/detailed-facility-report?fid={frs}' if frs else None,
                'as_of': TODAY,
                'ids': {'frs': frs},
            }})
        if not facs:
            break
        page += 1
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
def write_json(name, obj):
    os.makedirs(OUT, exist_ok=True)
    json.dump(obj, open(os.path.join(OUT, name), 'w'), separators=(',', ':'))
    return name


def main():
    layers, report = {}, {}
    try:
        feats, families = msha(AREAS)
        if feats:
            layers['mines'] = write_json('mines.geojson', {'type': 'FeatureCollection', 'features': feats})
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
        layers['facilities'] = write_json('facilities.geojson', {'type': 'FeatureCollection', 'features': facilities})
    report['echo'] = {'facilities': len(facilities)}

    write_json('index.json', {'pulled': TODAY, 'layers': layers, 'report': report})
    log('REPORT', json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
