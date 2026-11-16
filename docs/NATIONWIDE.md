# Every county in the US: the plan

**Goal (Lu, Nov 16 2026):** the Harlan/Flint level of sophistication for all 3,143 US counties, and still easy to read.

**The idea:** stop pulling data per county. Pull each national dataset once, build everything nationally, then slice it into small per-county files and map tiles that the site loads as you pan. Federal data covers every county the same way. State data (permits, business registries, campaign money, comment periods) is 50 different systems, so it gets added state by state through "adapters". Each county page says exactly what it has and what it's missing.

---

## 1. Data: national bulk files (same depth everywhere)
| Layer | National source | Already used? |
|---|---|---|
| Mines, operators, controllers, citations, inspections, production | MSHA open data `.zip` files (already national) | yes: filter removed |
| Every EPA-regulated site, compliance, enforcement, penalties | **ECHO Exporter** (one national CSV, ~1.5M facilities) | per-area API now → switch to bulk |
| Water-discharge permits, reports over limits, enforcement | ICIS-NPDES national downloads + DMR bulk | per-permit now → bulk |
| Toxic releases **plus parent companies** | TRI Basic Data Files (every year since 1987, includes `PARENT CO NAME` and standardized parent) | yes → national + parent tree |
| Drinking water systems, violations, lead/copper | SDWIS national downloads + EPA water-system service boundaries | per county now → bulk |
| Air permits / emissions | ECHO air (ICIS-Air) bulk; EPA NEI | new |
| Hazardous waste | RCRAInfo bulk | new |
| Superfund / cleanup sites | SEMS / CIMC | new |
| Neighborhoods | Census ACS 5-yr, **all ~240,000 block groups**; TIGER shapes | 2 counties now → all |
| Health estimates | CDC PLACES (tract/county), CDC SVI | new (shown as estimates only) |
| Federal money | USAspending bulk award files | per-name API now → bulk |
| Federal campaign money / lobbying | FEC bulk files; Senate LDA | per-name API now → bulk |
| Courts | CourtListener (API quota: on demand, top families first) | yes |
| Who owns whom (world) | **GLEIF golden copy** (full bulk, ~2.9M entities + relationships) | live API now → bulk + live |

**Free corporate tree everywhere:** TRI's reported parent companies, GLEIF relationships, SEC Exhibit 21 (Lu's laptop script) and MSHA controllers together give a parent tree for most big polluters nationwide, without any state registry.

## 2. Build: a matrix of jobs, $0
- **GitHub Actions** (free and unlimited for public repos, 6 hours per job):
  - Job 1 downloads the national files once and archives them with SHA-256.
  - Then a **matrix of 51 jobs (50 states + DC)** builds each state's counties in parallel.
  - A final job assembles the national files and deploys.
- **Daily vs. weekly:**
  - Fast-moving sources (comment periods, new enforcement) refresh daily.
  - Big bulk files refresh weekly or monthly, on the agency's own release schedule.
- **Quotas** (CourtListener, FEC, OpenCorporates) go through a **priority queue**: biggest families and flagged sites first, the rest over following days. Every record shows its own "pulled" date.

## 3. Serve: small files + tiles
- **Map:** national vector tiles in **PMTiles** format (one file, read in pieces as you pan).
  - Separate layers for mines, EPA sites, TRI, water systems, block-group EJ scores and permit areas.
  - **Hosting:** Cloudflare R2 free tier (10 GB, no bandwidth fees) or GitHub Pages if it fits under 1 GB.
- **County page** `#county/<FIPS>`:
  - one small JSON per county (`data/county/21095.json`) with its summary, top flags, families present, water systems, comment periods and coverage card
  - loads in under a second on a phone
- **Family / company pages:** one JSON per controller or parent (`data/family/<id>.json`), so a company spanning 12 states is one page.
- **Search:** a compact national index (county names, towns, mines, companies) built at deploy time.
- **Raw archive:** monthly GitHub Releases, as now (split into parts under 2 GB).

## 4. State adapters (what makes it deep, added one by one)
Each adapter is one file under `collector/states/<st>.py` that adds what that state publishes:
- mining / oil-and-gas / water permits and their boundaries
- open public-comment notices
- business registry (officers as filed)
- campaign finance and lobbying
- reclamation bonds

Each county's **coverage card** shows which ones are live: "State permits ✓ · Comment alerts ✓ · Business registry ✗ (not connected yet)".

**Suggested order:** coal and extraction first, where the story is strongest.
1. **Done or partial:** KY, MI.
2. **Appalachia:** WV, VA, PA, OH, TN.
3. **Big footprints:** TX, LA, WY, ND, NM.
4. **Population:** CA, NY, IL, FL.
5. **The rest.**

## 5. Readable for anyone (as important as the data)
- **Every county page opens with "What's here, in plain English":** 3–5 sentences generated **from templates filled with record counts**, never free-written by AI.
  - Example: "Harlan County has 743 coal mines on record, 41 still active. The 5 companies that controlled the most mines collected 12,400 safety citations…"
  - Every sentence links to its records.
- **Simple mode by default.** Jargon is translated everywhere (no raw SIC codes or program acronyms). A tap-to-explain glossary covers the terms that remain (S&S, NPDES, MCL).
- **Reading level:** aim for 8th grade in Simple mode, checked automatically on the template text.
- **"Compare me":** this county vs. similar counties, the state and the nation, as plain bars, not tables.
- **Phone first:** every page tested at 390 px, big tap targets, works on slow rural connections (small JSON, tiles load on demand, offline cache of your last county).
- **Spanish next:** templates make translation straightforward.

## 6. Accuracy at national scale
- **Join on official IDs:**
  - MSHA mine ID, FRS registry ID, NPDES permit ID, PWSID, TRI ID, LEI, CIK
  - names only by exact normalized match, and labelled
- **Automated sanity checks on every build, before deploy:**
  - row counts vs. last build (a drop of more than 10% blocks deploy)
  - coordinates inside their county
  - no future dates
  - flags only with evidence
  - no private-person fields (addresses) anywhere in output
- **Per-county freshness and coverage card;** corrections and replies work the same everywhere (`site/records/`).
- **The `#how` page stays the single source of truth for every rule.** Update it with any rule change.

## 7. Phases
| Phase | What ships | Rough effort |
|---|---|---|
| **A. National federal layer** | MSHA + ECHO Exporter + TRI (with parents) + SDWIS + ACS + EJ Score for all 3,143 counties; `#county/<FIPS>` pages; national search | Biggest single step |
| **B. Pan-anywhere map** | PMTiles national tiles; map loads whatever county you're looking at | Medium |
| **C. National families** | Controller and parent pages across states; GLEIF bulk; TRI parents; USAspending/FEC bulk | Medium |
| **D. State adapters** | Appalachia first, then by footprint | Ongoing, one state at a time |
| **E. Readability pass** | Plain-English county summaries, glossary, compare-me, Spanish | Alongside A–D |

**Cost:** $0 on GitHub Actions + Pages (+ Cloudflare R2 free tier if tiles outgrow Pages). The limits to watch are API quotas and Pages' 1 GB site size, and both are handled above.
