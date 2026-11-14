#!/usr/bin/env python3
"""Diagnostic probe: print the real shape of sources before the collector relies on them. Never fails the build."""
import json, sys, urllib.parse, urllib.request
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
def show(label, url, n=2500):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            st, txt = r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        st, txt = e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:
        st, txt = None, repr(e)
    print(f'\n### {label}\n{url}\nstatus {st}\n{txt[:n]}', flush=True)
try:
    show('LDA filings by client', 'https://lda.senate.gov/api/v1/filings/?client_name=' + urllib.parse.quote('Arch Resources') + '&page_size=2')
    show('LDA contributions', 'https://lda.senate.gov/api/v1/contributions/?registrant_name=' + urllib.parse.quote('Arch Resources') + '&page_size=2')
    show('FEC schedule_b itemized', 'https://api.open.fec.gov/v1/schedules/schedule_b/?committee_id=C00167668&per_page=2&sort=-disbursement_date&api_key=DEMO_KEY')
    show('Pages money.json head', 'https://buildbeyond1889.github.io/peoples-case-file/data/money.json', 600)
except Exception as e:
    print('probe crashed', repr(e))
sys.exit(0)
