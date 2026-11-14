#!/usr/bin/env python3
"""Diagnostic probe: effluent (DMR) exceedances, NPDES inspections/enforcement, TRI amounts,
Kentucky mine permits (ArcGIS), Kentucky SOS officers."""
import csv, io, json, re, sys, time, urllib.parse, urllib.request, zipfile, http.cookiejar

UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def get(url, params=None, data=None, timeout=120):
    if params:
        url += '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, data=data, headers={'User-Agent': UA})
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, r.read()
    except Exception as e:
        return repr(e), b''


def show(label, s, b, n=600):
    print(f'--- {label}: {s} {len(b)} bytes')
    print(b[:n].decode('utf-8', 'replace'))


PID = 'KYGE41204'  # Inmet / Panther permit

print('== 1. ECHO effluent ==')
s, b = get('https://echodata.epa.gov/echo/eff_rest_services.get_summary_chart', {'p_id': PID, 'start_date': '01/01/2022', 'end_date': '12/31/2025', 'output': 'JSON'})
show('summary', s, b, 1500)
s, b = get('https://echodata.epa.gov/echo/eff_rest_services.download_effluent_chart', {'p_id': PID, 'start_date': '01/01/2022', 'end_date': '12/31/2025'})
show('download csv', s, b, 800)
if b:
    rows = list(csv.DictReader(io.StringIO(b.decode('latin-1'))))
    print('csv rows', len(rows), 'cols', list(rows[0].keys()) if rows else None)
    ex = [r for r in rows if any('exceed' in k.lower() and (r[k] or '').strip() not in ('', '0') for k in r)]
    print('rows with exceedance', len(ex))
    for r in ex[:5]:
        print('  ', {k: v for k, v in r.items() if v})

print('\n== 2. NPDES bulk zip contents ==')
s, b = get('https://echo.epa.gov/files/echodownloads/npdes_downloads.zip', timeout=600)
print('zip', s, len(b))
if b:
    z = zipfile.ZipFile(io.BytesIO(b))
    for i in z.infolist():
        print('  ', i.filename, i.file_size)
    for name in z.namelist():
        if not re.search(r'INSPECT|ENFORCE|VIOLATION|EFF', name, re.I):
            continue
        with z.open(name) as f:
            r = csv.DictReader(io.TextIOWrapper(f, 'latin-1'))
            print(name, r.fieldnames)
            n = 0
            for row in r:
                if PID in (row.get('NPDES_ID'), row.get('EXTERNAL_PERMIT_NMBR')):
                    print('   ', {k: v for k, v in row.items() if v})
                    n += 1
                    if n >= 3: break
    del b, z

print('\n== 3. TRI basic data ==')
for url in ('https://data.epa.gov/efservice/downloads/tri/mv_tri_basic_download/2023_KY/csv',
            'https://data.epa.gov/efservice/downloads/tri/mv_tri_basic_download/2023_MI/csv'):
    s, b = get(url, timeout=300)
    print(url, s, len(b))
    if b:
        rows = list(csv.reader(io.StringIO(b.decode('latin-1'))))
        print('  cols', rows[0][:120])
        print('  rows', len(rows))

print('\n== 4. Kentucky permitted mine boundaries (ArcGIS) ==')
base = 'https://kygisserver.ky.gov/arcgis/rest/services/WGS84WM_Services/Ky_Permitted_Mine_Boundaries_WGS84WM/MapServer/0'
s, b = get(base, {'f': 'json'})
if b:
    j = json.loads(b)
    print('fields', [(f['name'], f.get('alias')) for f in j.get('fields', [])])
q = {'where': '1=1', 'geometry': '-83.55,36.70,-82.95,37.05', 'geometryType': 'esriGeometryEnvelope',
     'inSR': '4326', 'spatialRel': 'esriSpatialRelIntersects', 'f': 'json'}
s, b = get(base + '/query', {**q, 'outFields': '*', 'returnGeometry': 'false', 'resultRecordCount': 5})
show('query harlan', s, b, 2500)
s, b = get(base + '/query', {**q, 'returnCountOnly': 'true'})
show('count harlan', s, b)
s, b = get('https://kgs.uky.edu/arcgis/rest/services/KYCoal/KYActiveMines/MapServer/0', {'f': 'json'})
if b:
    try: print('KGS active mines fields', [f['name'] for f in json.loads(b).get('fields', [])])
    except Exception as e: print('kgs', e, b[:200])

print('\n== 5. Kentucky SOS business search ==')
s, b = get('https://sosbes.sos.ky.gov/BusSearchNProfile/search.aspx')
print('search page', s, len(b))
html = b.decode('utf-8', 'replace')
print('form fields', re.findall(r'<(?:input|select)[^>]*name="([^"]+)"', html)[:40])
print('options', re.findall(r'<option[^>]*value="([^"]*)"[^>]*>([^<]*)', html)[:30])
s, b = get('https://sosbes.sos.ky.gov/BusSearchNProfile/Profile.aspx/', {'ctr': '590221'})
txt = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' | ', b.decode('utf-8', 'replace')))
i = txt.find('Officer')
print('profile', s, len(b), txt[max(0, i - 1200):i + 1500])
