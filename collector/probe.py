#!/usr/bin/env python3
"""One-off probe: print the real shape of sources before the collector relies on them.
Safe to delete once the collector is verified. Never fails the build."""
import csv, io, json, sys, zipfile, urllib.request

UA = 'PeoplesCaseFile/0.2 (public-records research; https://github.com/BuildBeyond1889/peoples-case-file)'


def get(url, timeout=600):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def zip_heads(url, want=None):
    print(f'\n### ZIP {url}', flush=True)
    try:
        body = get(url)
        z = zipfile.ZipFile(io.BytesIO(body))
        print('  size MB', round(len(body) / 1e6, 1), 'files:', [(i.filename, round(i.file_size / 1e6, 1)) for i in z.infolist()])
        for n in z.namelist():
            if want and not any(w.lower() in n.lower() for w in want):
                continue
            with z.open(n) as f:
                head = io.TextIOWrapper(f, encoding='latin-1').readline().strip()
                second = io.TextIOWrapper(z.open(n), encoding='latin-1')
                second.readline()
                print(f'  {n}: HEADER {head[:900]}')
                print(f'  {n}: ROW1   {second.readline().strip()[:600]}')
    except Exception as e:
        print('  FAILED', repr(e))


def js(url):
    print(f'\n### JSON {url}', flush=True)
    try:
        body = get(url, timeout=120)
        txt = body.decode('utf-8', 'replace')
        print('  ', txt[:1500])
    except Exception as e:
        print('  FAILED', repr(e))


def main():
    # ECHO metadata: which columns can link a facility to its water permit?
    try:
        meta = json.loads(get('https://echodata.epa.gov/echo/echo_rest_services.metadata?output=JSON'))
        cols = meta.get('Results', {}).get('ResultColumns', [])
        print('ECHO metadata total columns', len(cols))
        print('ECHO permit/ID columns:', [c.get('ObjectName') for c in cols if any(k in (c.get('ObjectName') or '') for k in ('NPDES', 'Permit', 'Source', 'IDs', 'Expir'))])
    except Exception as e:
        print('ECHO metadata FAILED', repr(e))
    # EPA ICIS-NPDES bulk (permits with status + expiration)
    zip_heads('https://echo.epa.gov/files/echodownloads/npdes_downloads.zip', want=['PERMITS', 'FACILITIES', 'QNCR', 'VIOL'])
    # MSHA inspections + production for fair comparisons
    zip_heads('https://arlweb.msha.gov/OpenGovernmentData/DataSets/Inspections.zip')
    zip_heads('https://arlweb.msha.gov/OpenGovernmentData/DataSets/MinesProdYearly.zip')
    # Envirofacts: TRI facilities + SDWIS water systems
    for u in ['https://data.epa.gov/efservice/tri_facility/state_abbr/MI/rows/0:1/JSON',
              'https://data.epa.gov/efservice/sdw_water_system/state_code/MI/rows/0:1/JSON',
              'https://data.epa.gov/efservice/WATER_SYSTEM/STATE_CODE/MI/rows/0:1/JSON',
              'https://data.epa.gov/efservice/GEOGRAPHIC_AREA/STATE_SERVED/MI/rows/0:1/JSON',
              'https://data.epa.gov/efservice/sdw_geographic_area/state_served/MI/rows/0:1/JSON',
              'https://data.epa.gov/efservice/VIOLATION/rows/0:1/JSON',
              'https://data.epa.gov/efservice/sdw_viol_enforcement/rows/0:1/JSON',
              'https://data.epa.gov/efservice/tri_release_qty/rows/0:1/JSON']:
        js(u)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('probe crashed', repr(e))
    sys.exit(0)
