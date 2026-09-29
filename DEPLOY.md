# Deployment handoff — Marvel Stremio Addon (for the VPS agent)

> You are the agent that knows this VPS (process manager, reverse proxy, TLS, firewall,
> filesystem layout). This file tells you **what** to deploy. Use **your** VPS conventions
> for everything not specified here (service files, proxy vhosts, certs, ports, paths).

## 1. What this is

- Stremio **catalog-only** addon (no streams, no DB, no build step, fully stateless;
  only in-memory LRU caches that rebuild on restart).
- Source: `https://github.com/TheNevinPie/addon-marvel`
- **Deploy branch `fix/chronological-order`** (the fixes are not on `main` yet).
  Either deploy that branch as-is, or merge it to `main` first and deploy `main`.
- Runtime: **Deno 2.x**, single entrypoint, started from the repo root:
  `deno run --allow-net --allow-env --allow-read main.js`
  (matches the repo's `deno task start` in `deno.json`).
- Commit currently tested: `fa3a778` (README rewrite; code fix commit `0eae3c8`).

## 2. Configuration (all of it)

| Env var       | Required | Default | Notes                                                        |
| ------------- | -------- | ------- | ------------------------------------------------------------ |
| `PORT`        | no       | `7000`  | TCP port the app listens on.                                 |
| `TMDB_API_KEY`| no       | empty   | Only used as live fallback for titles missing from the cache. App works without it (cache covers all 69 chronological IDs). Set it if available; never bake it into images or the repo. |

No config files, no volumes, no database. Nothing else to set.

## 3. Deploy steps (adapt paths/ports to this VPS)

1. `git clone -b fix/chronological-order https://github.com/TheNevinPie/addon-marvel.git <APP_DIR>`
   (or pull that branch in the existing checkout).
2. Install / pin Deno 2.x if not present (`deno --version`).
3. Start via your standard process manager (systemd unit, docker, pm2 — your call):
   working dir `<APP_DIR>`, command `deno run --allow-net --allow-env --allow-read main.js`,
   env `PORT=<PORT>` (+ `TMDB_API_KEY` if available), restart-always.
4. Reverse-proxy a public HTTPS vhost `<DOMAIN>` → `127.0.0.1:<PORT>`.
   **Proxy requirements (functional, not cosmetic):**
   - Forward **all paths** (`/`, `/manifest.json`, `/configure`, `/api/*`, `/catalog/*`, `/rpdb/*`, `/health`, static assets).
   - **Preserve the original `Host` header and protocol.** The configure page builds per-user
     install links from `window.location.host/protocol`; forwarding with a rewritten host
     produces broken `stremio://` links.
   - `GET /` redirects to `/configure` — pass redirects through untouched.
5. Open firewall / security groups per your standard (app itself only needs localhost + outbound HTTPS to TMDb/RPDB/image CDNs).

## 4. Verify (do all of these before calling it done)

- Process log contains `Metadata cache carregado: 233 itens.` and `Marvel Addon a correr na porta <PORT>`.
- `GET http://127.0.0.1:<PORT>/health` → `200 OK`.
- `GET https://<DOMAIN>/manifest.json` → JSON with `"name": "Marvel"` and 6 catalogs
  (`marvel-mcu`, `release-order`, `xmen`, `movies`, `series`, `animations`).
- `GET https://<DOMAIN>/configure` → `200`, HTML setup page.
- `GET https://<DOMAIN>/catalog/Marvel/marvel-mcu.json` → `{"metas": [...]}` with **69** entries,
  first `Captain America: The First Avenger`, entry 37 `Eternals`, entry 59
  `The Fantastic Four: First Steps`, last `Avengers: Doomsday`.
- In Stremio (or via pasted link): `https://<DOMAIN>/manifest.json` installs cleanly.
  Stremio requires public **HTTPS** — plain-HTTP IP URLs will not install.

## 5. Operate

- Resource footprint is tiny (single process, ~8 MB catalog cache); any small instance works.
- Update: `git pull` the deployed branch + restart the process. No migrations, no rebuild.
- Rollback: redeploy the previous commit + restart.
- Metadata refresh (only when `Data/*.js` title lists change upstream): needs Node 18+ and a TMDB key —
  `npm install && npm run build-metadata`, commit the regenerated `Data/metadataCache.json`, redeploy.
  Not needed for a routine deploy.
- Logs worth watching: `Fallback ao vivo falhou para ...` (TMDb unreachable — harmless, serves fallback meta)
  and `Erro no catálogo ...` (serves single-item fallback — investigate if persistent).
