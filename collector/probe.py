#!/usr/bin/env python3
"""Diagnostic probe: SEC EDGAR full-text search (Exhibit 95 mine IDs, Exhibit 21 subsidiaries) and GLEIF parents."""
import json, re, sys, time, urllib.parse, urllib.request

UA = 'PeoplesCaseFile BuildBeyond1889@users.noreply.github.com'
PAGES = 'https://buildbeyond1889.github.io/peoples-case-file/'


def get(url, params=None):
    if params:
        url += '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json,text/html'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            b = r.read()
        time.sleep(0.25)
        return r.status, b
    except Exception as e:
        return repr(e), b''


def fts(q, **kw):
    s, b = get('https://efts.sec.gov/LATEST/search-index', {'q': q, **kw})
    if not b:
        print('  FTS', q, s); return []
    j = json.loads(b)
    hits = j.get('hits', {}).get('hits', [])
    print(f'  FTS {q} {kw} -> total {j["hits"]["total"]["value"]}')
    for h in hits[:6]:
        src = h['_source']
        print('    ', src.get('file_type'), src.get('file_date'), src.get('display_names'), h['_id'])
    return hits


# 1. Mine IDs from the live site
s, b = get(PAGES + 'data/index.json')
s, b = get(PAGES + 'data/mines.geojson')
mines = json.loads(b)['features'] if b else []
print('mines', len(mines), 'sample props', list(mines[0]['properties'].keys())[:40] if mines else None)
recent = [m['properties'] for m in mines if (m['properties'].get('viol') or {}).get('since2000')]
recent = sorted(recent, key=lambda p: -((p.get('viol') or {}).get('total') or 0))[:3]

# 2. Exhibit 95 lookups by mine ID, two formats
print('\n== Exhibit 95 by mine ID ==')
for p in recent:
    mid = str((p.get('ids') or {}).get('msha_mine') or p.get('id'))
    print(p.get('name'), mid, p.get('operator'), p.get('parent'), p.get('status'))
    fts(f'"{mid}"', forms='10-K')
    fts(f'"{mid[:2]}-{mid[2:]}"', forms='10-K')

# 3. Read one Exhibit 95 to see the ID format
print('\n== Sample Exhibit 95 text ==')
hits = fts('"Lone Mountain Processing"', forms='10-K')
for h in hits:
    if h['_source'].get('file_type', '').startswith('EX-95'):
        adsh, fn = h['_id'].split(':')
        cik = int(h['_source']['ciks'][0])
        url = f'https://www.sec.gov/Archives/edgar/data/{cik}/{adsh.replace("-", "")}/{fn}'
        s, b = get(url)
        txt = re.sub(r'<[^>]+>', ' ', b.decode('latin-1'))
        txt = re.sub(r'\s+', ' ', txt)
        print(url, s, len(txt))
        for m in list(re.finditer(r'\b15-?\d{5}\b', txt))[:12]:
            print('   ', txt[max(0, m.start() - 60):m.end() + 10])
        break

# 4. Exhibit 21 by subsidiary name
print('\n== Exhibit 21 by name ==')
for n in ['Lone Mountain Processing', 'Blackjewel', 'Inmet Mining', 'Panther Mining', 'Harlan Cumberland Coal',
          'Lexington Coal Company', 'Revelation Energy']:
    for h in fts(f'"{n}"'):
        pass

# 5. GLEIF
print('\n== GLEIF ==')
for n in ['Javelin Global Commodities (UK)', 'Bluegrass Natural Resources', 'Alpha Metallurgical Resources']:
    s, b = get('https://api.gleif.org/api/v1/fuzzycompletions', {'field': 'entity.legalName', 'q': n})
    print(n, s, b[:400])
    s, b = get('https://api.gleif.org/api/v1/lei-records', {'filter[fulltext]': n, 'page[size]': 3})
    if b:
        for d in json.loads(b).get('data', []):
            a = d['attributes']
            print('  ', d['id'], a['entity']['legalName']['name'], a['entity']['legalAddress'].get('country'),
                  a['entity'].get('status'), list(d.get('relationships', {}).keys()))
            for rel in ('direct-parent', 'ultimate-parent', 'direct-parent-reporting-exception', 'ultimate-parent-reporting-exception'):
                s2, b2 = get(f'https://api.gleif.org/api/v1/lei-records/{d["id"]}/{rel}')
                print('     ', rel, s2, b2[:300])

print('\n== data.sec.gov ==')
s, b = get('https://www.sec.gov/files/company_tickers.json'); print('tickers', s, len(b))
s, b = get('https://data.sec.gov/submissions/CIK0001037676.json'); print('submissions', s, b[:200])
