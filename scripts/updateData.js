const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TMDB_API_KEY = process.env.TMDB_API_KEY;

if (!TMDB_API_KEY) {
  console.error('❌ Erro: TMDB_API_KEY não está definida');
  process.exit(1);
}
console.log('✅ Chave da API TMDb carregada com sucesso');

const COMPANY_IDS = {
  marvelStudios: 420,
  marvelEntertainment: 7505,
  abcStudios: 19366,
  sonyPictures: 34,
  fox: 127928,
  columbiaPictures: 5,
  newLineCinema: 12,
  disney: 2,
  marvelTelevision: 38679,
};

const CURRENT_DATE = new Date().toISOString().split('T')[0];

async function getTmdbDetails(id, type) {
  const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API_KEY}&language=en-US&append_to_response=external_ids,production_companies,genres,belongs_to_collection`;
  try {
    const res = await axios.get(url);
    return res.data;
  } catch {
    return null;
  }
}

async function fetchAllPages(url) {
  let page = 1;
  let totalPages = 1;
  const results = [];

  do {
    try {
      const response = await axios.get(`${url}&page=${page}`);
      if (response?.data?.results) {
        results.push(...response.data.results);
        totalPages = response.data.total_pages;
      }
    } catch {
      break;
    }
    page++;
  } while (page <= totalPages);

  return results;
}

async function fetchMarvelContent() {
  const results = [];

  const fetchByCompany = async (companyId, type) => {
    const url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API_KEY}&language=en-US&with_companies=${companyId}&sort_by=release_date.asc`;
    return await fetchAllPages(url);
  };

  for (const companyId of Object.values(COMPANY_IDS)) {
    const movies = await fetchByCompany(companyId, 'movie');
    const series = await fetchByCompany(companyId, 'tv');
    results.push(...movies.map(i => ({ ...i, type: 'movie' })));
    results.push(...series.map(i => ({ ...i, type: 'tv' })));
  }

  const mcuCollectionUrl = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&language=en-US&with_collection=263115&sort_by=release_date.asc`;
  const mcuMovies = await fetchAllPages(mcuCollectionUrl);
  results.push(...mcuMovies.map(i => ({ ...i, type: 'movie' })));

  const uniqueResults = Array.from(new Map(results.map(item => [item.id, item])).values());
  return uniqueResults;
}

function cleanTitle(title) {
  return title
    .replace(/:?\s*(season|temporada)\s*\d+/i, '')
    .replace(/\s+\(\d{4}\)$/, '')
    .trim();
}

function deduplicateByTitle(data) {
  const map = new Map();
  for (const item of data) {
    const clean = cleanTitle(item.title);
    if (!map.has(clean)) {
      map.set(clean, item);
    } else {
      const existing = map.get(clean);
      const existingYear = parseInt(existing.releaseYear) || 9999;
      const currentYear = parseInt(item.releaseYear) || 9999;
      if (currentYear < existingYear) {
        map.set(clean, item);
      }
    }
  }
  return Array.from(map.values());
}

function readPreviousData() {
  const filePath = path.join(__dirname, '../Data/Data.js');
  if (!fs.existsSync(filePath)) return [];
  try {
    return require(filePath);
  } catch {
    return [];
  }
}

async function updateData() {
  console.log('🔄 A buscar conteúdos da Marvel...');
  const marvelContent = await fetchMarvelContent();
  const previousData = readPreviousData();

  const updatedData = [];

  for (const release of marvelContent) {
    const title = (release.title || release.name || '').trim();
    const releaseYear = (release.release_date || release.first_air_date || 'TBD').split('-')[0];

    const details = await getTmdbDetails(release.id, release.type);
    if (!details) continue;

    const imdbId = details.external_ids?.imdb_id || `tmdb_${release.id}`;
    const poster = details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null;

    const isAnimation = details.genres?.some(g => g.name.toLowerCase() === 'animation');
    const type = isAnimation ? 'animation' : release.type === 'tv' ? 'series' : 'movie';

    updatedData.push({
      title,
      type,
      imdbId,
      id: `marvel_${imdbId}`,
      releaseYear,
      poster,
    });
  }

  const deduplicated = deduplicateByTitle(updatedData);
  const previousIds = new Set(previousData.map(i => i.id));
  const newItems = deduplicated.filter(i => !previousIds.has(i.id));

  if (newItems.length === 0) {
    console.log('✅ Nenhum novo conteúdo encontrado. Data.js não foi alterado.');
    return;
  }

  const finalData = [...previousData, ...newItems];
  const fileContent = `module.exports = ${JSON.stringify(finalData, null, 2)};\n`;
  fs.writeFileSync(path.join(__dirname, '../Data/Data.js'), fileContent, 'utf8');
  console.log(`✅ ${newItems.length} novos conteúdos adicionados ao Data.js`);
}

updateData().catch(err => {
  console.error('❌ Erro ao atualizar Data.js:', err);
  process.exit(1);
});
