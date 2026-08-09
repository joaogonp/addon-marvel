import express from "npm:express@4";
import path from "node:path";
import fs from "node:fs";
import cors from "npm:cors@2";
import compression from "npm:compression@1";
import axios from "npm:axios@1";
import pLimit from "npm:p-limit@3";
import { LRUCache } from "npm:lru-cache@10";

import chronologicalData from "./Data/chronologicalData.js";
import xmenData from "./Data/xmenData.js";
import moviesData from "./Data/moviesData.js";
import seriesData from "./Data/seriesData.js";
import animationsData from "./Data/animationsData.js";
import releaseData from "./Data/releaseData.js";

const __dirname = import.meta.dirname;

// Metadata pré-construído pelo scripts/buildMetadata.js (corres localmente
// com Node, não no Deno Deploy). Fica em disco, é pequeno, e é lido UMA VEZ
// no arranque — os pedidos normais de catálogo não tocam no TMDb.
const METADATA_CACHE_PATH = path.join(__dirname, "Data", "metadataCache.json");
let metadataCache = {};
try {
    metadataCache = JSON.parse(fs.readFileSync(METADATA_CACHE_PATH, "utf-8"));
    console.log(`Metadata cache carregado: ${Object.keys(metadataCache).length} itens.`);
} catch (err) {
    console.warn("Sem metadataCache.json ainda (corre scripts/buildMetadata.js localmente). A usar fallback ao vivo.");
}

const tmdbKey = Deno.env.get("TMDB_API_KEY") ?? "";
const port = Number(Deno.env.get("PORT") ?? 7000);

const app = express();
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
    res.setHeader("Cache-Control", "public, max-age=1814400"); // 3 semanas
    next();
});

app.get("/health", (req, res) => res.status(200).send("OK"));

app.get("/catalog/:ids/configure", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "configure.html"));
});
app.get("/configure", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "configure.html"));
});

// Cache dos catálogos já montados (não confundir com metadataCache acima:
// aqui é só o resultado final por catálogo, para não repetir o trabalho
// de merge/filter a cada pedido idêntico).
const cachedCatalog = new LRUCache({
    max: 20,
    ttl: 1000 * 60 * 60 * 24 * 30, // 30 dias
    maxSize: 8_000_000, // ~8 MB
    sizeCalculation: (value) => JSON.stringify(value).length,
});

const FALLBACK_META = {
    id: "tt0371746",
    type: "movie",
    name: "Iron Man",
    poster: "https://m.media-amazon.com/images/M/MV5BMTczNTI2ODUwOF5BMl5BanBnXkFtZTcwMTU0NTIzMw@@._V1_SX300.jpg",
    description: "After being held captive in an Afghan cave, billionaire engineer Tony Stark creates a unique weaponized suit of armor to fight evil.",
    releaseInfo: "2008",
    imdbRating: "7.9",
    genres: ["Action", "Adventure", "Sci-Fi"],
};

const DATA_SOURCES = {
    "marvel-mcu": { data: chronologicalData, name: "MCU Chronologically Ordered" },
    "release-order": { data: releaseData, name: "MCU Release Ordered" },
    "xmen": { data: xmenData, name: "X-Men" },
    "movies": { data: moviesData, name: "Movies" },
    "series": { data: seriesData, name: "Series" },
    "animations": { data: animationsData, name: "Animations" },
};

function isValidUrl(str) {
    try {
        new URL(str);
        return str && str !== "N/A" && !str.includes("undefined");
    } catch {
        return false;
    }
}

// Fallback ao vivo — só corre para um item que ainda não esteja no cache
// pré-construído (ex: acabou de ser adicionado a um Data/*.js e ainda
// ninguém correu o buildMetadata.js). Não bloqueia o resto do catálogo.
async function fetchLiveMeta(item) {
    const type = item.type || "movie";
    const lookupId = item.imdbId || item.id;

    if (!tmdbKey) {
        return {
            id: lookupId,
            type,
            name: item.title,
            poster: item.poster || FALLBACK_META.poster,
            description: item.description || "No description available.",
            releaseInfo: item.releaseYear || "N/A",
            imdbRating: "N/A",
            genres: ["Action", "Adventure"],
        };
    }

    try {
        const searchUrl = `https://api.themoviedb.org/3/search/${type}?api_key=${tmdbKey}&query=${encodeURIComponent(item.title)}&year=${item.releaseYear || ""}`;
        const searchRes = await axios.get(searchUrl).catch(() => ({ data: {} }));
        const tmdbId = searchRes.data?.results?.[0]?.id;
        let tmdbData = {};
        if (tmdbId) {
            const detailsRes = await axios.get(`https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${tmdbKey}&language=en-US`).catch(() => ({ data: {} }));
            tmdbData = detailsRes.data || {};
        }
        const poster = (item.poster && isValidUrl(item.poster))
            ? item.poster
            : (tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : FALLBACK_META.poster);

        return {
            id: lookupId,
            type,
            name: item.title,
            poster,
            description: item.description || tmdbData.overview || "No description available.",
            releaseInfo: item.releaseYear || (tmdbData.release_date || tmdbData.first_air_date || "").split("-")[0] || "N/A",
            imdbRating: tmdbData.vote_average ? tmdbData.vote_average.toFixed(1) : "N/A",
            genres: tmdbData.genres?.map((g) => g.name) || ["Action", "Adventure"],
        };
    } catch (err) {
        console.warn(`Fallback ao vivo falhou para ${item.title}: ${err.message}`);
        return { ...FALLBACK_META, id: lookupId, name: item.title };
    }
}

// Cache da validade de cada poster RPDB (por chave+imdbId), 24h. Evita
// repetir o pedido HEAD a cada catálogo pedido pelo mesmo utilizador.
const rpdbValidityCache = new LRUCache({
    max: 20000,
    ttl: 1000 * 60 * 60 * 24,
});

async function isValidRpdbPoster(rpdbKey, imdbId) {
    if (!rpdbKey || !imdbId) return false;

    const cacheKey = `${rpdbKey}:${imdbId}`;
    if (rpdbValidityCache.has(cacheKey)) {
        return rpdbValidityCache.get(cacheKey);
    }

    let isValid = false;
    try {
        const res = await axios.head(`https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${imdbId}.jpg`);
        isValid = res.status === 200;
    } catch {
        isValid = false;
    }

    rpdbValidityCache.set(cacheKey, isValid);
    return isValid;
}

async function replaceRpdbPosters(rpdbKey, metas) {
    if (!rpdbKey) return metas;
    const limit = pLimit(5);
    return Promise.all(metas.map((meta) => limit(async () => {
        const imdbId = meta.id.startsWith("tt") ? meta.id : null;
        if (imdbId && await isValidRpdbPoster(rpdbKey, imdbId)) {
            return { ...meta, poster: `https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${imdbId}.jpg` };
        }
        return meta;
    })));
}

// Constrói os metas de um catálogo: quase sempre 100% a partir do cache
// pré-construído (sem I/O de rede nenhum). Só faz fetch ao vivo para os
// itens que faltarem no cache.
async function buildMetas(catalogId) {
    const source = DATA_SOURCES[catalogId];
    if (!source) return null;

    const limit = pLimit(5);
    const metas = await Promise.all(source.data.map((item) => limit(async () => {
        const lookupId = item.imdbId || item.id;
        const cached = metadataCache[lookupId];
        if (cached) return cached;
        return fetchLiveMeta(item);
    })));

    return metas.filter(Boolean);
}

async function handleCatalogRequest(req, res, { cacheKeyPrefix }) {
    const { id } = req.params;
    let rpdbKey = req.query.rpdb || null;

    if (req.params.rpdbKey) rpdbKey = req.params.rpdbKey;
    if (req.params.catalogsParam?.includes(":") && !req.params.catalogsParam.endsWith(":")) {
        rpdbKey = req.params.catalogsParam.split(":")[1] || rpdbKey;
    }

    const cacheKey = `${cacheKeyPrefix}-${id}`;

    try {
        let metas;
        if (cachedCatalog.has(cacheKey)) {
            metas = cachedCatalog.get(cacheKey).metas;
        } else {
            metas = await buildMetas(id);
            if (!metas || !metas.length) {
                return res.json({ metas: [FALLBACK_META] });
            }
            cachedCatalog.set(cacheKey, { metas });
        }

        const finalMetas = rpdbKey ? await replaceRpdbPosters(rpdbKey, metas) : metas;
        return res.json({ metas: finalMetas });
    } catch (err) {
        console.error(`Erro no catálogo ${id}: ${err.message}`);
        return res.json({ metas: [FALLBACK_META] });
    }
}

function getAllCatalogs() {
    return [
        { type: "Marvel", id: "marvel-mcu", name: "MCU Chronologically Order" },
        { type: "Marvel", id: "release-order", name: "MCU Release Order" },
        { type: "Marvel", id: "xmen", name: "X-Men" },
        { type: "Marvel", id: "movies", name: "Movies" },
        { type: "Marvel", id: "series", name: "Series" },
        { type: "Marvel", id: "animations", name: "Animations" },
    ];
}

function buildManifest({ id, description, catalogs }) {
    return {
        id,
        name: "Marvel",
        description,
        version: "2.0.0",
        logo: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/public/assets/icon.png",
        background: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/assets/background.jpg",
        catalogs,
        resources: ["catalog"],
        types: ["movie", "series"],
        idPrefixes: ["marvel_", "tt"],
        behaviorHints: { configurable: true },
        contactEmail: "jpnapsp@gmail.com",
    };
}

app.get("/manifest.json", (req, res) => {
    const rpdbKey = req.query.rpdb || null;
    const id = rpdbKey ? "com.joaogonp.marveladdon.rpdb" : "com.joaogonp.marveladdon";
    res.json(buildManifest({
        id,
        description: "Watch the entire Marvel catalog! MCU and X-Men (chronologically organized), Movies, Series, and Animations!",
        catalogs: getAllCatalogs(),
    }));
});

app.get("/rpdb/:rpdbKey/manifest.json", (req, res) => {
    const { rpdbKey } = req.params;
    res.json(buildManifest({
        id: `com.joaogonp.marveladdon.rpdb.${rpdbKey.slice(0, 8)}`,
        description: "Watch the entire Marvel catalog with IMDb ratings on posters!",
        catalogs: getAllCatalogs(),
    }));
});

app.get("/catalog/:catalogsParam/manifest.json", (req, res) => {
    const { catalogsParam } = req.params;
    let selectedCatalogIds = catalogsParam;
    let rpdbKey = null;

    if (catalogsParam.includes(":") && !catalogsParam.endsWith(":")) {
        const [idsPart, key] = catalogsParam.split(":");
        selectedCatalogIds = idsPart;
        rpdbKey = key;
    }
    selectedCatalogIds = selectedCatalogIds.split(",").map((s) => s.trim());

    const selected = getAllCatalogs().filter((c) => selectedCatalogIds.includes(c.id));
    if (!selected.length) return res.status(404).send("No valid catalogs selected.");

    const customId = (rpdbKey
        ? `com.joaogonp.marveladdon.custom.${selectedCatalogIds.join(".")}.rpdb`
        : `com.joaogonp.marveladdon.custom.${selectedCatalogIds.join(".")}`
    ).slice(0, 100);

    res.json(buildManifest({
        id: customId,
        description: `Your custom Marvel catalog: ${selected.map((c) => c.name).join(", ")}`,
        catalogs: selected,
    }));
});

app.get("/api/catalogs", (req, res) => {
    res.json(getAllCatalogs().map((c) => ({ ...c })));
});

// Três formas de pedir o mesmo catálogo, servidas por um único handler
app.get("/catalog/:type/:id.json", (req, res) => handleCatalogRequest(req, res, { cacheKeyPrefix: "default" }));
app.get("/rpdb/:rpdbKey/catalog/:type/:id.json", (req, res) => handleCatalogRequest(req, res, { cacheKeyPrefix: "rpdb" }));
app.get("/catalog/:catalogsParam/catalog/:type/:id.json", (req, res) => handleCatalogRequest(req, res, { cacheKeyPrefix: "custom" }));

app.get("/", (req, res) => res.redirect("/configure"));

app.listen(port, () => {
    console.log(`Marvel Addon a correr na porta ${port}`);
});
