// index.js - con temporadas corregidas, proxy de imágenes y sinopsis real
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const http = require("http");
const { URL } = require("url");
const manifest = require("./manifest.json");
const builder = new addonBuilder(manifest);

const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

// catálogos soportados
const CATALOGS = {
  animeonline_castellano: "https://ww3.animeonline.ninja/genero/anime-castellano/",
  animeonline_emision: "https://ww3.animeonline.ninja/genero/en-emision-1/"
};

// puertos
const ADDON_PORT = process.env.ADDON_PORT ? Number(process.env.ADDON_PORT) : 7000;
const IMG_PROXY_PORT = process.env.IMG_PROXY_PORT ? Number(process.env.IMG_PROXY_PORT) : 7001;
const IMG_PROXY_BASE = `http://127.0.0.1:${IMG_PROXY_PORT}/img/`;

// ----------------- utils -----------------
function abs(u, base) {
  if (!u) return null;
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  if (u.startsWith("//")) return "https:" + u;
  try { return new URL(u, base).href; } catch(e) { return u; }
}

function pickImg($el) {
  if (!$el || $el.length === 0) return null;
  const attrs = ['data-src','data-lazy-src','data-original','src','srcset'];
  for (const a of attrs) {
    const v = $el.attr(a);
    if (v) {
      if (a === 'srcset' && v.includes(',')) {
        const parts = v.split(',');
        return parts[parts.length-1].trim().split(' ')[0];
      }
      return v;
    }
  }
  return null;
}

function normalizePreferLarge(src) {
  if (!src) return null;
  return src.replace(/-\d+x\d+(?=\.[a-z]{2,4}$)/i, "").replace(/-\d+x\d+(?=\?)/i, "");
}

function isAllowedHost(u) {
  try {
    const parsed = new URL(u);
    const host = parsed.hostname || "";
    // Asegúrate de que esto sea lo suficientemente amplio para las URLs de streaming si son de otros dominios
    return host.includes("animeonline.ninja") || host.includes("mp4upload.com") || host.includes("fembed.com") || host.includes("streamtape.com"); // Agrega los hosts de tus reproductores
  } catch (e) { return false; }
}

function makeProxyUrl(target) {
  if (!target) return null;
  const b64 = Buffer.from(target).toString("base64");
  return IMG_PROXY_BASE + encodeURIComponent(b64);
}

function safeProxyPoster(raw, base) {
  try {
    const resolved = abs(raw, base);
    if (!resolved || !resolved.startsWith("http"))
      return "https://stremio.com/website/stremio-logo-small.png";
    const normal = normalizePreferLarge(resolved);
    if (!isAllowedHost(normal)) // Esta función isAllowedHost aquí se aplica al poster, no al video.
      return "https://stremio.com/website/stremio-logo-small.png";
    return makeProxyUrl(normal);
  } catch(e) {
    return "https://stremio.com/website/stremio-logo-small.png";
  }
}

// ----------------- scraping catálogo -----------------
async function scrapeCatalog(baseUrl) {
  const metas = [];
  const seen = new Set();
  let page = 1;
  while (true) {
    const pageUrl = page === 1 ? baseUrl : `${baseUrl}page/${page}/`;
    console.log("Fetching catalog page:", pageUrl);
    let res;
    try {
      res = await axios.get(pageUrl, { headers: HEADERS, timeout: 15000 });
    } catch (err) {
      console.log("Stop paging:", err.message);
      break;
    }
    const $ = cheerio.load(res.data);
    const items = $("article.item.tvshows, .animepost, article.post, .items .item, .anime__item");
    if (!items || items.length === 0) {
      console.log("No items found on page", page);
      break;
    }
    let added = 0;
    items.each((i, el) => {
      try {
        const $el = $(el);
        const a = $el.find("a").first();
        let href = a.attr("href") || $el.find("a").attr("data-href") || "";
        href = abs(href, baseUrl);
        if (!href) return;
        if (seen.has(href)) return;

        const imgEl = $el.find("img").first();
        let posterRaw = pickImg(imgEl);
        let posterProxy = safeProxyPoster(posterRaw, baseUrl);

        const title = (imgEl.attr("alt") || $el.find(".title").first().text().trim() ||
                       a.attr("title") || a.text().trim() || href).trim();
        metas.push({
          id: "animeonline_" + Buffer.from(href).toString("base64"),
          type: "series",
          name: title,
          poster: posterProxy
        });
        seen.add(href);
        added++;
      } catch(e) {}
    });
    if (added === 0) break;
    page++;
    if (page > 1000) break;
  }
  return metas;
}

// ----------------- handlers -----------------
builder.defineCatalogHandler(async ({ type, id }) => {
  if (!CATALOGS[id]) return { metas: [] };
  try {
    const metas = await scrapeCatalog(CATALOGS[id]);
    if (metas.length === 0) {
      metas.push({
        id: "animeonline_" + Buffer.from(CATALOGS[id]).toString("base64"),
        type: type,
        name: "Fallback Anime",
        poster: "https://stremio.com/website/stremio-logo-small.png"
      });
    }
    return { metas };
  } catch (err) {
    console.error("Catalog handler error:", err.message);
    return { metas: [] };
  }
});

// META handler con temporadas + sinopsis real
builder.defineMetaHandler(async ({ type, id }) => {
  if (!id || !id.startsWith("animeonline_")) return { meta: {} };
  try {
    const url = Buffer.from(id.replace("animeonline_", ""), "base64").toString("utf8");
    const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(res.data);
    const title = $(".entry-title").first().text().trim() || $("h1").first().text().trim() || url;

    // poster (via proxy)
    const posterRaw = pickImg($(".thumb img").first()) || pickImg($("img").first());
    const posterProxy = safeProxyPoster(posterRaw, url);

    const videos = [];
    const seen = new Set();

    const seasonBlocks = $("#seasons .se-c, .se-c");
    if (seasonBlocks.length > 0) {
      seasonBlocks.each((i, seasonEl) => {
        const $season = $(seasonEl);

        // Detectar número de temporada correctamente
        let seasonText = $season.find(".title").text().trim();
        let seasonNum = 0;
        const match = seasonText.match(/([0-9]+)/);
        if (match) {
          seasonNum = parseInt(match[1]);
        }
        if (!seasonNum) seasonNum = i + 1;

        $season.find("ul.episodios li a, .episodios a").each((j, epEl) => {
          try {
            const a = $(epEl);
            let href = a.attr("href") || "";
            if (!href) return;
            href = abs(href, url);
            if (seen.has(href)) return;
            seen.add(href);

            const epNum = j + 1;
            const epTitle = a.text().trim() || `Episodio ${epNum}`;

            videos.push({
              id: "animeonline_" + Buffer.from(href).toString("base64"),
              title: epTitle,
              season: seasonNum,
              episode: epNum
            });
          } catch(e) {}
        });
      });
    } else {
      $("ul.episodios li a, .episodios a, li.episodiolist a, .ep__item a").each((i, el) => {
        try {
          const a = $(el);
          let href = a.attr("href") || "";
          if (!href) return;
          href = abs(href, url);
          if (seen.has(href)) return;
          seen.add(href);

          const epTitle = a.text().trim() || `Episodio ${i+1}`;
          videos.push({
            id: "animeonline_" + Buffer.from(href).toString("base64"),
            title: epTitle,
            season: 1,
            episode: i+1
          });
        } catch(e) {}
      });
    }

    if (videos.length === 0) {
      videos.push({
        id: "animeonline_" + Buffer.from(url).toString("base64"),
        title: "Episodio 1",
        season: 1,
        episode: 1
      });
    }

    // ----------- SINOPSIS REAL -----------
    const description = $("#info .wp-content").first().text().trim() || "";

    return {
      meta: {
        id,
        type,
        name: title,
        poster: posterProxy,
        description,
        videos
      }
    };
  } catch (err) {
    console.error("Meta handler error:", err.message);
    return { meta: {} };
  }
});

const puppeteer = require("puppeteer");

// STREAM handler: obtiene servidores desde admin-ajax y resuelve Streamtape + MP4Upload
builder.defineStreamHandler(async ({ id }) => {
  console.log("Stream request:", id);
  if (!id || !id.startsWith("animeonline_")) return { streams: [] };

  const episodeUrl = Buffer.from(id.replace("animeonline_", ""), "base64").toString("utf8");

  try {
    const res = await axios.get(episodeUrl, { headers: HEADERS, timeout: 20000 });
    const $ = cheerio.load(res.data);

    const options = $("li.dooplay_player_option");
    const allStreams = [];
    const seenLinks = new Set();

    // --- Resolver Streamtape ---
    async function resolveStreamtape(link, referer) {
      try {
        const stRes = await axios.get(link, {
          headers: { ...HEADERS, Referer: referer || episodeUrl },
          timeout: 20000
        });
        const html = stRes.data || "";

        const patterns = [
          /document\.getElementById\(['"]robotlink['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]/i,
          /(https?:\/\/(?:www\.)?streamtape\.com\/get_video\?[^"'&<\s]+)/i,
          /(https?:\/\/[^"'<\s]+\.mp4[^"'<\s]*)/i
        ];
        for (const re of patterns) {
          const m = html.match(re);
          if (m && m[1]) {
            let videoUrl = m[1].trim();
            if (videoUrl.startsWith("//")) videoUrl = "https:" + videoUrl;
            if (!videoUrl.startsWith("http")) videoUrl = "https:" + videoUrl;
            return videoUrl;
          }
        }
        return null;
      } catch (e) {
        console.error("resolveStreamtape error:", e.message);
        return null;
      }
    }

    // --- Resolver MP4UPLOAD con Puppeteer ---
    async function resolveMp4upload(link) {
      try {
        const browser = await puppeteer.launch({
          headless: true,
          args: ["--no-sandbox", "--disable-setuid-sandbox"]
        });
        const page = await browser.newPage();
        await page.setUserAgent(HEADERS["User-Agent"]);
        await page.goto(link, { waitUntil: "networkidle2", timeout: 30000 });

        const videoUrl = await page.evaluate(() => {
          const scripts = Array.from(document.scripts).map(s => s.textContent);
          for (const sc of scripts) {
            const m = sc.match(/player\.src\(["'](https?:\/\/[^"']+\.mp4[^"']*)["']/);
            if (m) return m[1];
          }
          return null;
        });

        await browser.close();
        return videoUrl;
      } catch (e) {
        console.error("mp4upload resolve error:", e.message);
        return null;
      }
    }

    const optionPromises = [];
    options.each((i, el) => {
      optionPromises.push((async () => {
        try {
          const $el = $(el);
          const post = $el.attr("data-post");
          const nume = $el.attr("data-nume");
          if (!post || !nume) return;

          const ajaxRes = await axios.post(
            "https://ww3.animeonline.ninja/wp-admin/admin-ajax.php",
            new URLSearchParams({
              action: "doo_player_ajax",
              post,
              nume,
              type: "movie"
            }).toString(),
            { headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 20000 }
          );

          let embedUrl = null;
          if (ajaxRes && typeof ajaxRes.data === "object" && ajaxRes.data.embed_url) {
            embedUrl = ajaxRes.data.embed_url;
          } else if (ajaxRes && typeof ajaxRes.data === "string") {
            const $$ = cheerio.load(ajaxRes.data);
            $$("iframe").each((k, iframe) => {
              const src = $$(iframe).attr("src") || "";
              if (!embedUrl && src) embedUrl = src;
            });
          }
          if (!embedUrl) return;

          const embedRes = await axios.get(embedUrl, { headers: { ...HEADERS, Referer: episodeUrl }, timeout: 20000 });
          const $$$ = cheerio.load(embedRes.data);

          const playerEls = $$$("li[onclick], div.ODDIV li");
          const subPromises = [];

          playerEls.each((j, pel) => {
            const onclick = $$$(pel).attr("onclick") || "";
            const m = onclick.match(/go_to_player\(['"]([^'"]+)['"]\)/);
            if (!m) return;
            let link = m[1].trim();
            if (!link) return;
            if (link.startsWith("//")) link = "https:" + link;
            try { link = new URL(link, embedUrl).href; } catch {}

            if (seenLinks.has(link)) return;
            seenLinks.add(link);

            const title = $$$(pel).find("span").text().trim() || "Servidor";

            if (link.includes("streamtape.com")) {
              subPromises.push((async () => {
                const videoDirect = await resolveStreamtape(link, embedUrl);
                if (videoDirect) {
                  allStreams.push({ title: "STREAMTAPE (directo)", url: videoDirect });
                } else {
                  allStreams.push({ title: "STREAMTAPE", externalUrl: link });
                }
              })());
            } else if (link.includes("mp4upload.com")) {
              subPromises.push((async () => {
                const videoDirect = await resolveMp4upload(link);
                if (videoDirect) {
                  allStreams.push({ title: "MP4UPLOAD (directo)", url: videoDirect });
                } else {
                  allStreams.push({ title: "MP4UPLOAD", externalUrl: link });
                }
              })());
            } else {
              allStreams.push({ title, externalUrl: link });
            }
          });

          await Promise.all(subPromises);
        } catch (e) {
          console.error("option promise error:", e.message);
        }
      })());
    });

    await Promise.all(optionPromises);

    if (!allStreams.length) {
      console.log("⚠️ No se encontraron streams en", episodeUrl);
      return { streams: [] };
    }

    const dedup = [];
    const sseen = new Set();
    for (const st of allStreams) {
      const key = st.url || st.externalUrl || st.title;
      if (!key) continue;
      if (sseen.has(key)) continue;
      sseen.add(key);
      dedup.push(st);
    }

    return { streams: dedup };
  } catch (err) {
    console.error("Stream handler error:", err.message);
    return { streams: [] };
  }
});

// ----------------- iniciar servers -----------------
if (require.main === module) {
  const PORT = process.env.PORT || 7000;

  // Servidor único con addon + proxy
  const http = require("http");

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://0.0.0.0:${PORT}`);

    if (parsed.pathname.startsWith("/img/")) {
      // Proxy de imágenes
      try {
        const parts = parsed.pathname.split("/").filter(Boolean);
        if (parts.length < 2) {
          res.writeHead(404);
          return res.end("Not Found");
        }
        const b64 = decodeURIComponent(parts[1]);
        let target = Buffer.from(b64, "base64").toString("utf8");

        if (!isAllowedHost(target)) {
          res.writeHead(403);
          return res.end("Forbidden");
        }

        const upstream = await axios.get(target, {
          responseType: "stream",
          headers: { ...HEADERS, Referer: "https://ww3.animeonline.ninja" }
        });

        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": upstream.headers["content-type"] || "image/jpeg",
          "Cache-Control": "public, max-age=86400"
        });

        upstream.data.pipe(res);
      } catch (err) {
        console.log("Proxy error:", err.message);
        res.writeHead(302, {
          Location: "https://stremio.com/website/stremio-logo-small.png"
        });
        res.end();
      }
    } else {
      // Aquí usamos serveHTTP en lugar de addonInterface directamente
      return serveHTTP(builder.getInterface(), { req, res });
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Addon corriendo en http://0.0.0.0:${PORT}/manifest.json`);
  });
} else {
  module.exports = builder.getInterface();
}
