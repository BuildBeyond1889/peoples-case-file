#!/usr/bin/env python3
"""Probe 7: KY eSearch pending-approval API calls; KY SMIS layers; MiEnviro external public notice search service."""
import json, re, urllib.parse, urllib.request
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
def get(url, data=None, headers=None):
    h = {'User-Agent': UA, **(headers or {})}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=90) as r:
            return r.status, r.geturl(), r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return f'HTTP {e.code}', url, e.read().decode('utf-8', 'replace')[:800]
    except Exception as e:
        return repr(e), url, ''
B = 'https://dep.gateway.ky.gov/eSearch/'
s, u, h = get(B + 'Approvals/Pending')
api = re.search(r'id="apiBaseUrl"[^>]*value="([^"]*)"', h) or re.search(r'value="([^"]*)"[^>]*id="apiBaseUrl"', h)
api = api.group(1) if api else None
print('apiBaseUrl =', api)
s, u, js = get(B + 'js/Approvals/PendingActions.js')
i = js.find('getPendingApprovalData(options)'); print(js[i:i + 2200])
s, u, ds = get(B + 'js/DataServices.js'); print('\nDataServices.js\n', ds[:2500])
for m in re.findall(r'import[^;]+from\s+["\'](\.\./Models/[^"\']+)["\']', js) + ['../Models/PendingApprovalFilterFieldModel.js']:
    s2, u2, mj = get(urllib.parse.urljoin(B + 'js/Approvals/', m)); print('\nMODEL', m, s2, mj[:1500])
if api:
    base = urllib.parse.urljoin(B, api)
    print('\nAPI base', base)
    for path in ('api/PendingApproval/Lookup/Counties', 'api/PendingApproval/Lookup/Programs'):
        s, u, r = get(base + path); print(path, s, r[:800])
    for body in ({'County': 'Harlan'}, {'county': 'HARLAN'}, {'County': 'Harlan', 'MilestoneChangedDays': 365}):
        for method in ('json', 'qs'):
            if method == 'json':
                s, u, r = get(base + 'api/PendingApproval/Search', json.dumps(body).encode(), {'Content-Type': 'application/json'})
            else:
                s, u, r = get(base + 'api/PendingApproval/Search?' + urllib.parse.urlencode(body))
            print('SEARCH', body, method, s, r[:1500])
print('\n== SMIS layers ==')
s, u, h = get('https://eppcgis.ky.gov/arcgis/rest/services/SMIS/Ky_SMIS_WGS84WM/MapServer?f=json')
try:
    for L in json.loads(h).get('layers', []): print('  layer', L['id'], L['name'])
except Exception as e: print(s, h[:500])
print('\n== MiEnviro external public notice ==')
s, u, js = get('https://mienviro.michigan.gov/ncore/Scripts/ncore.app.min.js?0CF385D40D17CB77')
for m in list(re.finditer(r'.{0,400}external\.publicNotice\.search.{0,600}', js))[:4]: print('  JS:', m.group(0)[:1000])
for m in list(re.finditer(r'.{0,300}(?:PublicNoticeSearch|publicNoticeSearch|searchPublicNotices|getPublicNotices|PublicNotices/)[^"\']{0,80}.{0,300}', js))[:10]: print('  JS2:', m.group(0)[:700])
