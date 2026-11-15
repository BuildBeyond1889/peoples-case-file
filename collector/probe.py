#!/usr/bin/env python3
"""Probe 12: data-gap sources."""
import json, re, urllib.parse, urllib.request, http.cookiejar
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def get(url, params=None, data=None, headers=None, n=None):
    if params: url += ('&' if '?' in url else '?') + urllib.parse.urlencode(params)
    try:
        with op.open(urllib.request.Request(url, data=data, headers={'User-Agent': UA, **(headers or {})}), timeout=120) as r:
            b = r.read(n) if n else r.read()
            if b[:2] == b'\x1f\x8b':
                import gzip; b = gzip.decompress(b)
            return r.status, r.geturl(), b
    except urllib.error.HTTPError as e:
        return f'HTTP {e.code}', url, e.read()[:300]
    except Exception as e:
        return repr(e), url, b''
def hdr(t): print('\n==', t, '==')
def txt(b): return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' | ', b.decode('utf-8', 'replace')))

hdr('EPA CWS service areas')
base = 'https://services.arcgis.com/cJ9YHowT8TU7DUyn/ArcGIS/rest/services/Community_Water_Systems_March_28_2024/FeatureServer'
s, u, b = get(base, {'f': 'json'}); print(s, [(l['id'], l['name']) for l in json.loads(b).get('layers', [])] if s == 200 else b[:200])
s, u, b = get(base + '/0', {'f': 'json'}); print('fields', [f['name'] for f in json.loads(b).get('fields', [])] if s == 200 else b[:200])
s, u, b = get(base + '/0/query', {'where': "PWSID LIKE 'KY%'", 'geometry': '-83.55,36.70,-82.95,37.05', 'geometryType': 'esriGeometryEnvelope', 'inSR': 4326, 'spatialRel': 'esriSpatialRelIntersects', 'outFields': '*', 'returnGeometry': 'false', 'f': 'json'})
try: print('harlan', s, [ (f['attributes'].get('PWSID'), f['attributes'].get('PWS_Name') or f['attributes'].get('NAME')) for f in json.loads(b)['features']][:20])
except Exception as e: print('harlan', s, e, b[:300])
s, u, b = get('https://www.epa.gov/ground-water-and-drinking-water/community-water-system-service-area-boundaries', n=200000)
print('EPA page links', re.findall(r'href="([^"]*(?:FeatureServer|MapServer|\.zip|geopackage|gpkg|arcgis)[^"]*)"', b.decode('utf-8','replace'))[:10])

hdr('KY WRIS service areas')
s, u, b = get('https://watermaps.ky.gov/arcgis/rest/services/WebMapServices/PWS_ESA_Boundaries/MapServer/0', {'f': 'json'})
print(s, [f['name'] for f in json.loads(b).get('fields', [])] if s == 200 else b[:200])

hdr('KY SMIS')
s, u, b = get('https://eppcgis.ky.gov/arcgis/rest/services/SMIS', {'f': 'json'}); print(s, b[:800])
try:
    for sv in json.loads(b).get('services', []):
        s2, u2, b2 = get(f"https://eppcgis.ky.gov/arcgis/rest/services/{sv['name']}/{sv['type']}", {'f': 'json'})
        print(' ', sv['name'], [(l['id'], l['name']) for l in json.loads(b2).get('layers', [])])
except Exception as e: print('smis err', e)

hdr('KREF')
s, u, b = get('https://kref.ky.gov/', n=300000)
print(s, sorted(set(re.findall(r'href="([^"]*(?:[Ss]earch|public|KEFMS|secure)[^"]*)"', b.decode('utf-8','replace'))))[:20])

hdr('KLEC lobbying')
for url in ('https://klec.ky.gov/', 'https://klec.ky.gov/Reports/Pages/default.aspx'):
    s, u, b = get(url, n=300000); print(url, s, sorted(set(re.findall(r'href="([^"]*(?:\.xls|\.csv|\.xlsx|\.pdf|Employer|Lobbyist|Reports|Download)[^"]*)"', b.decode('utf-8','replace'))))[:25])

hdr('MI campaign finance export')
s, u, b = get('https://mi-boe.entellitrak.com/etk-mi-boe-prod/page.request.do?page=gov.mi.boe.component.cfrexport.page.cfrexportdownload', n=400000)
print(s, len(b)); print(sorted(set(re.findall(r'href="([^"]+)"', b.decode('utf-8','replace'))))[:40]); print(txt(b)[:1500])

hdr('TN business search')
s, u, b = get('https://tnbear.tn.gov/Ecommerce/FilingSearch.aspx', n=200000); print(s, u, len(b), txt(b)[:500])
hdr('WV business search')
s, u, b = get('https://apps.sos.wv.gov/business/corporations/', n=200000); print(s, u, len(b), txt(b)[:600])
