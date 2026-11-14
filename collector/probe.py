#!/usr/bin/env python3
"""Probe 2: KY SOS name search -> profile officers; KY mine permit sample features."""
import json, re, urllib.parse, urllib.request, http.cookiejar
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def get(url, data=None):
    req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded'} if data else {'User-Agent': UA})
    with op.open(req, timeout=120) as r:
        return r.geturl(), r.read().decode('utf-8', 'replace')
S = 'https://sosbes.sos.ky.gov/BusSearchNProfile/search.aspx'
for name in ['Bluegrass Natural Resources', 'Inmet Mining', 'Lone Mountain Processing']:
    u, html = get(S)
    form = {m.group(1): m.group(2) for m in re.finditer(r'<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"', html)}
    form.update({'ctl00$MainContent$ddlSearchBy': 'Business Name or Organization Number', 'ctl00$MainContent$txtSearch': name,
                 'ctl00$MainContent$BSearch': 'Search'})
    form.pop('ctl00$MainContent$cbActiveonly', None)
    u, res = get(S, urllib.parse.urlencode(form).encode())
    links = re.findall(r'href="([^"]*Profile\.aspx[^"]*)"[^>]*>([^<]+)', res)
    print('\n###', name, u, len(res), 'links', links[:6])
    if not links:
        t = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' | ', res)); i = t.find(name.split()[0].upper())
        print(t[max(0, i - 300):i + 900]); continue
    href = urllib.parse.urljoin(S, links[0][0].replace('&amp;', '&'))
    u, prof = get(href)
    t = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' | ', prof))
    i = t.find('General Information')
    print(href); print(t[i:i + 3500])
base = 'https://kygisserver.ky.gov/arcgis/rest/services/WGS84WM_Services/Ky_Permitted_Mine_Boundaries_WGS84WM/MapServer/0/query'
q = {'where': "PER_NAME LIKE '%INMET%' OR PER_NAME LIKE '%BLUEGRASS NATURAL%'", 'outFields': '*', 'returnGeometry': 'false', 'f': 'json'}
u, b = get(base + '?' + urllib.parse.urlencode(q))
for f in json.loads(b).get('features', [])[:12]:
    print(f['attributes'])
q = {'where': '1=1', 'geometry': '-83.30,36.85,-83.25,36.90', 'geometryType': 'esriGeometryEnvelope', 'inSR': '4326', 'outSR': '4326',
     'spatialRel': 'esriSpatialRelIntersects', 'outFields': 'PermitNo', 'returnGeometry': 'true', 'geometryPrecision': 5, 'f': 'geojson', 'resultRecordCount': 2}
u, b = get(base + '?' + urllib.parse.urlencode(q))
print('geojson sample', b[:600])
