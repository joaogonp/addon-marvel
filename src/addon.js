const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const axios = require('axios');
const pLimit = require('p-limit');
const LRU = require('lru-cache');
const chronologicalData = require('../Data/chronologicalData');
const xmenData = require('../Data/xmenData');
const moviesData = require('../Data/moviesData');
const seriesData = require('../Data/seriesData');
const animationsData = require('../Data/animationsData');

require('dotenv').config();

// Get API key and port
let tmdbKey, port;
try {
    ({ tmdbKey, port } = require('./config'));
} catch (error) {
    console.error('Error loading config.js. Falling back to environment variables.', error);
    port = process.env.PORT || 7000;
    tmdbKey = process.env.TMDB_API_KEY;
    
    if (!tmdbKey) {
        console.error('CRITICAL: TMDB_API_KEY is missing. Addon cannot fetch metadata.');
    }
}

const app = express();

// Middleware
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Cache for 3 weeks (client-side)
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=1814400');
    next();
});

// Health check for Render
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Serve configure.html for paths like /catalog/id1,id2/configure
app.get('/catalog/:ids/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Configuration page
app.get('/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Cache storage with LRU for 2 months
const cacheOptions = {
    max: 10, // Store up to 10 catalogs
    ttl: 1000 * 60 * 60 * 24 * 60, // 2 months TTL (5,184,000,000 ms)
    maxSize: 10000000, // ~10 MB max size
    sizeCalculation: (value) => JSON.stringify(value).length
};
const cachedCatalog = new LRU(cacheOptions);

// Monitor memory usage every minute
setInterval(() => {
    const used = process.memoryUsage();
    console.log(`Memory usage: RSS=${(used.rss / 1024 / 1024).toFixed(2)} MB, HeapTotal=${(used.heapTotal / 1024 / 1024).toFixed(2)} MB, HeapUsed=${(used.heapUsed / 1024 / 1024).toFixed(2)} MB`);
}, 1000 * 60);

// Helper function to fetch TMDb details
async function getTmdbDetails(id, type) {
    console.log(`Fetching TMDb details for ${type}/${id}`);
    const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${tmdbKey}&language=en-US&append_to_response=external_ids`;
    try {
        const res = await axios.get(url);
        return res;
    } catch (err) {
        console.error(`Error fetching TMDb details for ${type}/${id}: ${err.message}`);
        return {};
    }
}

// Helper function to check if RPDB poster is valid
async function isValidRpdbPoster(rpdbKey, imdbId) {
    if (!rpdbKey || !imdbId) {
        console.warn(`Invalid RPDB inputs: rpdbKey=${rpdbKey}, imdbId=${imdbId}`);
        return false;
    }
    const url = `https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${imdbId}.jpg`;
    try {
        const response = await axios.head(url);
        const isValid = response.status === 200;
        console.log(`RPDB poster check for ${imdbId}: ${isValid ? 'Valid' : 'Invalid'}`);
        return isValid;
    } catch (err) {
        console.warn(`RPDB poster unavailable for IMDb ID ${imdbId}: ${err.message}`);
        return false;
    }
}

// Helper function to validate URL
function isValidUrl(string) {
    try {
        new URL(string);
        return string && string !== 'N/A' && !string.includes('undefined');
    } catch (err) {
        return false;
    }
}

// Helper function to replace posters with RPDB posters when valid
async function replaceRpdbPosters(rpdbKey, metas) {
    if (!rpdbKey) {
        console.log('No RPDB key provided, keeping original posters');
        return metas;
    }

    console.log(`Replacing posters with RPDB for ${metas.length} items`);
    const limit = pLimit(5); // Limit to 5 concurrent RPDB checks
    const updatedMetas = await Promise.all(metas.map(async meta => {
        return limit(async () => {
            const imdbId = meta.id.startsWith('tt') ? meta.id : null;
            if (imdbId && await isValidRpdbPoster(rpdbKey, imdbId)) {
                const rpdbPoster = `https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${imdbId}.jpg`;
                console.log(`Using RPDB poster for ${meta.name} (${imdbId}): ${rpdbPoster}`);
                return { ...meta, poster: rpdbPoster };
            }
            console.log(`Keeping original poster for ${meta.name} (${meta.id}): ${meta.poster}`);
            return meta;
        });
    }));

    return updatedMetas;
}

// Function to fetch additional metadata
async function fetchAdditionalData(item) {
    console.log(`\n--- Fetching details for item: ${item.title || 'Unknown'} (ID: ${item.imdbId || item.id || 'N/A'}) ---`);

    // Minimal validation: only require title
    if (!item || !item.title) {
        console.warn('Skipping item due to missing title:', JSON.stringify(item));
        return null;
    }

    // Set defaults
    const type = item.type || 'movie';
    const lookupId = item.imdbId || item.id || `temp_${item.title.replace(/\s+/g, '_')}`;
    const isImdb = lookupId.startsWith('tt');

    // Log item details
    console.log(`Item details: title=${item.title}, type=${type}, id=${lookupId}, releaseYear=${item.releaseYear || 'N/A'}`);

    // Fallback metadata
    const fallbackMeta = {
        id: lookupId,
        type: type,
        name: type === 'series' ? item.title.replace(/ Season \d+/, '') : item.title,
        poster: item.poster || 'https://m.media-amazon.com/images/M/MV5BMTc5MDE2ODcwNV5BMl5BanBnXkFtZTgwMzI2NzQ2NzM@._V1_SX300.jpg',
        description: item.overview || 'No description available.',
        releaseInfo: item.releaseYear || 'N/A',
        imdbRating: 'N/A',
        genres: item.genres ? item.genres.map(g => g.name) : ['Action', 'Adventure']
    };

    // Check if TMDb API key is available
    if (!tmdbKey) {
        console.warn(`Skipping metadata fetch for ${item.title} (${lookupId}) due to missing TMDb API key.`);
        console.log('   > Returning fallback metadata:', { ...fallbackMeta, description: fallbackMeta.description.substring(0, 50) + '...' });
        return fallbackMeta;
    }

    let tmdbData = {};
    let tmdbImagesData = {};

    try {
        // TMDb search/details call
        let effectiveTmdbId = item.tmdbId || (lookupId.startsWith('tmdb_') ? lookupId.split('_')[1] : null);
        let tmdbDetailsPromise;
        if (effectiveTmdbId) {
            const tmdbDetailsUrl = `https://api.themoviedb.org/3/${type}/${effectiveTmdbId}?api_key=${tmdbKey}&language=en-US`;
            tmdbDetailsPromise = axios.get(tmdbDetailsUrl).catch((err) => {
                console.error(`TMDb details error for ${type}/${effectiveTmdbId}: ${err.message}`);
                return {};
            });
        } else {
            const tmdbSearchUrl = `https://api.themoviedb.org/3/search/${type}?api_key=${tmdbKey}&query=${encodeURIComponent(item.title)}&year=${item.releaseYear || ''}`;
            tmdbDetailsPromise = axios.get(tmdbSearchUrl).then(res =>
                res.data?.results?.[0] ? getTmdbDetails(res.data.results[0].id, type) : {}
            ).catch((err) => {
                console.error(`TMDb search error for ${item.title}: ${err.message}`);
                return {};
            });
        }

        // Fetch images using TMDb ID
        const tmdbImagesPromise = tmdbDetailsPromise.then(detailsRes => {
            const foundTmdbId = detailsRes?.data?.id || effectiveTmdbId;
            if (foundTmdbId) {
                const tmdbImagesUrl = `https://api.themoviedb.org/3/${type}/${foundTmdbId}/images?api_key=${tmdbKey}`;
                return axios.get(tmdbImagesUrl).catch((err) => {
                    if (!err.response || err.response.status !== 404) {
                        console.warn(`TMDb images error for ${item.title}: ${err.message}`);
                    }
                    return {};
                });
            } else {
                return Promise.resolve({});
            }
        });

        console.log(`Fetching data for ${item.title} (${lookupId})...`);
        const [tmdbDetailsResult, tmdbImagesRes] = await Promise.all([
            tmdbDetailsPromise,
            tmdbImagesPromise
        ]);

        tmdbData = tmdbDetailsResult.data || {};
        tmdbImagesData = tmdbImagesRes.data || {};

        // Poster priority: local -> TMDb -> fallback
        let poster = null;
        if (item.poster && isValidUrl(item.poster)) {
            poster = item.poster;
            console.log(`Using local poster for ${item.title}: ${poster}`);
        } else if (tmdbData.poster_path && isValidUrl(`https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`)) {
            poster = `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`;
            console.log(`Using TMDb poster for ${item.title}: ${poster}`);
        } else {
            poster = 'https://m.media-amazon.com/images/M/MV5BMTc5MDE2ODcwNV5BMl5BanBnXkFtZTgwMzI2NzQ2NzM@._V1_SX300.jpg';
            console.warn(`No valid poster found for ${item.title} (${lookupId}), using fallback: ${poster}`);
        }

        let logoUrl = null;
        if (tmdbImagesData.logos && tmdbImagesData.logos.length > 0) {
            let bestLogo = tmdbImagesData.logos.find(logo => logo.iso_639_1 === 'en') || tmdbImagesData.logos[0];
            if (bestLogo && bestLogo.file_path && isValidUrl(`https://image.tmdb.org/t/p/original${bestLogo.file_path}`)) {
                logoUrl = `https://image.tmdb.org/t/p/original${bestLogo.file_path}`;
                console.log(`Using logo for ${item.title}: ${logoUrl}`);
            }
        }

        const description = item.overview || tmdbData.overview || 'No description available.';

        const meta = {
            id: lookupId,
            type: type,
            name: type === 'series' ? item.title.replace(/ Season \d+/, '') : item.title,
            logo: logoUrl,
            poster: poster,
            description: description,
            releaseInfo: item.releaseYear || (tmdbData.release_date ? tmdbData.release_date.split('-')[0] : (tmdbData.first_air_date ? tmdbData.first_air_date.split('-')[0] : 'N/A')),
            imdbRating: tmdbData.vote_average ? tmdbData.vote_average.toFixed(1) : 'N/A',
            genres: tmdbData.genres ? tmdbData.genres.map(g => g.name) : (item.genres ? item.genres.map(g => g.name) : ['Action', 'Adventure'])
        };

        console.log('   > Returning metadata:', { ...meta, description: meta.description.substring(0, 50) + '...' });
        return meta;
    } catch (err) {
        console.error(`Error processing ${item.title} (${lookupId}): ${err.message}`);
        console.log('   > Returning fallback metadata:', { ...fallbackMeta, description: fallbackMeta.description.substring(0, 50) + '...' });
        return fallbackMeta;
    }
}

// Fallback meta for testing
const fallbackMeta = {
    id: 'tt0371746',
    type: 'movie',
    name: 'Iron Man',
    poster: 'https://m.media-amazon.com/images/M/MV5BMTczNTI2ODUwOF5BMl5BanBnXkFtZTcwMTU0NTIzMw@@._V1_SX300.jpg',
    description: 'After being held captive in an Afghan cave, billionaire engineer Tony Stark creates a unique weaponized suit of armor to fight evil.',
    releaseInfo: '2008',
    imdbRating: '7.9',
    genres: ['Action', 'Adventure', 'Sci-Fi']
};

// List of all available catalogs
function getAllCatalogs() {
    return [
        {
            type: "Marvel",
            id: "marvel-mcu",
            name: "MCU",
        },
        {
            type: "Marvel",
            id: "xmen",
            name: "X-Men",
        },
        {
            type: "Marvel",
            id: "movies",
            name: "Movies",
        },
        {
            type: "Marvel",
            id: "series",
            name: "Series",
        },
        {
            type: "Marvel",
            id: "animations",
            name: "Animations",
        }
    ];
}

// Default manifest
app.get('/manifest.json', (req, res) => {
    console.log('Default manifest requested');
    
    const rpdbKey = req.query.rpdb || null;
    if (rpdbKey) {
        console.log(`Default manifest with RPDB key: ${rpdbKey.substring(0, 4)}...`);
    }
    
    const manifestId = rpdbKey 
        ? "com.joaogonp.marveladdon.rpdb"
        : "com.joaogonp.marveladdon";
    
    const manifest = {
        id: manifestId,
        name: "Marvel",
        description: "Watch the entire Marvel catalog! MCU and X-Men (chronologically organized), Movies, Series, and Animations!",
        version: "1.1.0",
        logo: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/assets/icon.png",
        background: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/assets/background.jpg",
        catalogs: getAllCatalogs(),
        resources: ["catalog"],
        types: ["movie", "series"],
        idPrefixes: ["marvel_"],
        behaviorHints: {
            configurable: false
        },
        contactEmail: "jpnapsp@gmail.com",
        stremioAddonsConfig: {
            issuer: "https://stremio-addons.net",
            signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..zTaTTCcviqQPiIvU4QDfCQ.wSlk8AoM4p2nvlvoQJEoLRRx5_Msnu37O9bAsgwhJTZYu4uXd7Cve9GaVXdnwZ4nAeNSsRSgp51mofhf0EVQYwx7jGxh4FEvs8MMuWeHQ9alNsqVuy3-Mc459B9myIT-.R_1iaQbNExj4loQJlyWYtA"
        }
    };
    
    res.json(manifest);
});

// RPDB-based manifest
app.get('/rpdb/:rpdbKey/manifest.json', (req, res) => {
    const { rpdbKey } = req.params;
    console.log(`RPDB-based manifest requested with key: ${rpdbKey.substring(0, 4)}...`);
    
    const manifestId = `com.joaogonp.marveladdon.rpdb.${rpdbKey.substring(0, 8)}`;
    
    const manifest = {
        id: manifestId,
        name: "Marvel",
        description: "Watch the entire Marvel catalog with IMDb ratings on posters! MCU and X-Men (chronologically organized), Movies, Series, and Animations!",
        version: "1.2.0",
        logo: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/assets/icon.png",
        background: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/assets/background.jpg",
        catalogs: getAllCatalogs(),
        resources: ["catalog"],
        types: ["movie", "series"],
        idPrefixes: ["marvel_"],
        behaviorHints: {
            configurable: false
        },
        contactEmail: "jpnapsp@gmail.com",
        stremioAddonsConfig: {
            issuer: "https://stremio-addons.net",
            signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..zTaTTCcviqQPiIvU4QDfCQ.wSlk8AoM4p2nvlvoQJEoLRRx5_Msnu37O9bAsgwhJTZYu4uXd7Cve9GaVXdnwZ4nAeNSsRSgp51mofhf0EVQYwx7jGxh4FEvs8MMuWeHQ9alNsqVuy3-Mc459B9myIT-.R_1iaQbNExj4loQJlyWYtA"
        }
    };
    
    res.json(manifest);
});

// Custom catalog manifest
app.get('/catalog/:catalogsParam/manifest.json', (req, res) => {
    const { catalogsParam } = req.params;
    
    let rpdbKey = null;
    let selectedCatalogIds = catalogsParam;
    
    if (catalogsParam.includes(':') && !catalogsParam.endsWith(':')) {
        const parts = catalogsParam.split(':');
        selectedCatalogIds = parts[0];
        rpdbKey = parts[1];
        console.log(`Custom manifest with RPDB key: ${rpdbKey.substring(0, 4)}...`);
        selectedCatalogIds = selectedCatalogIds.split(',').map(id => id.trim());
    } else {
        selectedCatalogIds = catalogsParam.split(',').map(id => id.trim());
    }

    const allCatalogs = getAllCatalogs();
    const selectedApiCatalogs = allCatalogs.filter(catalog => selectedCatalogIds.includes(catalog.id));
    
    if (selectedApiCatalogs.length === 0) {
        console.error('No valid catalogs selected or found:', selectedCatalogIds);
        return res.status(404).send('No valid catalogs selected or found.');
    }
    
    const customId = rpdbKey 
        ? `com.joaogonp.marveladdon.custom.${selectedCatalogIds.join('.')}.rpdb`
        : `com.joaogonp.marveladdon.custom.${selectedCatalogIds.join('.')}`;
    
    const manifestId = customId.slice(0, 100);
    
    const manifest = {
        id: manifestId,
        name: "Marvel",
        description: `Your custom Marvel catalog: ${selectedApiCatalogs.map(c => c.name).join(', ')}`,
        version: "1.2.0",
        logo: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/assets/icon.png",
        background: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/assets/background.jpg",
        catalogs: selectedApiCatalogs,
        resources: ["catalog"],
        types: ["movie", "series"],
        idPrefixes: ["marvel_"],
        behaviorHints: {
            configurable: false
        },
        contactEmail: "jpnapsp@gmail.com",
        stremioAddonsConfig: {
            issuer: "https://stremio-addons.net",
            signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..zTaTTCcviqQPiIvU4QDfCQ.wSlk8AoM4p2nvlvoQJEoLRRx5_Msnu37O9bAsgwhJTZYu4uXd7Cve9GaVXdnwZ4nAeNSsRSgp51mofhf0EVQYwx7jGxh4FEvs8MMuWeHQ9alNsqVuy3-Mc459B9myIT-.R_1iaQbNExj4loQJlyWYtA"
        }
    };
    
    res.json(manifest);
});

// Catalog information endpoint
app.get('/api/catalogs', (req, res) => {
    console.log('Catalog information requested');
    
    const catalogInfo = [
        { 
            id: 'marvel-mcu', 
            name: 'MCU', 
            category: 'Timeline',
            description: 'Marvel Cinematic Universe in chronological Order!',
            icon: 'calendar-alt'
        },
        { 
            id: 'xmen', 
            name: 'X-Men', 
            category: 'Character',
            description: 'All movies from X-Men in Chronologically Ordered!',
            icon: 'xmen-logo'
        },
        { 
            id: 'movies', 
            name: 'Movies', 
            category: 'Content Type',
            description: 'All Marvel movies!',
            icon: 'film'
        },
        { 
            id: 'series', 
            name: 'Series', 
            category: 'Content Type',
            description: 'All Marvel series!',
            icon: 'tv'
        },
        { 
            id: 'animations', 
            name: 'Animations', 
            category: 'Content Type',
            description: 'All Marvel animations!',
            icon: 'play-circle'
        }
    ];
    
    res.json(catalogInfo);
});

// RPDB-based catalog endpoint
app.get('/rpdb/:rpdbKey/catalog/:type/:id.json', async (req, res) => {
    const { rpdbKey, type, id } = req.params;
    console.log(`\n--- RPDB-based catalog requested - Type: ${type}, ID: ${id}, RPDB Key: ${rpdbKey.substring(0, 4)}... ---`);

    try {
        console.log('Checking cache...');
        const cacheKey = `rpdb-${id}`;
        if (cachedCatalog.has(cacheKey)) {
            console.log(`Returning cached catalog for ID: ${cacheKey} with RPDB posters`);
            const metasWithRpdbPosters = await replaceRpdbPosters(rpdbKey, cachedCatalog.get(cacheKey).metas);
            console.log(`Final order for ${id}:`, metasWithRpdbPosters.map(m => `${m.name} (${m.releaseInfo})`).join(', '));
            console.log(`Returning response: { metas: ${metasWithRpdbPosters.length} items }`);
            return res.json({ metas: metasWithRpdbPosters });
        }

        console.log('Loading data source...');
        let dataSource;
        let dataSourceName = id;

        switch (id) {
            case 'marvel-mcu':
                dataSource = chronologicalData;
                dataSourceName = 'MCU Chronologically Ordered';
                break;
            case 'xmen':
                dataSource = xmenData;
                dataSourceName = 'X-Men';
                break;
            case 'movies':
                dataSource = moviesData;
                dataSourceName = 'Movies';
                break;
            case 'series':
                dataSource = seriesData;
                dataSourceName = 'Series';
                break;
            case 'animations':
                dataSource = animationsData;
                dataSourceName = 'Animations';
                break;
            default:
                console.warn(`Unrecognized catalog ID: ${id}`);
                console.log(`Returning response: { metas: [Iron Man] }`);
                return res.json({ metas: [fallbackMeta] });
        }

        if (!Array.isArray(dataSource)) {
            console.error(`Data source for ID ${id} is not a valid array:`, JSON.stringify(dataSource));
            console.log(`Returning response: { metas: [Iron Man] }`);
            return res.json({ metas: [fallbackMeta] });
        }

        console.log(`Loaded ${dataSource.length} items for catalog: ${dataSourceName}`);

        console.log(`Generating catalog for ${dataSourceName} with ${dataSource.length} items...`);
        const limit = pLimit(5); // Limit to 5 concurrent TMDb calls
        const metas = await Promise.all(
            dataSource.map((item, index) => limit(async () => {
                console.log(`Processing item ${index + 1}/${dataSource.length}: ${item.title || 'Unknown'}`);
                try {
                    const meta = await fetchAdditionalData(item);
                    if (!meta) {
                        console.warn(`No metadata returned for ${item.title || 'Unknown'}`);
                    }
                    return meta;
                } catch (error) {
                    console.error(`Error fetching data for item ${item.title || 'Unknown'}: ${error.message}`);
                    return null;
                }
            }))
        );

        const validMetas = metas.filter(item => item !== null);
        console.log(`Catalog generated with ${validMetas.length} valid items for ID: ${id}`);

        if (!validMetas.length) {
            console.warn(`No valid metadata generated for ${dataSourceName}, using fallback meta`);
            console.log(`Returning response: { metas: [Iron Man] }`);
            return res.json({ metas: [fallbackMeta] });
        }

        cachedCatalog.set(cacheKey, { metas: validMetas });
        console.log(`Cached catalog ${cacheKey} with ${validMetas.length} items for 2 months`);

        console.log('Applying RPDB posters...');
        const metasWithRpdbPosters = await replaceRpdbPosters(rpdbKey, validMetas);
        console.log(`Final order for ${id}:`, metasWithRpdbPosters.map(m => `${m.name} (${m.releaseInfo})`).join(', '));
        console.log(`Returning response: { metas: ${metasWithRpdbPosters.length} items }`);
        return res.json({ metas: metasWithRpdbPosters });
    } catch (error) {
        console.error(`Error generating RPDB-based catalog for ID ${id}: ${error.message}\nStack: ${error.stack}`);
        console.log(`Returning response: { metas: [Iron Man] }`);
        return res.json({ metas: [fallbackMeta] });
    }
});

// Custom catalog endpoint
app.get('/catalog/:catalogsParam/catalog/:type/:id.json', async (req, res) => {
    const { catalogsParam, type, id } = req.params;
    console.log(`\n--- Custom catalog requested - Catalogs: ${catalogsParam}, Type: ${type}, ID: ${id} ---`);

    try {
        console.log('Parsing catalogsParam...');
        let rpdbKey = null;
        let catalogIds = catalogsParam;

        if (catalogsParam.includes(':') && !catalogsParam.endsWith(':')) {
            const parts = catalogsParam.split(':');
            catalogIds = parts[0];
            rpdbKey = parts[1];
            console.log(`RPDB key detected: ${rpdbKey.substring(0, 4)}...`);
        }

        console.log('Checking cache...');
        const cacheKey = `custom-${id}-${catalogsParam}`;
        if (cachedCatalog.has(cacheKey)) {
            console.log(`Returning cached catalog for ID: ${cacheKey}`);
            const metas = rpdbKey ? await replaceRpdbPosters(rpdbKey, cachedCatalog.get(cacheKey).metas) : cachedCatalog.get(cacheKey).metas;
            console.log(`Final order for ${id}:`, metas.map(m => `${m.name} (${m.releaseInfo})`).join(', '));
            console.log(`Returning response: { metas: ${metas.length} items }`);
            return res.json({ metas });
        }

        console.log('Loading data source...');
        let dataSource;
        let dataSourceName = id;

        switch (id) {
            case 'marvel-mcu':
                dataSource = chronologicalData;
                dataSourceName = 'MCU Chronologically Ordered';
                break;
            case 'xmen':
                dataSource = xmenData;
                dataSourceName = 'X-Men';
                break;
            case 'movies':
                dataSource = moviesData;
                dataSourceName = 'Movies';
                break;
            case 'series':
                dataSource = seriesData;
                dataSourceName = 'Series';
                break;
            case 'animations':
                dataSource = animationsData;
                dataSourceName = 'Animations';
                break;
            default:
                console.warn(`Unrecognized catalog ID: ${id}`);
                console.log(`Returning response: { metas: [Iron Man] }`);
                return res.json({ metas: [fallbackMeta] });
        }

        if (!Array.isArray(dataSource)) {
            console.error(`Data source for ID ${id} is not a valid array:`, JSON.stringify(dataSource));
            console.log(`Returning response: { metas: [Iron Man] }`);
            return res.json({ metas: [fallbackMeta] });
        }

        console.log(`Loaded ${dataSource.length} items for catalog: ${dataSourceName}`);

        console.log(`Generating catalog for ${dataSourceName} with ${dataSource.length} items...`);
        const limit = pLimit(5); // Limit to 5 concurrent TMDb calls
        const metas = await Promise.all(
            dataSource.map((item, index) => limit(async () => {
                console.log(`Processing item ${index + 1}/${dataSource.length}: ${item.title || 'Unknown'}`);
                try {
                    const meta = await fetchAdditionalData(item);
                    if (!meta) {
                        console.warn(`No metadata returned for ${item.title || 'Unknown'}`);
                    }
                    return meta;
                } catch (error) {
                    console.error(`Error fetching data for item ${item.title || 'Unknown'}: ${error.message}`);
                    return null;
                }
            }))
        );

        const validMetas = metas.filter(item => item !== null);
        console.log(`Catalog generated with ${validMetas.length} valid items for ID: ${id}`);

        if (!validMetas.length) {
            console.warn(`No valid metadata generated for ${dataSourceName}, using fallback meta`);
            console.log(`Returning response: { metas: [Iron Man] }`);
            return res.json({ metas: [fallbackMeta] });
        }

        cachedCatalog.set(cacheKey, { metas: validMetas });
        console.log(`Cached catalog ${cacheKey} with ${validMetas.length} items for 2 months`);

        console.log('Applying RPDB posters...');
        const finalMetas = rpdbKey ? await replaceRpdbPosters(rpdbKey, validMetas) : validMetas;
        console.log(`Final order for ${id}:`, finalMetas.map(m => `${m.name} (${m.releaseInfo})`).join(', '));
        console.log(`Returning response: { metas: ${finalMetas.length} items }`);
        return res.json({ metas: finalMetas });
    } catch (error) {
        console.error(`Error generating custom catalog for ID ${id}: ${error.message}\nStack: ${error.stack}`);
        console.log(`Returning response: { metas: [Iron Man] }`);
        return res.json({ metas: [fallbackMeta] });
    }
});

// Default catalog endpoint
app.get('/catalog/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    console.log(`\n--- Default catalog requested - Type: ${type}, ID: ${id} ---`);

    try {
        console.log('Checking RPDB key...');
        let rpdbKey = req.query.rpdb || null;
        const referer = req.get('Referrer') || '';
        if (!rpdbKey && referer) {
            const rpdbMatch = referer.match(/\/rpdb\/([^\/]+)\/manifest\.json/);
            if (rpdbMatch && rpdbMatch[1]) {
                rpdbKey = decodeURIComponent(rpdbMatch[1]);
                console.log(`RPDB key detected from referrer: ${rpdbKey.substring(0, 4)}...`);
            }
        }

        console.log('Checking cache...');
        const cacheKey = `default-${id}`;
        if (cachedCatalog.has(cacheKey)) {
            console.log(`Returning cached catalog for ID: ${cacheKey}`);
            const metas = rpdbKey ? await replaceRpdbPosters(rpdbKey, cachedCatalog.get(cacheKey).metas) : cachedCatalog.get(cacheKey).metas;
            console.log(`Final order for ${id}:`, metas.map(m => `${m.name} (${m.releaseInfo})`).join(', '));
            console.log(`Returning response: { metas: ${metas.length} items }`);
            return res.json({ metas });
        }

        console.log('Loading data source...');
        let dataSource;
        let dataSourceName = id;

        switch (id) {
            case 'marvel-mcu':
                dataSource = chronologicalData;
                dataSourceName = 'MCU Chronologically Ordered';
                break;
            case 'xmen':
                dataSource = xmenData;
                dataSourceName = 'X-Men';
                break;
            case 'movies':
                dataSource = moviesData;
                dataSourceName = 'Movies';
                break;
            case 'series':
                dataSource = seriesData;
                dataSourceName = 'Series';
                break;
            case 'animations':
                dataSource = animationsData;
                dataSourceName = 'Animations';
                break;
            default:
                console.warn(`Unrecognized catalog ID: ${id}`);
                console.log(`Returning response: { metas: [Iron Man] }`);
                return res.json({ metas: [fallbackMeta] });
        }

        if (!Array.isArray(dataSource)) {
            console.error(`Data source for ID ${id} is not a valid array:`, JSON.stringify(dataSource));
            console.log(`Returning response: { metas: [Iron Man] }`);
            return res.json({ metas: [fallbackMeta] });
        }

        console.log(`Loaded ${dataSource.length} items for catalog: ${dataSourceName}`);

        console.log(`Generating catalog for ${dataSourceName} with ${dataSource.length} items...`);
        const limit = pLimit(5); // Limit to 5 concurrent TMDb calls
        const metas = await Promise.all(
            dataSource.map((item, index) => limit(async () => {
                console.log(`Processing item ${index + 1}/${dataSource.length}: ${item.title || 'Unknown'}`);
                try {
                    const meta = await fetchAdditionalData(item);
                    if (!meta) {
                        console.warn(`No metadata returned for ${item.title || 'Unknown'}`);
                    }
                    return meta;
                } catch (error) {
                    console.error(`Error fetching data for item ${item.title || 'Unknown'}: ${error.message}`);
                    return null;
                }
            }))
        );

        const validMetas = metas.filter(item => item !== null);
        console.log(`Catalog generated with ${validMetas.length} valid items for ID: ${id}`);

        if (!validMetas.length) {
            console.warn(`No valid metadata generated for ${dataSourceName}, using fallback meta`);
            console.log(`Returning response: { metas: [Iron Man] }`);
            return res.json({ metas: [fallbackMeta] });
        }

        cachedCatalog.set(cacheKey, { metas: validMetas });
        console.log(`Cached catalog ${cacheKey} with ${validMetas.length} items for 2 months`);

        console.log('Applying RPDB posters...');
        const finalMetas = rpdbKey ? await replaceRpdbPosters(rpdbKey, validMetas) : validMetas;
        console.log(`Final order for ${id}:`, finalMetas.map(m => `${m.name} (${m.releaseInfo})`).join(', '));
        console.log(`Returning response: { metas: ${finalMetas.length} items }`);
        return res.json({ metas: finalMetas });
    } catch (error) {
        console.error(`Error generating default catalog for ID ${id}: ${error.message}\nStack: ${error.stack}`);
        console.log(`Returning response: { metas: [Iron Man] }`);
        return res.json({ metas: [fallbackMeta] });
    }
});

// Default routes
app.get('/', (req, res) => {
    res.redirect('/configure');
});

app.listen(port, () => {
    console.log(`Marvel Addon server running at http://localhost:${port}/`);
    console.log(`Configuration page: http://localhost:${port}/configure`);
    console.log(`To install with custom catalogs: http://localhost:${port}/catalog/CATALOG_IDS/manifest.json`);
});

// Export fetchAdditionalData for testing
module.exports = { fetchAdditionalData };
