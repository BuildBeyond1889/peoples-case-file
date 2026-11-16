# The People's Case: handoff for Claude (read this first)

This repo holds **only** The People's Case (formerly "People's Case File"; the repo and URL keep the old slug): Lu's accountability website. The patents, forgotten-science and software-goldmine ideas are in a different handoff ("Lu - Big Ideas Handoff for Claude"). Don't mix them.

## Who you're working with
- **Lu** builds solo with no budget. He publishes under the GitHub handle **BuildBeyond1889**.
  - **Never put his real name on anything public.**
  - His email is private; never share it.
- **What he likes:**
  - plain-English explanations and honest limits
  - practical versions he can actually run
  - mockups before big builds
- **Style:** he's direct and swears casually. Match his energy, not his language. He cares about speed and results, not usage cost.
- **Previous project:** Sky Watch (an AR sky web app), live at https://buildbeyond1889.github.io/skywatch/. It's a static PWA on GitHub Pages, and this project should deploy the same way.

## What it is (one line)
Law-firm-grade case research, free, for anyone trying to figure out what's going on where they live, and who's behind it.

**Users:**
- a Flint resident
- a Harlan County, KY resident (coal)
- an associate lawyer at an environmental firm

It needs two depths: **Simple** for residents and **Pro** for lawyers and journalists.

## Lu's decisions so far (Nov 13 2026)
- **Format:**
  - **The website is the main product.** The phone version is the same site installed as a web app (PWA).
  - **The map is the front door:** a live, self-updating map, "like Google Maps", that loads what's around you or anywhere you pan.
- **Top priority:** the **info being right**, and gathering **as much new AND old material as possible** for the best analysis.
- **Headline feature, the corporate tree ("definitely"):**
  - **(a) case tree:** the companies tied to whatever is being worked on
  - **(b) world tree:** every company on the planet with public records
- **Selected (★ in docs/SPEC.md):**
  - all of "Better analysis"
  - all of "Turn info into action" ("for fucking sure")
  - "Trust, safety, fairness"
  - "Keeping it alive"
- **Not selected yet (kept):** "Gather more", "Easy for anyone", "Wow features".
- **Status (Nov 16 2026):** live and building. The concept stage is over.
  - **Live site:** https://buildbeyond1889.github.io/peoples-case-file/
  - **Name:** "The People's Case" (renamed Nov 16 from "People's Case File"), with "Curtain Puller" as the tagline. Dark design.
  - **Installable app:** a PC monogram icon in Instrument Serif (the wordmark font) with a coral rule, an "Install app" button, and a full manifest.
  - Lu reviews it on desktop Chrome and phone.

## Guardrails (non-negotiable)
1. **Public, lawfully obtained records only.** No leaked or hacked material, no scraping behind logins.
2. **Companies, and officials in their public roles only.**
   - Never profile private individuals: no home addresses, no private life.
   - Company officers appear only as named in official filings, in their corporate role.
3. **Every claim carries** a source link, the date published, the date pulled, an archived copy and a confidence level.
   - Say "linked to", never "did this".
   - When sources conflict, show both.
4. **AI only summarizes or searches stored records.** Each sentence links to its record. It never adds facts.
5. **Health data is estimates, not diagnoses.** Show that things happen in the same place, never that one caused the other.
6. **For residents:** "Not legal advice", plus a button to talk to legal aid or a lawyer.
7. **Right of reply** for companies and agencies, a public corrections log, and credit for clean records too.
8. **Never present our "Open EJ Score" as EPA's EJScreen.**

## What's built (as of Nov 16 2026)
**Pilot 1, Harlan County, KY (coal):**
- **Mines and who controls them:** every MSHA mine, with operator and controller history.
  - Every MSHA citation is credited to the operator and controller **at the time it was issued**.
  - So a family's total covers only the years that controller held the mine, while a mine's total covers all owners.
- **Controller family pages** (`#family/<id>`):
  - graph, timeline, KPIs
  - "who's above them": GLEIF parents and KY Secretary of State officers as filed
  - money (USAspending, FEC, Senate LDA lobbying, KY KLEC lobbying)
  - court cases (CourtListener)
  - liability / silence / money-timing / credit cards
- **EPA links:** facilities linked to mines by **inferred** site matches (location plus coal code or shared name).
  - These are always labelled "inferred", never shown as an MSHA record.
- **KY mine permit areas** (DMP).

**Pilot 2, Flint / Genesee County, MI:** EPA ECHO facilities, TRI reporters with pounds released, SDWIS drinking-water systems per county.

**Site-wide:**
- **Silence detector** on EPA sites: serious noncompliance with no formal enforcement, repeated violations with no penalties, warning letters only, effluent exceedances, zombie permits.
- **Public-comment alerts:** pending KY and MI permit actions, comment-stage badges, draft-a-comment letters.
- **Records requests:** draft letters plus a tracker (`#requests`) with deadlines, an overdue badge, and follow-up and appeal drafts. Stored in the browser only.
- **Open EJ Score:** a block-group map layer from Census ACS plus our indicators, with adjustable weights. It's our open formula, never EPA's.
- **World tree** (`#tree`): search any LEI company worldwide live from GLEIF (CORS works), with parents and children.
- **Evidence packs:** a zip of what's shown, plus the records and archived originals with SHA-256.

## How it runs
- **`.github/workflows/build.yml`** runs daily at 09:17 UTC, and on every push.
  - **Push that changes `collector/` or `.github/`:** full collect (~13 min).
  - **Any other push:** `collector/reuse_live.py` copies the live data files, so the deploy is fast.
  - **After either:** it uploads raw snapshots to a monthly `archive-YYYY-MM` release (SHA-256 manifests) and deploys `site/` to Pages.
  - **Data is never committed to git.**
- **Secrets (optional):** `FEC_API_KEY`, `COURTLISTENER_TOKEN`, `LDA_API_KEY`.
- **`.github/workflows/probe.yml` + `collector/probe.py`:** a diagnostic script for trying a new source's endpoints before wiring it into `collect.py`. It gets rewritten for each probe.
- **SEC blocks GitHub's servers:** `collector/sec_local.py` runs on Lu's computer and writes `manual/sec.json` (Exhibit 21 subsidiaries, Exhibit 95 mine IDs). Lu uploads it, and builds copy `manual/` into `site/data/`.
- **Release habit:** bump the `CACHE` name in `site/sw.js` and the `?v=N` on the CSS/JS tags in `index.html` and `sw.js` every site change.

## Files
| Path | What |
|---|---|
| `site/` | The website: `index.html`, `app.js` (all UI), `style.css`, `sw.js`, data loaded from `site/data/*.json/geojson` at runtime |
| `collector/collect.py` | Everything that pulls, archives and builds data |
| `docs/SPEC.md`, `docs/DATA-SOURCES.md` | Full spec with Lu's ★ selections; source registry |
| `mockups/` | Original approved screens (sample data). The Curtain Puller redesign lives in a Claude Design canvas |
| `manual/` | Hand-run results (e.g. `sec.json`) |

## Known gaps / next
- **Not collected yet:**
  - reclamation-bond records
  - state campaign finance (KREF, MI CFR)
  - business registries outside KY
  - satellite layers
  - neighbor reports
  - ask-anything with citations
- **Corrections and right of reply:** the public corrections log and right-of-reply flow aren't built yet (guardrail 7).
- **Individuals as MSHA controllers:** some controllers are people.
  - Their family pages show the name **only as listed in MSHA records**, labelled "individual, as named in MSHA records", with no address or personal details.
  - Their pages and map cards **lead with the operating company**; the person appears only as "Listed controller in MSHA records … (individual)". Keep it that way.

## Pilot towns
Flint, MI (Genesee County) and Harlan County, KY. Work with local partners: libraries, churches, a law-school environmental clinic.
