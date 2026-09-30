// Planejador de viagem - função Netlify (API)
// Persistência: Netlify Blobs (viagens e fotos). Sem disco, sem servidor contínuo.
import dns from "node:dns/promises";
import net from "node:net";
import crypto from "node:crypto";
import { connectLambda, getStore } from "@netlify/blobs";

const UA = "PlanejadorViagem/1.0 (uso pessoal)";
const TOKEN = process.env.APP_TOKEN || "";
const cache = new Map(); // cache simples em memória (por instância)

const get = async (u, opt = {}) => fetch(u, { ...opt, headers: { "User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9", ...(opt.headers || {}) }, signal: AbortSignal.timeout(8000), redirect: "follow" });

// ---------- Armazenamento (Netlify Blobs) ----------
const okId = id => /^\d{1,20}$/.test(id || "");
const counted = t => (t.items || []).filter(x => !["hosp", "carro", "comer"].includes(x.cat) || x.escolhida);
const resumo = ([id, t]) => ({ id, dest: t.dest || "", ini: t.ini || "", fim: t.fim || "", cities: t.cities || (t.dest ? [t.dest] : []), count: (t.items || []).length, total: counted(t).reduce((s, x) => s + (Number(x.preco) || 0), 0) });
const validTrip = t => t && typeof t === "object" && !Array.isArray(t) && Array.isArray(t.items);
async function loadAll(S) {
  const { blobs } = await S.trips.list(), out = {};
  await Promise.all(blobs.map(async b => { const t = await S.trips.get(b.key, { type: "json" }); if (t) out[b.key] = t; }));
  return out;
}

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

// ---------- Preview de link e fotos ----------
async function baixarFoto(S, u) {
  await safeUrl(u);
  const r = await get(u), ct = r.headers.get("content-type") || "", ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[ct.split(";")[0]];
  if (!ext) throw new Error("tipo");
  const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 4e6) throw new Error("grande");
  const nome = crypto.createHash("md5").update(buf).digest("hex") + "." + ext;
  await S.fotos.set(nome, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return "/uploads/" + nome;
}
async function preview(S, raw) {
  if (!raw) throw new Error("URL não informada");
  const href = await safeUrl(raw), r = await get(href);
  if (!r.ok) throw new Error("Não foi possível acessar o link");
  if (!(r.headers.get("content-type") || "").includes("text/html")) throw new Error("O link não é uma página HTML");
  const html = (await r.text()).slice(0, 2e6), d = parseHtml(html, href), fu = d.fotoUrl;
  delete d.fotoUrl; d.foto = "";
  if (fu) { try { d.foto = await baixarFoto(S, new URL(fu, href).href); } catch (e) { console.error("Erro ao baixar imagem:", e.message); } }
  return d;
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
async function restInfo(urls) {
  const k = "i:" + urls.join("|"); if (cache.has(k)) return cache.get(k);
  const out = { faixa: "", horario: "", avaliacao: "", fonte: "" };
  for (const raw of urls) {
    if (out.faixa && out.horario && out.avaliacao) break;
    try {
      const href = await safeUrl(raw), r = await get(href);
      if (!r.ok || !(r.headers.get("content-type") || "").includes("text/html")) continue;
      const html = (await r.text()).slice(0, 2e6), nodes = []; let got = false;
      for (const m of html.matchAll(/<script[^>]+ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) { try { walkLd(JSON.parse(m[1]), nodes); } catch {} }
      for (const o of nodes) {
        if (!out.faixa && o.priceRange) { out.faixa = faixaDe(o.priceRange); got = got || !!out.faixa; }
        if (!out.horario && (o.openingHoursSpecification || o.openingHours)) { out.horario = horasLd(o); got = got || !!out.horario; }
        const rv = o.aggregateRating && Number(String(o.aggregateRating.ratingValue).replace(",", "."));
        if (!out.avaliacao && rv > 0 && rv <= 5) { out.avaliacao = String(rv); got = true; }
      }
      if (got && !out.fonte) out.fonte = new URL(href).hostname;
    } catch {}
  }
  if (out.fonte) cache.set(k, out);
  return out;
}
const CATKEYS = { "Pizza":"pizza","Hambúrguer":"burger","Carnes e churrasco":"steak_house|barbecue","Italiana":"italian|pasta","Massas":"pasta","Japonesa":"japanese|sushi","Fondue":"fondue","Alemã":"german","Frutos do mar":"seafood|fish","Vegetariana":"vegetarian|vegan","Brasileira":"brazilian|regional" };
async function restaurantes(cidade, raio, cat) {
  raio = Math.min(Math.max(+raio || 4000, 1000), 15000);
  const k = `r:${cidade}:${raio}:${cat || ""}`; if (cache.has(k)) return cache.get(k);
  const c = (await places(cidade))[0]; if (!c) return [];
  let filtro = '["amenity"~"^(restaurant|cafe|bar|pub)$"]';
  if (cat === "Café") filtro = '["amenity"="cafe"]';
  else if (cat === "Bar") filtro = '["amenity"~"^(bar|pub)$"]';
  else if (CATKEYS[cat]) filtro += `["cuisine"~"${CATKEYS[cat]}"]`;
  const qy = `[out:json][timeout:25];nwr${filtro}["name"](around:${raio},${c.lat},${c.lon});out center 400;`;
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
const H_JSON = "application/json; charset=utf-8";
const json = (code, body, extra = {}) => ({ statusCode: code, headers: { "Content-Type": H_JSON, ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });
const bin = (buf, type, extra = {}) => ({ statusCode: 200, headers: { "Content-Type": type, ...extra }, body: Buffer.from(buf).toString("base64"), isBase64Encoded: true });

export async function handler(event) {
  try {
    connectLambda(event);
    const S = { trips: getStore({ name: "trips", consistency: "strong" }), fotos: getStore({ name: "fotos", consistency: "strong" }) };
    const method = event.httpMethod || "GET", q = event.queryStringParameters || {}, hdr = event.headers || {};
    // Normaliza o caminho (o redirecionamento do Netlify pode entregar /.netlify/functions/api/...)
    let p = (event.path || "").replace(/^\/\.netlify\/functions\/api/, "");
    if (!p.startsWith("/api/") && !p.startsWith("/uploads/")) p = "/api" + (p.startsWith("/") ? p : "/" + p);
    const body = () => event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");

    if (TOKEN && p.startsWith("/api/") && hdr["x-token"] !== TOKEN && q.token !== TOKEN) return json(401, { erro: "não autorizado" });

    if (p.startsWith("/uploads/")) {
      const nome = p.split("/").pop(), ext = nome.split(".").pop();
      const r = /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(nome) ? await S.fotos.get(nome, { type: "arrayBuffer" }) : null;
      return r ? bin(r, { jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[ext], { "Cache-Control": "public, max-age=31536000, immutable" }) : json(404, { erro: "não encontrado" });
    }

    if (p === "/api/trips" && method === "GET") return json(200, Object.entries(await loadAll(S)).map(resumo));
    const mt = p.match(/^\/api\/trips\/([^/]+)$/);
    if (mt) {
      const id = decodeURIComponent(mt[1]); if (!okId(id)) return json(400, { erro: "id inválido" });
      if (method === "GET") { const t = await S.trips.get(id, { type: "json" }); return t ? json(200, t) : json(404, { erro: "viagem não encontrada" }); }
      if (method === "PUT") { let t; try { t = JSON.parse(body()); } catch { return json(400, { erro: "JSON inválido" }); } if (!validTrip(t)) return json(400, { erro: "formato inválido" }); await S.trips.setJSON(id, t); return json(200, { ok: true }); }
      if (method === "DELETE") { await S.trips.delete(id); return json(200, { ok: true }); }
      return json(405, { erro: "método não permitido" });
    }
    // Importa um backup (objeto { id: viagem }), ex.: o data/trips.json do seu computador
    if (p === "/api/import" && method === "POST") {
      let o; try { o = JSON.parse(body()); } catch { return json(400, { erro: "JSON inválido" }); }
      const ent = Object.entries(o || {}).filter(([id, t]) => okId(id) && validTrip(t));
      await Promise.all(ent.map(([id, t]) => S.trips.setJSON(id, t)));
      return json(200, { ok: true, importadas: ent.length });
    }
    if (p === "/api/preview") { const url = q.url || ""; if (!url) return json(400, { erro: "URL não informada" }); try { return json(200, await preview(S, url)); } catch (e) { return json(400, { erro: e.message || "Não foi possível processar o link" }); } }
    if (p === "/api/restinfo") { const l = ["site", "insta"].map(k => q[k] || "").filter(x => /^https?:\/\//i.test(x)); return json(200, l.length ? await restInfo(l) : { faixa: "", horario: "", avaliacao: "", fonte: "" }); }
    if (p === "/api/foto") { let f; try { f = new URL(q.url || ""); } catch { return json(400, { erro: "URL inválida" }); } if (f.hostname !== "storage.googleapis.com" || !f.pathname.startsWith("/movida-public-images/")) return json(400, { erro: "origem não permitida" }); return json(200, { foto: await baixarFoto(S, f.href) }); }
    if (p === "/api/restaurants") { const c = (q.city || "").trim(); if (c.length < 3) return json(400, { erro: "Cidade não informada" }); try { return json(200, await restaurantes(c, q.r, q.cat)); } catch (e) { return json(502, { erro: e.message || "Não foi possível buscar restaurantes agora." }); } }
    if (p === "/api/places") { const t = (q.q || "").trim(); return json(200, t.length < 3 ? [] : await places(t)); }
    if (p === "/api/weather") { const c = (q.cities || "").split("|").filter(Boolean), out = {}; for (const x of c) out[x] = await clima(x, q.ini, q.fim).catch(() => []); return json(200, out); }
    if (p === "/api/calendar.ics") { const id = q.id; const t = okId(id) ? await S.trips.get(id, { type: "json" }) : null; if (!t) return json(404, { erro: "viagem não encontrada" }); return json(200, ics(t), { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="viagem.ics"' }); }
    if (p === "/api/backup") return json(200, await loadAll(S), { "Content-Disposition": 'attachment; filename="viagem-backup.json"' });
    return json(404, { erro: "rota não encontrada" });
  } catch (e) {
    console.error(e);
    return json(500, { erro: e?.message || "Erro interno" });
  }
}
