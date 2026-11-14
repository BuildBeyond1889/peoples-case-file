#!/usr/bin/env python3
"""Probe 10: Census block-group boundaries (TIGERweb) and ACS 5-year block-group data (no key)."""
import json, urllib.parse, urllib.request
UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'
def get(url, params=None):
    if params: url += '?' + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=120) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return f'HTTP {e.code}', e.read()[:400]
    except Exception as e:
        return repr(e), b''
for svc in ('tigerWMS_ACS2024', 'tigerWMS_ACS2023', 'tigerWMS_Current'):
    s, b = get(f'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/{svc}/MapServer', {'f': 'json'})
    if s == 200:
        L = [(l['id'], l['name']) for l in json.loads(b).get('layers', []) if 'Block Group' in l['name'] or 'Tract' in l['name']]
        print(svc, L)
        for lid, name in L:
            if 'Block Group' in name:
                s2, b2 = get(f'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/{svc}/MapServer/{lid}/query',
                             {'where': "STATE='21' AND COUNTY='095'", 'outFields': 'GEOID,NAME,STATE,COUNTY,TRACT,BLKGRP,AREALAND', 'returnGeometry': 'true',
                              'outSR': 4326, 'geometryPrecision': 5, 'maxAllowableOffset': 0.0005, 'f': 'geojson'})
                try:
                    fs = json.loads(b2)['features']; print('  BG harlan', s2, len(fs), len(b2), fs[0]['properties'] if fs else None)
                except Exception as e: print('  BG harlan', s2, e, b2[:300])
    else:
        print(svc, s)
V = 'NAME,B01001_001E,B01001_003E,B01001_027E,B01001_020E,B01001_021E,B01001_022E,B01001_023E,B01001_024E,B01001_025E,B01001_044E,B01001_045E,B01001_046E,B01001_047E,B01001_048E,B01001_049E,C17002_001E,C17002_002E,C17002_003E,C17002_004E,C17002_005E,C17002_006E,C17002_007E'
for yr in (2024, 2023):
    s, b = get(f'https://api.census.gov/data/{yr}/acs/acs5', {'get': V, 'for': 'block group:*', 'in': 'state:21 county:095'})
    print('ACS', yr, 'harlan', s, b[:300])
    s, b = get(f'https://api.census.gov/data/{yr}/acs/acs5', {'get': 'C17002_001E', 'for': 'block group:*', 'in': 'state:21 county:* tract:*'})
    print('ACS', yr, 'KY statewide', s, len(b), b[:200])
