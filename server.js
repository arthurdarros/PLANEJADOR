// Planejador de viagem - backend (Node 18+, zero dependências)
// Uso: node server.js   ->  http://localhost:3000
const http = require("http"), fs = require("fs"), path = require("path"), dns = require("dns").promises, net = require("net"), crypto = require("crypto");
const PORT = process.env.PORT || 3000, TOKEN = process.env.APP_TOKEN || "";
const DATA = path.join(__dirname, "data"), UP = path.join(DATA, "uploads"), DB = path.join(DATA, "trips.json"), OLD = path.join(DATA, "trip.json");
fs.mkdirSync(UP, { recursive: true });
const UA = "PlanejadorViagem/1.0 (uso pessoal)";
const cache = new Map(); // cache simples em memória

const send = (res, code, body, type = "application/json; charset=utf-8", extra = {}) => { res.writeHead(code, { "Content-Type": type, ...extra }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = req => new Promise((ok, no) => { let b = ""; req.on("data", c => { b += c; if (b.length > 5e6) { no(new Error("grande")); req.destroy(); } }); req.on("end", () => ok(b)); });
const get = async (u, opt = {}) => fetch(u, { ...opt, headers: { "User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9", ...(opt.headers || {}) }, signal: AbortSignal.timeout(8000), redirect: "follow" });

// ---------- Persistência (arquivo JSON, gravação atômica) ----------
// Formato: { "<id>": { dest, ini, fim, cities, items: [...] }, ... }  (igual ao trips.json)
const loadAll = () => { try { return JSON.parse(fs.readFileSync(DB, "utf8")); } catch { return {}; } };
const saveAll = o => { fs.writeFileSync(DB + ".tmp", JSON.stringify(o)); fs.renameSync(DB + ".tmp", DB); };
const okId = id => /^\d{1,20}$/.test(id || ""); // ids numéricos (Date.now()); evita chaves como __proto__
const counted = t => (t.items || []).filter(x => !["hosp", "carro", "comer"].includes(x.cat) || x.escolhida);
const resumo = ([id, t]) => ({ id, dest: t.dest || "", ini: t.ini || "", fim: t.fim || "", cities: t.cities || (t.dest ? [t.dest] : []), count: (t.items || []).length, total: counted(t).reduce((s, x) => s + (Number(x.preco) || 0), 0) });
// Migração: trip.json (viagem única antiga) vira uma entrada em trips.json
if (!fs.existsSync(DB) && fs.existsSync(OLD)) { try { const t = JSON.parse(fs.readFileSync(OLD, "utf8")); if (t && t.dest) saveAll({ [Date.now()]: t }); } catch {} }

// ---------- Segurança: bloqueia URLs para rede interna (SSRF) ----------
async function safeUrl(u) {
  const url = new URL(u);

  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("URL inválida");
  }

  const addresses = await dns.lookup(url.hostname, { all: true });

  for (const { address } of addresses) {
    if (
      (net.isIP(address) === 4 &&
        /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) ||
      (net.isIP(address) === 6 && /^(::1|fc|fd|fe80)/i.test(address))
    ) {
      throw new Error("Endereço não permitido");
    }
  }

  return url.href;
}

// ---------- Preview de link: nome, preço e foto automáticos ----------
const meta = (html, k) => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`, "i")) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`, "i")); return m ? decode(m[1]) : ""; };
const decode = s => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
function parseHtml(html, href) {
  const u = new URL(href), sp = u.searchParams, air = /airbnb\./.test(u.hostname);
  const ogt = decode(meta(html, "og:title") || meta(html, "twitter:title") || ((html.match(/<title[^>]*>([^<]*)/i) || [])[1] || "").trim());
  const tt = decode(meta(html, "twitter:title") || ((html.match(/<title[^>]*>([^<]*)/i) || [])[1] || "")).split(" - ").map(x => x.trim()).filter(x => x && x !== "Airbnb");
  if (tt.length > 1) tt.pop(); // tira o sufixo "Casas de campo para Alugar em ..."
  const titulo = tt.join(" - ");
  let nome = ogt, nota = "", cidade = "";
  if (air) {
    const p = ogt.split(" · ").map(x => x.trim()); // ex.: "Cabana · Gramado · ★4,83 · 1 quarto · 2 camas · 1 banheiro"
    if (p.length >= 3) { nome = meta(html, "og:description") || titulo; cidade = p[1]; nota = [p[0], ...p.slice(2)].join(" · "); }
    else nome = titulo || ogt;
    if (!cidade) cidade = (decode(html.match(/<title[^>]*>([^<]*)/i)?.[1] || "").match(/ em ([^,]+),/) || [])[1] || "";
  }
  if (nome === "Airbnb") nome = "";
  let preco = meta(html, "og:price:amount") || meta(html, "product:price:amount");
  if (!preco) for (const m of html.matchAll(/<script[^>]+ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) { const x = (m[1].match(/"price"\s*:\s*"?([\d.,]+)/) || [])[1]; if (x) { preco = x; break; } }
  if (preco) preco = String(Number(preco.includes(",") ? preco.replace(/\./g, "").replace(",", ".") : preco) || "");
  const dt = k => { const v = sp.get(k) || sp.get(k.replace("_", "")) || ""; return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ""; };
  const h = decode(html).match(/a partir das (\d{1,2})(?:h|:(\d{2}))/i);
  const hin = h && +h[1] < 24 ? String(h[1]).padStart(2, "0") + ":" + (h[2] || "00") : "";
  return { nome: nome.trim(), preco, nota, cidade, ci: dt("check_in"), co: dt("check_out"), hin, fotoUrl: meta(html, "og:image") || meta(html, "twitter:image") };
}
async function preview(raw) {
  if (!raw) {
    throw new Error("URL não informada");
  }

  const href = await safeUrl(raw);

  const r = await get(href);

  if (!r.ok) {
    throw new Error("Não foi possível acessar o link");
  }

  const contentType = r.headers.get("content-type") || "";

  if (!contentType.includes("text/html")) {
    throw new Error("O link não é uma página HTML");
  }

  const html = (await r.text()).slice(0, 2e6);

  const d = parseHtml(html, href);

  const fu = d.fotoUrl;
  delete d.fotoUrl;

  d.foto = "";

  if (fu) {
    try {
      d.foto = await baixarFoto(new URL(fu, href).href);
    } catch (e) {
      console.error("Erro ao baixar imagem:", e.message);
    }
  }

  return d;
}
async function baixarFoto(u) {
  await safeUrl(u);
  const r = await get(u), ct = r.headers.get("content-type") || "", ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[ct.split(";")[0]];
  if (!ext) throw new Error("tipo");
  const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 4e6) throw new Error("grande");
  const nome = crypto.createHash("md5").update(buf).digest("hex") + "." + ext;
  fs.writeFileSync(path.join(UP, nome), buf); return "/uploads/" + nome;
}

// ---------- Cidades (OpenStreetMap/Nominatim) ----------
async function places(q) {
  const k = "p:" + q.toLowerCase(); if (cache.has(k)) return cache.get(k);
  const r = await get("https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&featuretype=settlement&q=" + encodeURIComponent(q));
  const out = (await r.json()).map(x => { const a = x.address || {}, c = a.city || a.town || a.village || a.municipality || a.county || x.name, reg = a["ISO3166-2-lvl4"] && a.country_code === "br" ? a["ISO3166-2-lvl4"].split("-")[1] : (a.state && a.country_code !== "br" ? a.country : a.country); return { nome: c + ", " + (reg || a.country || ""), lat: +x.lat, lon: +x.lon }; });
  const uniq = [...new Map(out.map(o => [o.nome, o])).values()]; cache.set(k, uniq); return uniq;
}

// ---------- Clima (Open-Meteo, gratuito, sem chave) ----------
async function clima(cidade, ini, fim) {
  const k = `w:${cidade}:${ini}:${fim}`; if (cache.has(k)) return cache.get(k);
  const p = (await places(cidade))[0]; if (!p) return [];
  const j = await (await get(`https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&start_date=${ini}&end_date=${fim}`)).json();
  const d = j.daily; const out = d ? d.time.map((t, i) => ({ dia: t, max: d.temperature_2m_max[i], min: d.temperature_2m_min[i], chuva: d.precipitation_probability_max[i] })) : [];
  cache.set(k, out); return out; // só há previsão para ~16 dias à frente
}


// ---------- Restaurantes (OpenStreetMap / Overpass, gratuito, sem chave) ----------
const COZ = { brazilian: "Brasileira", regional: "Regional", italian: "Italiana", pizza: "Pizza", burger: "Hambúrguer", steak_house: "Carnes", barbecue: "Churrasco", japanese: "Japonesa", sushi: "Sushi", german: "Alemã", fondue: "Fondue", chinese: "Chinesa", french: "Francesa", mexican: "Mexicana", seafood: "Frutos do mar", fish: "Peixes", coffee_shop: "Café", vegetarian: "Vegetariana", vegan: "Vegana", international: "Internacional", portuguese: "Portuguesa", spanish: "Espanhola", arab: "Árabe", lebanese: "Libanesa", sandwich: "Sanduíches", ice_cream: "Sorvetes", chocolate: "Chocolate", bakery: "Padaria", pasta: "Massas", thai: "Tailandesa", indian: "Indiana", peruvian: "Peruana", argentinian: "Argentina" };
const TIPO = { restaurant: ["restaurant", "Restaurante"], cafe: ["cafe", "Café"], bar: ["bar", "Bar"], pub: ["bar", "Pub"] };
const hav = (a, b, c, d) => { const r = x => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(h)); };
// ---------- Horário, faixa de preço e nota a partir do site (schema.org / JSON-LD) ----------
const PTDIA = { Mo: "Seg", Tu: "Ter", We: "Qua", Th: "Qui", Fr: "Sex", Sa: "Sáb", Su: "Dom", PH: "feriados", off: "fechado" };
const ptHoras = t => String(t || "").replace(/24\/7/g, "24 horas").replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH|off)\b/g, m => PTDIA[m]);
const DIAS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"], DEN = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const runs = idx => { idx = [...new Set(idx)].sort((a, b) => a - b); const o = []; for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++; o.push(j - i >= 2 ? DIAS[idx[i]] + "-" + DIAS[idx[j]] : idx.slice(i, j + 1).map(k => DIAS[k]).join(", ")); i = j + 1; } return o.join(", "); };
const hm = t => String(t || "").slice(0, 5);
function horasLd(o) {
  const spec = [].concat(o.openingHoursSpecification || []);
  if (spec.length) {
    const g = new Map();
    for (const sp of spec) {
      if (!sp || !sp.opens || !sp.closes) continue;
      const ds = [].concat(sp.dayOfWeek || []).map(d => DEN.indexOf(String(d).split("/").pop().toLowerCase())).filter(i => i >= 0);
      const key = hm(sp.opens) + "-" + hm(sp.closes); g.set(key, (g.get(key) || []).concat(ds));
    }
    const t = [...g].map(([k, ds]) => (runs(ds) + " " + k).trim()).join("; ");
    if (t) return t;
  }
  return ptHoras([].concat(o.openingHours || []).join("; "));
}
function faixaDe(p) {
  p = String(p || "").replace(/R\$/gi, "").trim(); if (!p) return "";
  const nums = (p.match(/\d+(?:[.,]\d+)?/g) || []).map(n => Number(n.replace(",", ".")));
  if (nums.length) { const m = nums.reduce((a, b) => a + b, 0) / nums.length; return m <= 40 ? "$" : m <= 80 ? "$$" : m <= 150 ? "$$$" : "$$$$"; }
  const c = (p.match(/\$/g) || []).length; return c ? "$".repeat(Math.min(c, 4)) : "";
}
function walkLd(n, out) { if (Array.isArray(n)) return n.forEach(x => walkLd(x, out)); if (n && typeof n === "object") { out.push(n); Object.values(n).forEach(v => { if (v && typeof v === "object") walkLd(v, out); }); } }
// ---------- Descoberta de links (site, Instagram, Tripadvisor...) e leitura de páginas do restaurante ----------
const semAcento = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const GENERICAS = /\b(pizzaria|restaurante|restaurant|bar|cafe|cafeteria|churrascaria|hamburgueria|lanchonete|bistro|trattoria|cantina|padaria|confeitaria|sorveteria|e)\b/g;
const slugNome = n => semAcento(n).replace(GENERICAS, " ").replace(/[^a-z0-9]/g, "");
const soAlfa = s => semAcento(s).replace(/[^a-z0-9]/g, "");
const nomeNoTexto = (txt, nome) => { const sl = slugNome(nome); return !sl || soAlfa(txt).includes(sl); };
const BUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const getMs = (u, ms) => fetch(u, { headers: { "User-Agent": BUA, "Accept-Language": "pt-BR,pt;q=0.9", "Accept": "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(ms), redirect: "follow" });

function parseDDG(html) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const h = (m[0].match(/href="([^"]+)"/) || [])[1]; if (!h) continue;
    let u = decode(h); const e = u.match(/[?&]uddg=([^&]+)/);
    if (e) { try { u = decodeURIComponent(e[1]); } catch {} }
    if (u.startsWith("//")) u = "https:" + u;
    if (/^https?:\/\//i.test(u) && !/duckduckgo\.com/.test(u)) out.push({ url: u, titulo: decode(m[1].replace(/<[^>]+>/g, "")).trim() });
  }
  return out;
}
function parseBing(html) {
  const out = [];
  for (const m of html.matchAll(/<li[^>]+class="b_algo"[\s\S]*?<h2[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let u = decode(m[1]); const b = u.match(/[?&]u=a1([^&]+)/);
    if (b) { try { u = Buffer.from(b[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch {} }
    if (/^https?:\/\//i.test(u) && !/bing\.com/.test(u)) out.push({ url: u, titulo: decode(m[2].replace(/<[^>]+>/g, "")).trim() });
  }
  return out;
}
async function buscaWeb(q) {
  const k = "b:" + q; if (cache.has(k)) return cache.get(k);
  let r = [];
  try { const x = await getMs("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), 6000); if (x.ok) r = parseDDG(await x.text()); } catch {}
  if (!r.length) { try { const x = await getMs("https://www.bing.com/search?setlang=pt-BR&q=" + encodeURIComponent(q), 6000); if (x.ok) r = parseBing(await x.text()); } catch {} }
  if (r.length) cache.set(k, r);
  return r;
}
const AGREG = /(^|\.)(google|facebook|instagram|tripadvisor|ifood|yelp|youtube|tiktok|twitter|x|pinterest|booking|airbnb|waze|foursquare|restaurantguru|wikipedia|linkedin|olx|mercadolivre|reclameaqui|cardapioweb|menudino|rappi|ubereats|kekanto|guiamais|apontador|telelistas)\.[a-z.]+$/;
function classifica(url, nome) {
  let u; try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (/(^|\.)instagram\.com$/.test(host)) { const seg = u.pathname.split("/").filter(Boolean)[0]; return seg && !/^(p|reel|reels|explore|accounts|stories|tv|directory|popular|about|legal)$/i.test(seg) ? { tipo: "insta", url: "https://www.instagram.com/" + seg + "/" } : null; }
  if (/(^|\.)tripadvisor\./.test(host)) return /Restaurant_Review/.test(u.pathname) ? { tipo: "ta", url } : null;
  if (AGREG.test(host)) return null;
  const sl = slugNome(nome), hs = host.replace(/[^a-z0-9]/g, "");
  return { tipo: sl.length >= 4 && hs.includes(sl) ? "site" : "outro", url };
}
async function descobrir(nome, cidade) {
  const k = `d:${nome}:${cidade}`; if (cache.has(k)) return cache.get(k);
  const cid = String(cidade || "").split(",")[0].trim();
  const [a, b] = await Promise.all([buscaWeb(`"${nome}" ${cid}`), buscaWeb(`${nome} ${cid} instagram tripadvisor`)]);
  const out = { site: "", insta: "", extra: "", ta: "", outros: [] }, sl = slugNome(nome), vistos = new Set();
  for (const r of [...a, ...b]) {
    const c = classifica(r.url, nome); if (!c || vistos.has(c.url)) continue; vistos.add(c.url);
    const ok = !sl || soAlfa(r.titulo + " " + c.url).includes(sl);
    if (c.tipo === "site" && !out.site) out.site = c.url;
    else if (c.tipo === "insta" && ok && !out.insta) out.insta = c.url;
    else if (c.tipo === "ta" && ok && !out.ta) out.ta = c.url;
    else if (c.tipo === "outro" && ok && out.outros.length < 3) out.outros.push({ url: c.url, titulo: r.titulo.slice(0, 90) });
  }
  out.extra = (out.outros[0] && out.outros[0].url) || out.ta;
  if (out.site || out.insta || out.extra) cache.set(k, out);
  return out;
}

const DIAW = "(?:segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)(?:-feira|s)?";
const DIAR = `${DIAW}(?:\\s*(?:a|à|às|até|e|-|–)\\s*${DIAW})?`;
const RE_HORA = new RegExp(`((?:todos os dias|diariamente|de ${DIAR}|${DIAR})[^.\\n]{0,40}?\\d{1,2}\\s?(?:h|:\\d{2})\\d{0,2}[^.\\n]{0,20}?\\d{1,2}\\s?(?:h|:\\d{2})\\d{0,2})`, "i");
const RE_PRECO = /(?:ticket m[ée]dio|pre[cç]o m[ée]dio|valor m[ée]dio|rod[ií]zio|por pessoa|a partir de)[^.|]{0,40}?R\$\s?\d[\d.,]*|R\$\s?\d[\d.,]*\s*(?:por pessoa|p\/\s?pessoa|\/\s?pessoa)/i;
function notaTxt(t) {
  const m = t.match(/\b([0-4][.,]\d|5[.,]0)\s*(?:\/\s*5|de\s*5)\b/i) || t.match(/(?:nota|avalia[çc][ãa]o|rating)[^\d]{0,15}([0-4][.,]\d|5[.,]0)\b/i);
  return m ? String(Number(m[1].replace(",", "."))) : "";
}
function extractPage(html, href) {
  const o = { faixa: "", horario: "", avaliacao: "", categoria: "", precoTxt: "", foto: "" }, nodes = [];
  for (const m of html.matchAll(/<script[^>]+ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) { try { walkLd(JSON.parse(m[1]), nodes); } catch {} }
  for (const n of nodes) {
    if (!o.faixa && n.priceRange) o.faixa = faixaDe(n.priceRange);
    if (!o.horario && (n.openingHoursSpecification || n.openingHours)) o.horario = horasLd(n);
    const rv = n.aggregateRating && Number(String(n.aggregateRating.ratingValue).replace(",", "."));
    if (!o.avaliacao && rv > 0 && rv <= 5) o.avaliacao = String(rv);
    if (!o.categoria && n.servesCuisine) o.categoria = [].concat(n.servesCuisine).map(String).slice(0, 2).join(", ");
    if (!o.foto && n.image) { const im = [].concat(n.image)[0], u = typeof im === "string" ? im : im && im.url; if (u) o.foto = u; }
  }
  const og = meta(html, "og:image") || meta(html, "twitter:image"); if (og) o.foto = og;
  if (o.foto) { try { o.foto = new URL(o.foto, href).href; } catch { o.foto = ""; } }
  const txt = decode(meta(html, "og:description") + " " + meta(html, "description") + " " + html.slice(0, 1.5e6).replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  if (!o.horario) { const m = txt.match(RE_HORA); if (m) o.horario = m[1].trim().slice(0, 120); }
  if (!o.avaliacao) o.avaliacao = notaTxt(txt);
  if (!o.faixa || !o.precoTxt) { const m = txt.match(RE_PRECO); if (m) { if (!o.precoTxt) o.precoTxt = m[0].trim().slice(0, 80); if (!o.faixa) o.faixa = faixaDe((m[0].match(/R\$\s?\d[\d.,]*/g) || []).join(" ")); } }
  o.txt = txt;
  return o;
}
// urls em ordem de prioridade; chk=true exige que o nome do restaurante apareça na página (links descobertos pela busca)
async function restInfo(urls, nome, chk) {
  const k = "i:" + [nome, chk ? 1 : 0, ...urls].join("|"); if (cache.has(k)) return cache.get(k);
  const pages = await Promise.all(urls.map(async raw => {
    try {
      const href = await safeUrl(raw), r = await getMs(href, 7000);
      if (!r.ok || !(r.headers.get("content-type") || "").includes("text/html")) return null;
      const o = extractPage((await r.text()).slice(0, 2e6), href);
      if (chk && !nomeNoTexto(o.txt, nome)) return null;
      o.host = new URL(href).hostname.replace(/^www\./, ""); return o;
    } catch { return null; }
  }));
  const out = { faixa: "", horario: "", avaliacao: "", categoria: "", precoTxt: "", fotos: [], fonte: "" }, fontes = [];
  for (const o of pages) {
    if (!o) continue; let got = false;
    for (const f of ["faixa", "horario", "avaliacao", "categoria", "precoTxt"]) if (!out[f] && o[f]) { out[f] = o[f]; got = true; }
    if (o.foto) { out.fotos.push(o.foto); got = true; }
    if (got) fontes.push(o.host);
  }
  out.fonte = [...new Set(fontes)].join(", ");
  if (out.fonte) cache.set(k, out);
  return out;
}
// ---------- Local de base: endereço, link do Google Maps ou coordenadas -> lat/lon ----------
const safeDec = s => { try { return decodeURIComponent(s); } catch { return s; } };
const coordsDeUrl = u => {
  const m = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || u.match(/[?&](?:q|ll|query|center|destination)=(-?\d+\.\d+),\s?(-?\d+\.\d+)/);
  return m ? { lat: +m[1], lon: +m[2] } : null;
};
const HOST_MAPS = /(^|\.)(google\.[a-z.]+|goo\.gl|g\.co)$/i;
const centroDe = (la, lo) => { const lat = parseFloat(la), lon = parseFloat(lo); return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null; };
async function geocode(qs) {
  qs = String(qs || "").trim(); if (qs.length < 3) return [];
  const par = qs.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (par) { const c = centroDe(par[1], par[2]); return c ? [{ nome: `Coordenadas ${par[1]}, ${par[2]}`, ...c }] : []; }
  if (/^https?:\/\//i.test(qs)) {
    const href = await safeUrl(qs); if (!HOST_MAPS.test(new URL(href).hostname)) return [];
    let fin = href, c = coordsDeUrl(safeDec(href));
    if (!c) { const r = await getMs(href, 6000); fin = r.url || href; c = coordsDeUrl(safeDec(fin)); }
    if (!c) return [];
    const pm = safeDec(fin).match(/\/maps\/place\/([^/@?]+)/);
    return [{ nome: pm ? pm[1].replace(/\+/g, " ") : "Local do mapa", ...c }];
  }
  const k = "g:" + qs.toLowerCase(); if (cache.has(k)) return cache.get(k);
  const r = await get("https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&q=" + encodeURIComponent(qs));
  const out = (await r.json()).map(x => {
    const a = x.address || {}, rua = a.road && (a.road + (a.house_number ? ", " + a.house_number : ""));
    const nome = [x.name && x.name !== a.road ? x.name : "", rua, a.suburb || a.neighbourhood, a.city || a.town || a.village || a.municipality].filter(Boolean).join(" · ") || String(x.display_name || "").split(",").slice(0, 3).join(",");
    return { nome, lat: +x.lat, lon: +x.lon };
  });
  cache.set(k, out); return out;
}
const CATKEYS = { "Pizza":"pizza","Hambúrguer":"burger","Carnes e churrasco":"steak_house|barbecue","Italiana":"italian|pasta","Massas":"pasta","Japonesa":"japanese|sushi","Fondue":"fondue","Alemã":"german","Frutos do mar":"seafood|fish","Vegetariana":"vegetarian|vegan","Brasileira":"brazilian|regional" };
const ACC = { a: "[aàáâãä]", e: "[eéèêë]", i: "[iíìîï]", o: "[oóòôõö]", u: "[uúùûü]", c: "[cç]", n: "[nñ]" };
// Nome digitado -> padrão que ignora maiúsculas e acentos (só letras, números, espaço, ' e -)
const nomeRe = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 '-]/g, "").trim().slice(0, 60).replace(/[aeioucn]/g, ch => ACC[ch]);
async function restaurantes(cidade, raio, cat, nome, centro) {
  raio = Math.min(Math.max(+raio || 4000, 1000), 16000);
  const nre = nomeRe(nome);
  const k = `r:${cidade}:${raio}:${cat || ""}:${nre}:${centro ? centro.lat.toFixed(4) + "," + centro.lon.toFixed(4) : ""}`; if (cache.has(k)) return cache.get(k);
  const c = centro || (await places(cidade))[0]; if (!c) return [];
  let filtro = '["amenity"~"^(restaurant|cafe|bar|pub)$"]';
  if (cat === "Café") filtro = '["amenity"="cafe"]';
  else if (cat === "Bar") filtro = '["amenity"~"^(bar|pub)$"]';
  else if (CATKEYS[cat]) filtro += `["cuisine"~"${CATKEYS[cat]}"]`;
  const qy = `[out:json][timeout:25];nwr${filtro}${nre ? `["name"~"${nre}",i]` : '["name"]'}(around:${raio},${c.lat},${c.lon});out center ${raio > 8000 ? 800 : 400};`;
  const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(qy), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("O serviço de mapas está ocupado. Tente de novo em instantes.");
  const j = await r.json();
  const out = (j.elements || []).map(e => {
    const g = e.tags || {}, lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon; if (lat == null || !g.name) return null;
    const [t, tipo] = TIPO[g.amenity] || ["restaurant", "Restaurante"];
    const coz = (g.cuisine || "").split(";").map(x => COZ[x.trim()] || "").filter(Boolean).slice(0, 2).join(", ");
    const end = [g["addr:street"] && (g["addr:street"] + (g["addr:housenumber"] ? ", " + g["addr:housenumber"] : "")), g["addr:suburb"]].filter(Boolean).join(" · ");
    let site = g.website || g["contact:website"] || ""; if (site && !/^https?:\/\//i.test(site)) site = "https://" + site;
    const score = (coz ? 2 : 0) + (site ? 2 : 0) + (g.opening_hours ? 1 : 0) + (g.phone || g["contact:phone"] ? 1 : 0) + (t === "restaurant" ? 1 : 0);
    const ig = g["contact:instagram"] || g.instagram || "";
    const insta = ig ? (/^https?:/.test(ig) ? ig : "https://instagram.com/" + ig.replace(/^@/, "")) : "";
    const maps = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent([g.name, g["addr:street"], cidade].filter(Boolean).join(" "));
    return { nome: g.name, t, tipo, coz, end, site, insta, maps, horario: ptHoras(g.opening_hours || ""), tel: g.phone || g["contact:phone"] || "", dist: Math.round(hav(c.lat, c.lon, lat, lon)), score };
  }).filter(Boolean);
  const uniq = [...new Map(out.map(o => [o.nome.toLowerCase() + o.end, o])).values()].sort((a, b) => b.score - a.score || a.dist - b.dist).slice(0, 60).map(({ score, ...o }) => o);
  cache.set(k, uniq); return uniq;
}

// ---------- Exportar para calendário (.ics) ----------
function ics(t) {
  const d = s => s.replace(/-/g, ""), add = (s, n) => { const x = new Date(s + "T12:00:00"); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  const esc = s => String(s || "").replace(/[\\;,]/g, m => "\\" + m).replace(/\n/g, "\\n");
  const ev = (t.items || []).filter(x => x.dia && (!["hosp", "carro", "comer"].includes(x.cat) || x.escolhida)).map(x => ["BEGIN:VEVENT", "UID:" + x.id + "@planejador", "DTSTAMP:" + new Date().toISOString().replace(/[-:]|\.\d+/g, ""), "DTSTART;VALUE=DATE:" + d(x.dia), "DTEND;VALUE=DATE:" + d(x.fim || add(x.dia, 1)), "SUMMARY:" + esc(x.nome), "DESCRIPTION:" + esc([x.preco ? "R$ " + x.preco : "", x.ret ? "Retirada: " + x.ret : "", x.dev && x.dev !== x.ret ? "Devolução: " + x.dev : "", x.nota, x.link].filter(Boolean).join("\n")), "END:VEVENT"].join("\r\n"));
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Planejador//PT", "X-WR-CALNAME:" + esc(t.dest || "Viagem"), ...ev, "END:VCALENDAR"].join("\r\n");
}

// ---------- Rotas ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  try {
    if (TOKEN && p.startsWith("/api/") && req.headers["x-token"] !== TOKEN && u.searchParams.get("token") !== TOKEN) return send(res, 401, { erro: "não autorizado" });
    if (p === "/" || p === "/index.html") return send(res, 200, fs.readFileSync(path.join(__dirname, "public", "index.html")), "text/html; charset=utf-8");
    if (p.startsWith("/uploads/")) { const f = path.join(UP, path.basename(p)); return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f), { jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[f.split(".").pop()] || "application/octet-stream", { "Cache-Control": "public, max-age=31536000" }) : send(res, 404, { erro: "não encontrado" }); }
    if (p === "/api/trips" && req.method === "GET") return send(res, 200, Object.entries(loadAll()).map(resumo));
    const mt = p.match(/^\/api\/trips\/([^/]+)$/);
    if (mt) {
      const id = decodeURIComponent(mt[1]); if (!okId(id)) return send(res, 400, { erro: "id inválido" });
      const all = loadAll();
      if (req.method === "GET") return all[id] ? send(res, 200, all[id]) : send(res, 404, { erro: "viagem não encontrada" });
      if (req.method === "PUT") { const t = JSON.parse(await readBody(req)); if (!t || typeof t !== "object" || !Array.isArray(t.items)) return send(res, 400, { erro: "formato inválido" }); all[id] = t; saveAll(all); return send(res, 200, { ok: true }); }
      if (req.method === "DELETE") { delete all[id]; saveAll(all); return send(res, 200, { ok: true }); }
      return send(res, 405, { erro: "método não permitido" });
    }
    if (p === "/api/preview") {
  const url = u.searchParams.get("url") || "";

  if (!url) {
    return send(res, 400, {
      erro: "URL não informada"
    });
  }

  try {
    const dados = await preview(url);

    return send(res, 200, dados);
  } catch (e) {
    return send(res, 400, {
      erro: e.message || "Não foi possível processar o link"
    });
  }
}
    if (p === "/api/geocode") return send(res, 200, await geocode(u.searchParams.get("q") || "").catch(() => []));
    if (p === "/api/descobrir") { const n = (u.searchParams.get("nome") || "").trim(); if (n.length < 2) return send(res, 400, { erro: "Nome não informado" }); return send(res, 200, await descobrir(n, u.searchParams.get("cidade") || "").catch(() => ({ site: "", insta: "", extra: "", ta: "", outros: [] }))); }
    if (p === "/api/restinfo") { const l = ["site", "extra", "insta"].map(k => u.searchParams.get(k) || "").filter(x => /^https?:\/\//i.test(x)); const d = l.length ? { ...(await restInfo(l, u.searchParams.get("nome") || "", u.searchParams.get("chk") === "1")) } : { faixa: "", horario: "", avaliacao: "", categoria: "", precoTxt: "", fotos: [], fonte: "" }; d.foto = ""; for (const f of d.fotos) { try { d.foto = await baixarFoto(f); break; } catch {} } delete d.fotos; return send(res, 200, d); }
    if (p === "/api/foto") { const f = new URL(u.searchParams.get("url") || ""); if (f.hostname !== "storage.googleapis.com" || !f.pathname.startsWith("/movida-public-images/")) return send(res, 400, { erro: "origem não permitida" }); return send(res, 200, { foto: await baixarFoto(f.href) }); }
    if (p === "/api/restaurants") { const c = (u.searchParams.get("city") || "").trim(); if (c.length < 3) return send(res, 400, { erro: "Cidade não informada" }); try { return send(res, 200, await restaurantes(c, u.searchParams.get("r"), u.searchParams.get("cat"), u.searchParams.get("nome"), centroDe(u.searchParams.get("lat"), u.searchParams.get("lon")))); } catch (e) { return send(res, 502, { erro: e.message || "Não foi possível buscar restaurantes agora." }); } }
    if (p === "/api/places") { const q = (u.searchParams.get("q") || "").trim(); return send(res, 200, q.length < 3 ? [] : await places(q)); }
    if (p === "/api/weather") { const c = (u.searchParams.get("cities") || "").split("|").filter(Boolean), out = {}; for (const x of c) out[x] = await clima(x, u.searchParams.get("ini"), u.searchParams.get("fim")).catch(() => []); return send(res, 200, out); }
    if (p === "/api/calendar.ics") { const all = loadAll(), id = u.searchParams.get("id"); if (!okId(id) || !all[id]) return send(res, 404, { erro: "viagem não encontrada" }); return send(res, 200, ics(all[id]), "text/calendar; charset=utf-8", { "Content-Disposition": 'attachment; filename="viagem.ics"' }); }
    if (p === "/api/backup") return send(res, 200, fs.existsSync(DB) ? fs.readFileSync(DB) : "{}", "application/json", { "Content-Disposition": 'attachment; filename="viagem-backup.json"' });
    send(res, 404, { erro: "rota não encontrada" });
  } catch (e) { send(res, 500, { erro: e.message }); }
});
if (require.main === module) server.listen(PORT, () => console.log("Planejador rodando em http://localhost:" + PORT));
module.exports = { parseHtml, faixaDe, horasLd, ptHoras, parseDDG, parseBing, classifica, extractPage, descobrir, restInfo, geocode, coordsDeUrl, centroDe };
