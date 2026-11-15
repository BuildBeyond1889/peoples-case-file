#!/usr/bin/env python3
"""Probe 13: EPA water boundaries fields, KY WRIS query, KREF search API, KLEC report files, MI CFR export API, KY DMP pending apps."""
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
        return f'HTTP {e.code}', url, e.read()[:400]
    except Exception as e:
        return repr(e), url, b''
def hdr(t): print('\n==', t, '==')
hdr('EPA water boundaries')
base = 'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Water_System_Boundaries/FeatureServer'
s, u, b = get(base, {'f': 'json'}); L = json.loads(b).get('layers', []) if s == 200 else []; print(s, [(l['id'], l['name']) for l in L])
for l in L[:2]:
    s, u, b = get(f"{base}/{l['id']}", {'f': 'json'}); print(' fields', [f['name'] for f in json.loads(b).get('fields', [])][:30])
    s, u, b = get(f"{base}/{l['id']}/query", {'where': '1=1', 'geometry': '-83.80,42.90,-83.45,43.15', 'geometryType': 'esriGeometryEnvelope', 'inSR': 4326, 'spatialRel': 'esriSpatialRelIntersects', 'outFields': '*', 'returnGeometry': 'false', 'f': 'json', 'resultRecordCount': 40})
    try: fs = json.loads(b)['features']; print(' genesee', len(fs), [{k: v for k, v in f['attributes'].items() if k.lower() in ('pwsid', 'pws_name', 'name', 'population_served_count', 'boundary_data_source', 'service_area_type')} for f in fs[:8]])
    except Exception as e: print(' genesee', s, b[:300])
hdr('KY WRIS ESA harlan')
s, u, b = get('https://watermaps.ky.gov/arcgis/rest/services/WebMapServices/PWS_ESA_Boundaries/MapServer/0/query', {'where': '1=1', 'geometry': '-83.55,36.70,-82.95,37.05', 'geometryType': 'esriGeometryEnvelope', 'inSR': 4326, 'spatialRel': 'esriSpatialRelIntersects', 'outFields': 'PWSID,NAME,CITY,POP,TYPE,SOURCE', 'returnGeometry': 'false', 'f': 'json'})
try: print([f['attributes'] for f in json.loads(b)['features']])
except Exception as e: print(s, b[:300])
hdr('KREF public search')
s, u, b = get('https://secure.kentucky.gov/kref/publicsearch/CandidateSearch')
h = b.decode('utf-8', 'replace'); print(s, u, len(h))
print('forms', re.findall(r'<form[^>]*>', h)[:4]); print('inputs', re.findall(r'<(?:input|select)[^>]*name="([^"]+)"', h)[:30])
print('links', sorted(set(re.findall(r'href="(/kref/publicsearch/[^"]+)"', h)))[:30])
for src in re.findall(r'<script[^>]*src="([^"]+)"', h):
    if any(k in src for k in ('jquery', 'bootstrap', 'google', 'modernizr')): continue
    s2, u2, js = get(urllib.parse.urljoin(u, src)); js = js.decode('utf-8', 'replace')
    for m in re.finditer(r'.{0,160}(url\s*:|\$\.(?:ajax|get|post)|fetch\(|/kref/publicsearch/[A-Za-z/]+).{0,200}', js): print('  JS', src, m.group(0)[:360])
for path in ('ContributorSearch', 'Contributors', 'ContributionSearch', 'SearchContributions'):
    s, u, b = get('https://secure.kentucky.gov/kref/publicsearch/' + path, n=4000); print(path, s, u, b[:200])
hdr('KLEC employer reports')
s, u, b = get('https://klec.ky.gov/Reports/Pages/Employers-and-Legislative-Agents.aspx'); h = b.decode('utf-8', 'replace')
print(s, sorted(set(re.findall(r'href="([^"]+\.(?:xlsx?|csv|pdf|txt|zip))"', h, re.I)))[:40])
hdr('MI CFR export')
s, u, b = get('https://mi-boe.entellitrak.com/etk-mi-boe-prod/page.request.do?page=gov.mi.boe.component.cfrexport.page.cfrexportdownload'); h = b.decode('utf-8', 'replace')
for src in re.findall(r'(?:src|href)="(page\.resource\.request\.do\?[^"]+)"', h):
    s2, u2, js = get(urllib.parse.urljoin(u, src.replace('&amp;', '&'))); js = js.decode('utf-8', 'replace')
    print(' res', src[:120], s2, len(js))
    for m in re.finditer(r'.{0,200}(ajax|fetch\(|url\s*[:=]|\.do\?|download).{0,300}', js): print('   JS', m.group(0)[:500])
for m in re.finditer(r'<script[^>]*>(.*?)</script>', h, re.S):
    if re.search(r'ajax|fetch|\.do|download', m.group(1)): print(' inline', m.group(1)[:2500])
hdr('KY DMP pending applications')
for url in ('https://eec.ky.gov/Natural-Resources/Mining/Mine-Permits/Pages/default.aspx', 'https://eec.ky.gov/Natural-Resources/Mining/Mine-Permits/Pages/Permit-Applications.aspx'):
    s, u, b = get(url, n=400000); h = b.decode('utf-8', 'replace')
    print(url, s, sorted(set(re.findall(r'href="([^"]*(?:[Pp]ending|[Aa]pplication|[Nn]otice|Doctree|doctree|[Bb]ond)[^"]*)"', h)))[:30])
