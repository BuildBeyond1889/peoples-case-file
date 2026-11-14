#!/usr/bin/env python3
"""Probe 9: can a browser call GLEIF directly (CORS)? Shape of children / ultimate-children lists."""
import json, urllib.request
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
def get(url, origin=None, method='GET'):
    h = {'User-Agent': UA, 'Accept': 'application/vnd.api+json'}
    if origin: h['Origin'] = origin
    if method == 'OPTIONS': h['Access-Control-Request-Method'] = 'GET'
    req = urllib.request.Request(url, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
O = 'https://buildbeyond1889.github.io'
for u in ('https://api.gleif.org/api/v1/lei-records?filter[fulltext]=Alpha%20Metallurgical&page[size]=3',
          'https://api.gleif.org/api/v1/fuzzycompletions?field=fulltext&q=Peabody%20Energy'):
    s, h, b = get(u, O)
    print(u, s, {k: v for k, v in h.items() if k.lower().startswith('access-control')}, b[:300])
s, h, b = get('https://api.gleif.org/api/v1/lei-records?filter[fulltext]=Peabody', O, 'OPTIONS'); print('OPTIONS', s, {k: v for k, v in h.items() if k.lower().startswith('access-control')})
# Peabody Energy: children
s, h, b = get('https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=PEABODY%20ENERGY%20CORPORATION')
d = json.loads(b)['data']; print('peabody', [(x['id'], x['attributes']['entity']['legalName']['name']) for x in d])
if d:
    lei = d[0]['id']
    for rel in ('direct-children', 'ultimate-children'):
        s, h, b = get(f'https://api.gleif.org/api/v1/lei-records/{lei}/{rel}?page[size]=100')
        j = json.loads(b) if s == 200 else {}
        print(rel, s, (j.get('meta') or {}).get('pagination'), [(x['attributes']['entity']['legalName']['name'], x['attributes']['entity']['legalAddress'].get('country')) for x in j.get('data', [])][:15])
