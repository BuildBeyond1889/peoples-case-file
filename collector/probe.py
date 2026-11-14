#!/usr/bin/env python3
"""Probe 8: MiEnviro repository base + public notice list; KY pending-approval documents."""
import json, re, urllib.parse, urllib.request
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
def get(url, data=None, headers=None):
    h = {'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', **(headers or {})}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=90) as r:
            return r.status, r.geturl(), r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return f'HTTP {e.code}', url, e.read().decode('utf-8', 'replace')[:600]
    except Exception as e:
        return repr(e), url, ''
s, u, js = get('https://mienviro.michigan.gov/ncore/Scripts/ncore.app.min.js?0CF385D40D17CB77')
for pat in (r'factory\("repository".{0,1500}', r'getList:function.{0,600}', r'apiRoot.{0,200}', r'"api/".{0,200}', r'vroot.{0,120}'):
    for m in list(re.finditer(pat, js))[:2]: print('JS', pat, '::', m.group(0)[:1500])
s, u, h = get('https://mienviro.michigan.gov/ncore/external/home')
for m in re.finditer(r'.{0,150}(apiRoot|vroot|baseUrl|apiUrl|appSettings).{0,300}', h): print('HOME', m.group(0)[:500])
for path in ('api/publicnoticeslist', 'ncore/api/publicnoticeslist', 'ncore/external/api/publicnoticeslist', 'ncore/api/external/publicnoticeslist'):
    for q in ('', '?$top=5', '?pageSize=5&page=1'):
        s, u, r = get('https://mienviro.michigan.gov/' + path + q)
        print('MI', path + q, s, r[:700].replace('\n', ' '))
print('\n== KY documents ==')
B = 'https://dep.gateway.ky.gov/eSearch.WebApi/'
s, u, r = get(B + 'api/PendingApproval/Search', json.dumps({'County': 'Harlan'}).encode(), {'Content-Type': 'application/json'})
rows = json.loads(r)
print('rows', len(rows)); print('milestones', sorted({x['CurrentMilestone'] for x in rows}))
print('activity types', sorted({x['ActivityType'] for x in rows}))
for row in [x for x in rows if x.get('DetailRows')][:3]:
    s, u, d = get(B + 'api/pendingapproval/document/' + urllib.parse.quote(json.dumps(row)))
    print('DOC', row['AgencyName'], s, d[:1500])
s, u, r = get(B + 'api/PendingApproval/Search', json.dumps({'County': 'Genesee'}).encode(), {'Content-Type': 'application/json'})
print('KY Genesee sanity', s, r[:100])
