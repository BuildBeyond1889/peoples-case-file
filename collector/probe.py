#!/usr/bin/env python3
"""Probe 6: KY eSearch API (pending approvals), MiEnviro public notice API, KY SMIS GIS."""
import json, re, urllib.parse, urllib.request
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
def get(url, data=None, headers=None):
    h = {'User-Agent': UA, **(headers or {})}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=90) as r:
            return r.status, r.geturl(), r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return f'HTTP {e.code}', url, e.read().decode('utf-8', 'replace')[:500]
    except Exception as e:
        return repr(e), url, ''
B = 'https://dep.gateway.ky.gov/eSearch/'
s, u, js = get(B + 'js/Approvals/PendingActions.js'); print('PendingActions.js', s, len(js)); print(js[:6000])
for m in re.findall(r'import[^;]+from\s+["\']([^"\']+)["\']', js):
    s2, u2, js2 = get(urllib.parse.urljoin(B + 'js/Approvals/', m))
    print('\n--- import', m, s2, len(js2)); print(js2[:3000])
s, u, h = get(B + 'Approvals/Pending')
for m in re.finditer(r'.{0,200}ApiBaseUrl.{0,300}', h): print('PAGE ApiBaseUrl:', m.group(0))
print('\n== MiEnviro ==')
s, u, js = get('https://mienviro.michigan.gov/ncore/Scripts/ncore.app.min.js?0CF385D40D17CB77')
print('app js', s, len(js))
found = sorted(set(re.findall(r'["\'`]((?:/ncore)?/?(?:api|external)/[^"\'`]*?(?:[Pp]ublic[Nn]otice|notice)[^"\'`]*)["\'`]', js)))
print('notice endpoints', found[:40])
for m in list(re.finditer(r'.{0,250}[Pp]ublic[Nn]otice[A-Za-z]*\s*[:(=].{0,350}', js))[:12]: print('  JS:', m.group(0)[:600])
print('\n== eppcgis SMIS ==')
s, u, h = get('https://eppcgis.ky.gov/arcgis/rest/services/SMIS?f=json'); print(s, h[:1500])
