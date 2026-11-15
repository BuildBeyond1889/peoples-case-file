#!/usr/bin/env python3
"""Run this on YOUR computer (SEC blocks GitHub's servers, not home internet).

    python3 collector/sec_local.py

Needs only Python 3. Takes about 5-10 minutes. It reads the live site's companies and mines,
asks SEC EDGAR full-text search two public questions, and writes manual/sec.json:

  1. Exhibit 21 (subsidiary lists): which public companies list our controllers/operators as subsidiaries.
  2. Exhibit 95 (mine safety disclosures): which public companies list our mines by MSHA mine ID.

Then upload manual/sec.json to the repo (GitHub website: Add file > Upload files, into the "manual" folder).
The next build puts it on the site. Re-run every few months.
"""
import json, os, re, sys, time, urllib.parse, urllib.request

PAGES = 'https://buildbeyond1889.github.io/peoples-case-file/data/'
FTS = 'https://efts.sec.gov/LATEST/search-index'
UA = 'PeoplesCaseFile BuildBeyond1889@users.noreply.github.com'   # SEC asks automated tools to identify themselves
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'manual', 'sec.json')
SUFFIX = re.compile(r'\b(llc|l\.l\.c|inc|incorporated|co|corp|corporation|company|ltd|lp|llp|the|of)\b\.?', re.I)


def norm(n):
    return ' '.join(re.findall(r'[a-z0-9]+', SUFFIX.sub(' ', (n or '').lower())))


def get_json(url, params=None, tries=4):
    if params:
        url += '?' + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=60) as r:
                body = r.read()
            time.sleep(0.15)   # SEC limit is 10 requests a second; stay well under
            return json.loads(body)
        except Exception as e:
            if i == tries - 1:
                print('  gave up:', url[:100], e)
                return None
            time.sleep(2 * (i + 1))


def hits(q, **kw):
    j = get_json(FTS, {'q': q, **kw}) or {}
    out = []
    for h in (j.get('hits') or {}).get('hits', []):
        s = h['_source']
        adsh, fn = h['_id'].split(':', 1)
        cik = int((s.get('ciks') or ['0'])[0])
        out.append({'company': re.sub(r'\s*\(CIK \d+\)', '', (s.get('display_names') or ['?'])[0]).strip(), 'cik': cik,
                    'form': s.get('form'), 'exhibit': s.get('file_type'), 'filed': s.get('file_date'),
                    'url': f'https://www.sec.gov/Archives/edgar/data/{cik}/{adsh.replace("-", "")}/{fn}'})
    return out


def main():
    print('Reading the live site…')
    fams = get_json(PAGES + 'families.json') or []
    mines = (get_json(PAGES + 'mines.geojson') or {}).get('features', [])
    names = []
    for f in sorted(fams, key=lambda f: -((f.get('viol') or {}).get('total') or 0))[:80]:
        if not (f.get('controller_type') or '').upper().startswith('P'):
            names.append(f['controller'])
        names += [o['name'] for o in f.get('operators', [])[:3] if o.get('name')]
    names = list({norm(n): n for n in names if len(norm(n)) > 4}.values())
    ids = sorted({str((m['properties'].get('ids') or {}).get('msha_mine')) for m in mines
                  if ((m['properties'].get('viol') or {}).get('since2000') or 0) > 0} - {'None'})
    out = {'as_of': time.strftime('%Y-%m-%d'), 'source': 'SEC EDGAR full-text search (2001-present)',
           'rules': 'Exhibit 21 hits: the company name appears in a public company\'s subsidiary list (exact phrase). '
                    'Exhibit 95 hits: the MSHA mine ID appears in a public company\'s mine safety disclosure.',
           'by_name': {}, 'by_mine': {}}
    print(f'Checking {len(names)} company names for Exhibit 21 subsidiary lists…')
    for i, n in enumerate(names, 1):
        hs = [h for h in hits(f'"{n}"', forms='10-K') if (h['exhibit'] or '').upper().startswith('EX-21')]
        if hs:
            out['by_name'][norm(n)] = {'name': n, 'listed_by': hs[:10]}
        if i % 20 == 0:
            print(f'  {i}/{len(names)}')
    print(f'Checking {len(ids)} mine IDs for Exhibit 95 mine safety disclosures…')
    for i, mid in enumerate(ids, 1):
        hs = []
        for q in (f'"{mid}"', f'"{mid[:2]}-{mid[2:]}"'):
            hs += [h for h in hits(q) if (h['exhibit'] or '').upper().startswith('EX-95')]
        if hs:
            uniq = {(h['cik'], h['filed']): h for h in hs}
            out['by_mine'][mid] = sorted(uniq.values(), key=lambda h: h['filed'] or '', reverse=True)[:12]
        if i % 50 == 0:
            print(f'  {i}/{len(ids)}')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, 'w'), indent=1)
    print(f"\nDone: {len(out['by_name'])} companies found in subsidiary lists, {len(out['by_mine'])} mines found in mine safety disclosures.")
    print('Saved', OUT, '- now upload it to the repo\'s "manual" folder.')


if __name__ == '__main__':
    sys.exit(main())
