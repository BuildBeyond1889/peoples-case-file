#!/usr/bin/env python3
"""Probe 16: spot-check kit (mines + EPA facilities + TRI + water from the live site). For every mine on the live site: our published numbers (from the live
site data) plus every row in MSHA's downloadable Violations file, so PDFs from MSHA's live
Violations report can be compared three ways: live report vs bulk file vs our site.
Writes probe-out/spotcheck-mines.json (pushed to the probe-results branch by the workflow)."""
import csv, io, json, os, re, time, urllib.request, urllib.parse, zipfile
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
SITE = 'https://buildbeyond1889.github.io/peoples-case-file/data/'
BASE = 'https://arlweb.msha.gov/OpenGovernmentData/'
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA, 'Cache-Control': 'no-cache'}), timeout=900) as r:
        return r.headers.get('Last-Modified'), r.read()
os.makedirs('probe-out', exist_ok=True)
_, b = get(SITE + 'index.json?t=%d' % time.time()); idx = json.loads(b)
_, b = get(SITE + idx['layers']['mines'] + '?t=%d' % time.time()); mines = json.loads(b)['features']
site = {}
for f in mines:
    p = f['properties']; mid = str((p.get('ids') or {}).get('msha_mine') or '')
    if mid:
        site[mid.lstrip('0')] = {'id': mid, 'name': p.get('name'), 'status': p.get('status'), 'operator': p.get('operator'),
                                 'controller': p.get('parent'), 'viol': p.get('viol'), 'history': p.get('history')}
_, idxh = get(BASE + 'OGIMSHA.asp')
links = sorted(set(urllib.parse.urljoin(BASE, l) for l in re.findall(r'href=["\']([^"\']+?\.zip)["\']', idxh.decode('latin-1'), re.I)))
url = next((l for l in links if l.lower().endswith('/violations.zip')), BASE + 'DataSets/Violations.zip')
lm, body = get(url)
z = zipfile.ZipFile(io.BytesIO(body)); name = [n for n in z.namelist() if n.lower().endswith(('.txt', '.csv'))][0]
keep = ['VIOLATION_NO', 'VIOLATION_ISSUE_DT', 'VIOLATOR_TYPE_CD', 'VIOLATOR_NAME', 'CONTRACTOR_ID', 'VACATE_DT', 'SIG_SUB',
        'PROPOSED_PENALTY', 'AMOUNT_DUE', 'AMOUNT_PAID', 'CONTROLLER_ID', 'OPERATOR_ID']
bulk = {}
with z.open(name) as raw:
    rd = csv.reader(io.TextIOWrapper(raw, encoding='latin-1', newline=''), delimiter='|')
    header = [h.strip().upper() for h in next(rd)]
    for rec in rd:
        r = dict(zip(header, (x.strip() for x in rec)))
        k = r.get('MINE_ID', '').strip('"').lstrip('0')
        if k in site:
            bulk.setdefault(k, []).append([r.get(c, '') for c in keep])
facs = {}
for lay in ('facilities', 'tri'):
    if lay in idx['layers']:
        _, b = get(SITE + idx['layers'][lay] + '?t=%d' % time.time())
        for f in json.loads(b)['features']:
            p = f['properties']; ids = p.get('ids') or {}
            k = str(ids.get('frs') or ids.get('tri') or '')
            if k: facs.setdefault(lay, {})[k] = {x: p.get(x) for x in ('name', 'kind', 'qtrs_noncompliance', 'qtrs_nc_raw', 'penalties', 'last_inspection', 'flags', 'severity', 'flag_level', 'formal_actions_5yr', 'permits', 'effluent_qtrs', 'releases', 'tri', 'source_url', 'mine_link', 'ids')}
water = {}
try:
    _, b = get(SITE + 'water.json?t=%d' % time.time()); water = json.loads(b)
except Exception as e:
    water = {'error': repr(e)}
json.dump({'facs': facs, 'water': water}, open('probe-out/spotcheck-epa.json', 'w'), separators=(',', ':'))
json.dump({'site_pulled': idx.get('pulled'), 'bulk_file': {'url': url, 'last_modified': lm}, 'cols': keep,
           'site': site, 'bulk': bulk}, open('probe-out/spotcheck-mines.json', 'w'), separators=(',', ':'))
print('mines', len(site), 'with bulk rows', len(bulk), 'rows', sum(len(v) for v in bulk.values()))
