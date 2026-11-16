#!/usr/bin/env python3
"""Probe 14: spot-check trace. Every MSHA bulk-file row for mine 1519974 (Trace Branch Splint Mine),
to compare against MSHA's live Violations report (53 rows: 50 operator, 3 contractor, as of 2026-11-16).
Writes probe-out/mine-1519974.json; the workflow pushes it to the probe-results branch."""
import csv, io, json, os, re, sys, urllib.request, urllib.parse, zipfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
BASE = 'https://arlweb.msha.gov/OpenGovernmentData/'
MINE = '1519974'
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=900) as r:
        return r.headers.get('Last-Modified'), r.read()
out = {'mine': MINE}
_, idx = get(BASE + 'OGIMSHA.asp')
links = sorted(set(urllib.parse.urljoin(BASE, l) for l in re.findall(r'href=["\']([^"\']+?\.zip)["\']', idx.decode('latin-1'), re.I)))
url = next((l for l in links if l.lower().endswith('/violations.zip')), BASE + 'DataSets/Violations.zip')
lm, body = get(url)
out['file'] = {'url': url, 'last_modified': lm, 'bytes': len(body)}
z = zipfile.ZipFile(io.BytesIO(body))
name = [n for n in z.namelist() if n.lower().endswith(('.txt', '.csv'))][0]
rows, header = [], None
with z.open(name) as raw:
    rd = csv.reader(io.TextIOWrapper(raw, encoding='latin-1', newline=''), delimiter='|')
    header = [h.strip().upper() for h in next(rd)]
    for rec in rd:
        r = dict(zip(header, (x.strip() for x in rec)))
        if r.get('MINE_ID', '').strip('"').lstrip('0') == MINE.lstrip('0'):
            rows.append(r)
out['header'] = header
out['row_count'] = len(rows)
out['max_issue_dt'] = max((r.get('VIOLATION_ISSUE_DT', '') for r in rows), default='')
keep = ['VIOLATION_NO', 'VIOLATION_ISSUE_DT', 'VIOLATOR_TYPE_CD', 'VIOLATOR_NAME', 'CONTRACTOR_ID', 'VACATE_DT', 'SIG_SUB',
        'PROPOSED_PENALTY', 'AMOUNT_DUE', 'AMOUNT_PAID', 'ASSESS_CASE_STATUS_CD', 'SECTION_OF_ACT', 'CONTROLLER_ID', 'OPERATOR_ID', 'CAL_YR']
out['rows'] = [{k: r.get(k) for k in keep if k in r} for r in rows]
os.makedirs('probe-out', exist_ok=True)
json.dump(out, open('probe-out/mine-1519974.json', 'w'), indent=1)
print(json.dumps({k: out[k] for k in ('file', 'row_count', 'max_issue_dt')}, indent=1))
