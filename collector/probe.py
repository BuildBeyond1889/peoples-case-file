#!/usr/bin/env python3
"""Diagnostic probe: print the real shape of sources before the collector relies on them. Never fails the build."""
import json, sys, urllib.parse, urllib.request

UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'


def call(url, body=None, timeout=90):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')[:600]
    except Exception as e:
        return None, repr(e)


def show(label, url, body=None, n=1800):
    st, txt = call(url, body)
    print(f'\n### {label}\n{url}\nstatus {st}\n{txt[:n]}', flush=True)


def main():
    name = 'Bluegrass Natural Resources'
    # USAspending: contracts (A-D), grants (02-05), loans (07, 08 incl. PPP)
    for codes in (['A', 'B', 'C', 'D'], ['07', '08'], ['02', '03', '04', '05']):
        show(f'USAspending {codes}', 'https://api.usaspending.gov/api/v2/search/spending_by_award/', {
            'filters': {'recipient_search_text': [name], 'award_type_codes': codes},
            'fields': ['Award ID', 'Recipient Name', 'Award Amount', 'Loan Value', 'Awarding Agency', 'Start Date', 'Description',
                       'recipient_id', 'Recipient UEI', 'Place of Performance State Code', 'Recipient Location'],
            'limit': 3, 'page': 1})
    show('USAspending recipient autocomplete', 'https://api.usaspending.gov/api/v2/autocomplete/recipient/', {'search_text': name, 'limit': 5})
    # CourtListener (anonymous)
    q = urllib.parse.quote(f'"{name}"')
    show('CourtListener v4 search RECAP', f'https://www.courtlistener.com/api/rest/v4/search/?q={q}&type=r')
    show('CourtListener v3 search RECAP', f'https://www.courtlistener.com/api/rest/v3/search/?q={q}&type=r')
    # FEC with DEMO_KEY: committees connected to an organization
    show('FEC committees', f'https://api.open.fec.gov/v1/committees/?q={urllib.parse.quote("Alpha Natural Resources")}&api_key=DEMO_KEY&per_page=3')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('probe crashed', repr(e))
    sys.exit(0)
