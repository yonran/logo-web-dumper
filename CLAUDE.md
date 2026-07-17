# Project instructions — logo-web-dumper

## State reversibility (hard requirement)

Operations and their undos must work and be **reversible even after a serial reconnect or a
browser page refresh** — not just within one in-memory session. This tool writes to a physical
PLC, so a refresh or a dropped cable after a state-changing write can leave the device altered
with no record in the UI.

- As much as possible, **reload state by reading it back from the device** on connect / "Put in
  STOP" (e.g. read `0x00FF48FF`), and enable the undo (Re-lock) based on device state, not on a
  this-session-only flag.
- Where the device **cannot** report the relevant state, **make it very clear to the operator
  and the user** in the log/UI. Known limitation: `0x00FF48FF` reports only that a password
  *exists* (`0x40`), not the current protection *level* — so after a level-1 write the tool
  cannot tell whether the device is currently unprotected. Say so and prompt for Re-lock.
- Any new state-changing button must set the state flags so `applyState()` re-enables its undo,
  and must not rely on an in-memory-only warning that a refresh would erase.

## After every push: wait for the build

Every time you push, **wait for the GitHub Pages build to finish before reporting done**, and
confirm the new commit actually deployed.

- This repo's Pages builds via **GitHub Actions** (`build_type: workflow`,
  `.github/workflows/pages.yml`), so watch the run:
  `gh run watch "$(gh run list --workflow=pages.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status`.
  The workflow runs `npm ci --ignore-scripts → lint → build (tsc) → deploy`, so a lint or type
  error fails the deploy — run `npm run lint && npm run build` locally before pushing.
- Verify deployment, don't just trust a green run: fetch the live site
  (`https://yonran.github.io/logo-web-dumper/`) and grep for a string unique to the new commit;
  `dist/` is built in CI and not committed, so also confirm e.g. `dist/main.js` returns 200.
- If a run is stuck/failing for no code reason, check `https://www.githubstatus.com/api/v2/summary.json`
  for a GitHub incident before assuming the commit is at fault.
