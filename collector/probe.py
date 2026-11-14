#!/usr/bin/env python3
"""Diagnostic probe: summarize the live money.json. Never fails the build."""
import json, sys, time, urllib.request
try:
    raw = urllib.request.urlopen(urllib.request.Request(f'https://buildbeyond1889.github.io/peoples-case-file/data/money.json?t={int(time.time())}', headers={'Cache-Control': 'no-cache'}), timeout=60).read()
    m = json.loads(raw)
    print('as_of', m.get('as_of'), 'courts', m.get('courts'), 'lobbying', m.get('lobbying'), 'names', len(m['by_name']))
    for k, r in m['by_name'].items():
        lob = r.get('lobbying') or []
        pay = sum(len(c.get('itemized') or []) for c in r.get('fec') or [])
        cs = r.get('courts') or {}
        bk = [c for c in cs.get('cases', []) if c.get('bankruptcy')]
        if lob or pay or cs.get('count') or bk:
            yrs = (min(x['year'] for x in lob), max(x['year'] for x in lob)) if lob else ''
            amt = round(sum(float(x.get('amount') or 0) for x in lob))
            iss = {}
            for x in lob:
                for i in x.get('issues', []):
                    iss[i] = iss.get(i, 0) + 1
            print(f"{r['name']} | lobby {len(lob)} {yrs} ${amt} {sorted(iss, key=iss.get, reverse=True)[:3]} | pac pay {pay} | cases {cs.get('count', 0)} | bk {[(c['case'][:45], c['court_id'], c['filed']) for c in bk][:3]}")
except Exception as e:
    print('probe crashed', repr(e))
sys.exit(0)
