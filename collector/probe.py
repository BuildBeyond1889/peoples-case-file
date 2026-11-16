#!/usr/bin/env python3
"""Probe 18 (17 extended to 4 systems): drinking-water undercount. EPA's SDWIS Federal Report shows 155 violations for KY0480498
(Black Mtn Utility/Louellen); our site (Envirofacts VIOLATION/PWSID) shows 19. Compare sources:
  1. Envirofacts VIOLATION by PWSID (what we use), with and without paging
  2. ECHO SDWA bulk download (SDWA_VIOLATIONS_ENFORCEMENT.csv), the national file
Writes probe-out/water-KY0480498.json."""
import csv, io, json, os, urllib.request, zipfile
from collections import Counter
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
PIDS = ['KY0480498', 'KY0480461', 'MI0001019', 'MI0006505']
PID = PIDS[0]
def get(url, timeout=900):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=timeout) as r:
        return r.headers.get('Last-Modified'), r.read()
out = {'pwsid': PID}
EF = 'https://data.epa.gov/efservice/'
for label, path in (('viol', f'VIOLATION/PWSID/{PID}/JSON'), ('viol_rows', f'VIOLATION/PWSID/{PID}/rows/0:2000/JSON'),
                    ('viol_count', f'VIOLATION/PWSID/{PID}/COUNT/JSON'), ('sdw_viol_enf', f'SDW_VIOL_ENFORCEMENT/PWSID/{PID}/JSON')):
    try:
        _, b = get(EF + path, 300)
        d = json.loads(b)
        out[label] = {'n': len(d) if isinstance(d, list) else None, 'raw_if_small': d if not isinstance(d, list) else None,
                      'years': sorted(Counter((x.get('compl_per_begin_date') or '')[:4] for x in d).items()) if isinstance(d, list) else None,
                      'keys': sorted(d[0].keys()) if isinstance(d, list) and d else None}
    except Exception as e:
        out[label] = {'error': repr(e)[:300]}
try:
    lm, b = get('https://echo.epa.gov/files/echodownloads/SDWA_latest_downloads.zip', 1500)
    z = zipfile.ZipFile(io.BytesIO(b))
    out['echo_sdwa'] = {'last_modified': lm, 'files': z.namelist()}
    name = next(n for n in z.namelist() if 'VIOLATIONS' in n.upper())
    rows = []
    with z.open(name) as raw:
        rd = csv.DictReader(io.TextIOWrapper(raw, encoding='latin-1', newline=''))
        out['echo_sdwa']['columns'] = rd.fieldnames
        for r in rd:
            if r.get('PWSID') in PIDS:
                rows.append(r)
    out['per_system'] = {p: {'rows': sum(1 for r in rows if r['PWSID'] == p), 'distinct': len({r['VIOLATION_ID'] for r in rows if r['PWSID'] == p}),
                             'distinct_pair': len({(r['VIOLATION_ID'], r.get('FACILITY_ID')) for r in rows if r['PWSID'] == p})} for p in PIDS}
    rows = [r for r in rows if r['PWSID'] == PID]
    vids = {r.get('VIOLATION_ID') for r in rows}
    out['echo_sdwa'].update({'file': name, 'rows': len(rows), 'distinct_violation_ids': len(vids),
        'by_year': sorted(Counter((r.get('NON_COMPL_PER_BEGIN_DATE') or r.get('COMPL_PER_BEGIN_DATE') or '')[-4:] for r in rows).items()),
        'health_based': len({r.get('VIOLATION_ID') for r in rows if r.get('IS_HEALTH_BASED_IND') == 'Y'}),
        'sample': rows[:3]})
except Exception as e:
    out['echo_sdwa_error'] = repr(e)[:400]
os.makedirs('probe-out', exist_ok=True)
json.dump(out, open('probe-out/water-KY0480498.json', 'w'), indent=1, default=str)
print(json.dumps({k: (v if k != 'echo_sdwa' else {kk: vv for kk, vv in v.items() if kk not in ('sample', 'columns')}) for k, v in out.items()}, default=str)[:3000])
