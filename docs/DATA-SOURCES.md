# Data sources registry

**Status:** none of these were called from the build session (no network). Verify each one: endpoint, parameters, rate limits, terms and CORS.

Join records on **official IDs**, never on names.

| ID to join on | Meaning |
|---|---|
| FRS Registry ID | EPA's master facility ID: links ECHO, TRI, RCRA, NPDES and air permits |
| PWSID | Public water system ID (SDWIS) |
| MSHA Mine ID | Mine; links the operator and controller |
| LEI | Global legal entity ID (GLEIF) |
| CIK | SEC company ID |
| Jurisdiction + company number | State and national registries (via OpenCorporates) |

## Live / current
| Source | What | Access (verify) |
|---|---|---|
| EPA ECHO | Facilities, inspections, violations, enforcement, penalties | REST services at echodata.epa.gov (`echo_rest_services.get_facilities` → `get_qid`); also bulk downloads (ECHO Exporter) |
| EPA TRI | Toxic releases by facility and year (1987 onward) | Envirofacts API (data.epa.gov/efservice) + TRI Basic Data Files |
| EPA SDWIS | Drinking-water systems, violations, lead/copper samples | Envirofacts API; SDWIS Federal Reports downloads |
| EPA FRS | Facility registry: owner/operator, program IDs | Envirofacts / FRS downloads |
| EPA AirNow / AQS | Air quality | AirNow API (needs a free key); AQS API |
| PurpleAir | Community air sensors | API key needed; check the terms |
| MSHA | Mines, operators, controllers, violations, accidents | MSHA Open Government Data datasets (bulk files) |
| OSMRE + state mining permits | Surface-mining permits, bonds, inspections | Varies by state (Kentucky: Energy and Environment Cabinet) |
| State oil & gas, PHMSA | Wells; pipeline incidents | State portals; PHMSA incident data files |
| USAspending | Federal contracts and grants | api.usaspending.gov |
| FEC / state campaign finance | Donations | api.open.fec.gov (free key); state portals |
| Senate LDA | Lobbying filings | lda.senate.gov API |
| SEC EDGAR | Filings, 10-K Exhibit 21 subsidiaries, 13D/G owners | data.sec.gov (needs a User-Agent header with contact) |
| CourtListener / RECAP | Dockets, opinions | courtlistener.com REST API (free token) |
| Regulations.gov + state notices | Open public-comment periods | regulations.gov API (key); state permit-notice pages |
| MuckRock | Public FOIA requests and responses | muckrock.com API |
| GDELT | News mentions | GDELT DOC 2.0 API |
| NASA FIRMS | Fires | FIRMS API (free map key) |
| Sentinel-2 / Landsat | Imagery | Copernicus Data Space; USGS; tiles via EOX "Sentinel-2 cloudless" |
| CDC PLACES / SVI | Health estimates; social vulnerability | data.cdc.gov (Socrata API) |
| Census ACS | Income, demographics by block group | api.census.gov (free key) |

## Corporate tree
| Source | What | Access (verify) |
|---|---|---|
| GLEIF | ~2.9M+ legal entities worldwide, with direct and ultimate parents | api.gleif.org/api/v1 (`lei-records`, `/direct-parent`, `/ultimate-parent`); free golden-copy downloads |
| OpenCorporates | 200M+ companies, officers as filed | api.opencorporates.com (key; free for public-benefit/open projects, so apply) |
| SEC Exhibit 21 | US public-company subsidiary lists | EDGAR full-text / filing index |
| UK Companies House | Persons with significant control | api.company-information.service.gov.uk (free key) |
| Open Ownership | Beneficial-ownership data | register.openownership.org bulk data |
| OpenSanctions | Sanctions + PEP + company links | opensanctions.org datasets (non-commercial free) |
| ICIJ Offshore Leaks | Public offshore entity database | offshoreleaks.icij.org downloads; **match on companies only, label the source** |
| Wikidata | Big-group structure | query.wikidata.org SPARQL |

## Historical (old)
| Source | What |
|---|---|
| Library of Congress Sanborn maps | Fire-insurance maps, 1867–1970, showing old factories, gas plants and tanneries |
| Mapping Inequality (Univ. of Richmond) | 1930s HOLC redlining maps (GeoJSON) |
| USGS topoView / EarthExplorer | Historical topo maps; historical aerial photos |
| Landsat | Imagery since 1972 |
| Chronicling America (LOC) | Digitized newspapers to 1963 |
| Internet Archive Wayback | Old web pages since 1996 (CDX API) |
| PEDP screening-tools.com, Yale mirror | Frozen EJScreen / CEJST / EJAM data |
| EPA Superfund (SEMS) | Site histories, records of decision |

## Archiving rule
Every pull is saved as `archive/<source>/<YYYY-MM-DD>/<file>` along with:
- its SHA-256
- the source URL and pull time, in `manifest.json`

Optionally, timestamp the hashes (OpenTimestamps) so lawyers can prove the records weren't altered. Never overwrite a snapshot.
