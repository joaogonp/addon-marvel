const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const chronologicalData = require('../Data/chronologicalData');
const { tmdbKey, omdbKey, port } = require('./config');

const express = require('express');
const compression = require('compression');

const app = express();
app.use(compression());

// Health check para o Render
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Middleware para definir cache
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=2629743'); // 1 mês
  next();
});

// Inicialização do add-on
console.log('Starting Marvel Addon v1.1.0...');
const builder = new addonBuilder(require('./manifest.json'));

// Variável para armazenar o cache separado por ID e genre
let cachedCatalog = {};

// Função para buscar dados adicionais (OMDb e TMDb)
async function fetchAdditionalData(item) {
  try {
    const omdbUrl = `http://www.omdbapi.com/?i=${item.imdbId}&apikey=${omdbKey}`;
    const tmdbSearchUrl = `https://api.themoviedb.org/3/search/${item.type === 'movie' ? 'movie' : 'tv'}?api_key=${tmdbKey}&query=${encodeURIComponent(item.title)}&year=${item.releaseYear}`;

    console.log(`Fetching data for ${item.title} (${item.imdbId})...`);
    const [omdbRes, tmdbRes] = await Promise.all([
      axios.get(omdbUrl).catch((err) => {
        console.error(`OMDB error for ${item.imdbId}: ${err.message}`);
        return {};
      }),
      axios.get(tmdbSearchUrl).catch((err) => {
        console.error(`TMDB error for ${item.title}: ${err.message}`);
        return {};
      })
    ]);

    const omdbData = omdbRes.data || {};
    const tmdbData = tmdbRes.data?.results?.[0] || {};

    let poster = null;
    if (item.poster) {
      poster = item.poster;
    } else if (tmdbData.poster_path) {
      poster = `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`;
    } else if (omdbData.Poster && omdbData.Poster !== 'N/A') {
      poster = omdbData.Poster;
    } else {
      poster = 'https://m.media-amazon.com/images/M/MV5BMTc5MDE2ODcwNV5BMl5BanBnXkFtZTgwMzI2NzQ2NzM@._V1_SX300.jpg';
      console.warn(`No poster found for ${item.title} (${item.imdbId}), using fallback.`);
    }

    return {
      id: item.imdbId,
      type: item.type,
      name: item.type === 'series' ? item.title.replace(/ Season \d+/, '') : item.title,
      poster: poster,
      description: tmdbData.overview || omdbData.Plot || 'No description available',
      releaseInfo: item.releaseInfo || item.releaseYear,
      imdbRating: omdbData.imdbRating || 'N/A',
      genres: tmdbData.genres ? tmdbData.genres.map(g => g.name) : ['Action', 'Adventure']
    };
  } catch (err) {
    console.error(`Error processing ${item.title} (${item.imdbId}): ${err.message}`);
    return null;
  }
}

// Função para ordenar dados por data de lançamento, tratando "TBA"
function sortByReleaseDate(data, order = 'desc') {
  return [...data].sort((a, b) => {
    const dateA = a.releaseInfo || a.releaseYear;
    const dateB = b.releaseInfo || b.releaseYear;
    const isTBA_A = dateA === 'TBA' || dateA === null || isNaN(new Date(dateA).getTime());
    const isTBA_B = dateB === 'TBA' || dateB === null || isNaN(new Date(dateB).getTime());

    if (isTBA_A && isTBA_B) return 0; // Mantém a ordem original se ambos forem TBA
    if (isTBA_A) return order === 'asc' ? 1 : -1; // TBA no final em ascendente, início em descendente
    if (isTBA_B) return order === 'asc' ? -1 : 1;

    const timeA = new Date(dateA).getTime();
    const timeB = new Date(dateB).getTime();
    return order === 'asc' ? timeA - timeB : timeB - timeA;
  });
}

// Definição do catálogo
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log(`Catalog requested - Type: ${type}, ID: ${id}, Extra: ${JSON.stringify(extra)}`);

  const cacheKey = id + (extra?.genre ? `_${extra.genre}` : '');
  if (cachedCatalog[cacheKey]) {
    console.log(`✅ Retornando catálogo do cache para ID: ${cacheKey}`);
    return cachedCatalog[cacheKey];
  }

  let dataSource;
  if (type === 'Marvel' && id === 'marvel-mcu') {
    dataSource = chronologicalData; // Usa a ordem original para o "Top"
    if (extra?.genre === 'old') {
      dataSource = sortByReleaseDate([...dataSource], 'asc');
      console.log('Chronologically Order - Applying sort: asc (old to new)');
    } else if (extra?.genre === 'new') {
      dataSource = sortByReleaseDate([...dataSource], 'desc');
      console.log('Chronologically Order - Applying sort: desc (new to old)');
    } else {
      console.log('Chronologically Order - Using default chronological order from data for Top');
    }
  } else if (type === 'Marvel' && id === 'xmen') {
    dataSource = xmenData; // Usa a ordem original de xmenData
    console.log('X-Men - Using default order from xmenData');
  } else if (type === 'Marvel' && id === 'movies') {
    dataSource = moviesData;
    if (extra?.genre === 'new') {
      dataSource = sortByReleaseDate([...dataSource], 'desc');
      console.log('Movies - Applying sort: desc (new to old)');
    } else {
      console.log('Movies - Using default order from data for Top');
    }
  } else if (type === 'Marvel' && id === 'series') {
    dataSource = seriesData; // Usa a ordem original (já Old to New)
    if (extra?.genre === 'new') {
      dataSource = sortByReleaseDate([...dataSource], 'desc');
      console.log('Series - Applying sort: desc (new to old)');
    } else {
      console.log('Series - Using default order from seriesData for Top (already Old to New)');
    }
  } else if (type === 'Marvel' && id === 'animations') {
    dataSource = animationsData; // Usa a ordem padrão para o "Top"
    if (extra?.genre === 'old') {
      dataSource = sortByReleaseDate([...dataSource], 'asc');
      console.log('Animations - Applying sort: asc (old to new)');
    } else if (extra?.genre === 'new') {
      dataSource = sortByReleaseDate([...dataSource], 'desc');
      console.log('Animations - Applying sort: desc (new to old)');
    } else {
      console.log('Animations - Using default order from animationsData for Top');
    }
  } else {
    return Promise.resolve({ metas: [] });
  }

  const metas = await Promise.all(dataSource.map(fetchAdditionalData));
  const validMetas = metas.filter(item => item !== null);
  console.log(`✅ Catálogo gerado com ${validMetas.length} itens for ID: ${id}, Genre: ${extra?.genre || 'default'}`);

  cachedCatalog[cacheKey] = { metas: validMetas };
  return cachedCatalog[cacheKey];
});

// Configuração do servidor
console.log('Initializing addon interface...');
const addonInterface = builder.getInterface();

console.log(`Starting server on port ${port}...`);
serveHTTP(addonInterface, {
  port,
  beforeMiddleware: app
});
