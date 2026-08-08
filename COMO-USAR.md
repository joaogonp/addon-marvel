# Como pôr isto a correr

## 1. Gerar (ou atualizar) o metadataCache.json — uma vez, localmente, com Node

```bash
npm install
cp .env.example .env          # mete lá o teu TMDB_API_KEY
npm run build-metadata        # vai buscar metadados para todos os itens (demora um pouco)
```

Isto cria/atualiza `Data/metadataCache.json`. Faz commit desse ficheiro
para o repositório — é ele que o addon vai servir, sem tocar no TMDb
em produção.

## 2. Testar localmente com Deno (opcional mas recomendado)

Precisas de ter o Deno instalado (https://deno.com/).

```bash
export TMDB_API_KEY=a_tua_chave     # no Windows PowerShell: $env:TMDB_API_KEY="..."
deno task start
```

Abre `http://localhost:7000/configure` para confirmar que a página de
configuração e a escolha de catálogos funcionam.

## 3. Deploy no Deno Deploy

1. Faz push deste projeto (com o `Data/metadataCache.json` já gerado)
   para um repositório no GitHub.
2. Vai a https://dash.deno.com e cria um novo projeto, ligando esse
   repositório.
3. Define o **entry point** como `main.js`.
4. Nas variáveis de ambiente do projeto, adiciona `TMDB_API_KEY` com a
   tua chave (só é usada como rede de segurança para itens que ainda
   não estejam no metadataCache.json).
5. Faz deploy. O Deno Deploy dá-te um domínio tipo
   `o-teu-projeto.deno.dev` — é esse o novo link a usar no manifest do
   Stremio (em vez do `addon-marvel.onrender.com`).

## 4. Quando adicionares filmes/séries novas

1. Adiciona a entrada normalmente em `Data/moviesData.js` (ou o
   ficheiro relevante) — a sintaxe é a mesma de sempre, só que agora
   o ficheiro usa `export default [...]` em vez de `module.exports`.
2. Corre `npm run build-metadata` outra vez — só processa os itens
   novos.
3. Faz commit e push. O Deno Deploy faz deploy automático a cada push
   (se ligaste o GitHub na criação do projeto).

## Notas

- O `configure.html` não precisa de nenhuma alteração — já usa
  `window.location`, por isso funciona automaticamente no novo domínio.
- Já não precisas do site de ping de 15 em 15 minutos: o Deno Deploy
  não "adormece" instâncias como o Render free tier.
- O `package.json` da raiz é só para o script `buildMetadata.js`
  (Node). O `main.js` corre no Deno e usa `npm:` specifiers — não
  precisa de `npm install` para o deploy em si.
