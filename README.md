# 📺 Marvel Addon for Stremio (maintained fork)

Watch the entire Marvel catalog in **chronological order**, **release order**, **X-Men**, or explore by **movies**, **series**, and **animations**.

> **Fork note:** this is a maintained fork of [joaogonp/addon-marvel](https://github.com/joaogonp/addon-marvel).
> The original public instance (`https://addon-marvel.gonp.deno.net/`) is **down** — it ran on
> Deno Deploy Classic (`*.deno.net`), which Deno shut down on **July 20, 2026**, so every old install
> link now returns `503`. To use the addon you need to **self-host this fork** (see below) —
> it takes about 10 minutes on any VPS.

---

## ✅ What's fixed in this fork

- **Chronological catalog rebuilt against the official Marvel.com / Disney+ Complete MCU Timeline (June 2026)** — fixes upstream [issue #10](https://github.com/joaogonp/addon-marvel/issues/10) (60 canon entries now in exact official relative order):
  - `Eternals` moved from right after `Endgame` → between `Far From Home` and `No Way Home`
  - `The Fantastic Four: First Steps` moved from 2nd-to-last → right after `Thunderbolts*`, ahead of `Wonder Man`
  - `Cloak & Dagger` moved out of the middle of the Defenders arc (`Luke Cage` → `Iron Fist` → `Defenders` is intact again)
  - `Helstrom` moved out from between `Falcon and the Winter Soldier` and `Far From Home`
  - Non-Disney+-timeline series (`Agents of S.H.I.E.L.D.`, `Inhumans`, `Runaways`, `Cloak & Dagger`, `Helstrom`) grouped in a clearly commented **Legacy** block after the main saga instead of breaking canon adjacency
  - Unreleased/speculative entries (`Punisher: One Last Kill`, `Brand New Day`, `VisionQuest`) kept together at the end with `Avengers: Doomsday` last
- **Title typo fixed:** `The Fantastic: Four First Steps` → `The Fantastic Four: First Steps` (in `chronologicalData.js`, `releaseData.js`, and the `metadataCache.json` display name) — no items added or removed, so the metadata cache still covers all 69 chronological IDs.

## 📚 Catalogs

| Catalog id    | Name                     |
| ------------- | ------------------------ |
| `marvel-mcu`  | MCU Chronologically Order |
| `release-order` | MCU Release Order       |
| `xmen`        | X-Men                    |
| `movies`      | Movies                   |
| `series`      | Series                   |
| `animations`  | Animations               |

## ⚙️ How it works

Catalog-only addon (no streams) built with Express (`main.js`):

- `Data/*.js` — hardcoded title lists (`imdbId`, type, year, poster).
- `Data/metadataCache.json` — metadata pre-built by `scripts/buildMetadata.js`, loaded once at startup, so catalog requests need no live TMDb calls. Missing items fall back to a live TMDb lookup (`TMDB_API_KEY`) or a static fallback.
- `public/configure.html` — Vue setup page: pick catalogs, optionally add a RatingPosterDB key, generates your personal `manifest.json` / `stremio://` install link. Posters are swapped for rated RPDB ones per user key.
- Endpoints: `/manifest.json`, `/rpdb/:key/manifest.json`, `/catalog/:ids/manifest.json`, `/catalog/:type/:id.json` (+ rpdb/custom variants), `/api/catalogs`, `/configure`, `/health`.

## 📦 Installation (Stremio)

1. Host the addon (next section), then open `https://YOUR-DOMAIN/configure`.
2. Select catalogs, paste your [RatingPosterDB](https://ratingposterdb.com) key if you have one (optional), click **Install addon**.
3. Either click **Open in Stremio** or copy the `https://YOUR-DOMAIN/.../manifest.json` link into Stremio via *Addons → Community Addons → paste link*.

> Stremio requires **HTTPS** for remote addons, so serve it behind a domain with TLS (see Caddy step below).

## 🖥️ Self-hosting on a VPS

Requires: a VPS, a domain pointed at it, and a free [TMDB API key](https://www.themoviedb.org/settings/api) (optional but recommended).

```bash
git clone https://github.com/TheNevinPie/addon-marvel.git
cd addon-marvel
curl -fsSL https://deno.land/install.sh | sh   # ~/.deno/bin/deno

export PORT=7000
export TMDB_API_KEY=your_tmdb_key   # optional; addon works without it via the committed cache
~/.deno/bin/deno run --allow-net --allow-env --allow-read main.js

# sanity checks:
curl http://localhost:7000/health
curl http://localhost:7000/manifest.json
```

Run it as a service (`/etc/systemd/system/marvel-addon.service`):

```ini
[Unit]
Description=Marvel Stremio Addon
After=network.target

[Service]
WorkingDirectory=/opt/addon-marvel
ExecStart=/root/.deno/bin/deno run --allow-net --allow-env --allow-read main.js
Environment=PORT=7000
Environment=TMDB_API_KEY=your_tmdb_key
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now marvel-addon
```

HTTPS with Caddy (automatic TLS):

```
marvel.yourdomain.com {
  reverse_proxy 127.0.0.1:7000
}
```

Then open `https://marvel.yourdomain.com/configure` and install in Stremio as above.

## 🧑‍💻 Development

Refresh the metadata cache after editing `Data/*.js` (needs Node 18+ and a TMDB key):

```bash
npm install
echo "TMDB_API_KEY=xxx" > .env
npm run build-metadata            # only new/missing items
npm run build-metadata:refresh    # rebuild everything
```

Commit the regenerated `Data/metadataCache.json` — the server reads it at startup.

## 🙏 Credits

Original project by **joaogonp** ([buymeacoffee.com/joaogonp](https://buymeacoffee.com/joaogonp)).
This fork keeps his work alive and fixes the timeline. Feedback via GitHub issues.

## 📜 License

MIT — see [LICENSE](LICENSE).
