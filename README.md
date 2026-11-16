# The People's Case

See what's around you: facilities, violations, water systems, and who owns them. Built from public records, with a source and date on every fact.

- `site/`: the website. It's static and works on GitHub Pages, and installs on phones as a web app.
- `collector/`: pulls public records on a schedule and archives every raw copy with a hash.
- `mockups/`: the approved screen designs. They use sample data.
- `docs/`: the spec and data sources.

**Status:** early test. The first real-data run rebuilds who operated and who controlled every coal mine in Harlan County, KY, from MSHA's public records. See `CLAUDE.md` before changing anything.

- **What it shows now:** Harlan County coal mines with operator + controller history and every MSHA safety citation, rolled up per mine and per controller (Curtain Puller v1), plus EPA facilities. Dark Curtain Puller design.
- **How it runs:** `.github/workflows/build.yml` runs the collector daily (and on every push), uploads raw snapshots to a monthly `archive-YYYY-MM` release with SHA-256 hashes, and deploys `site/` to GitHub Pages. Data is never committed to git.
- **Design mockups:** the Curtain Puller screens live in a Claude Design canvas (sample data only).

Public records only. This is not legal advice.
