// Planejador de viagem - backend (Node 18+, zero dependências)
// Uso: node server.js   ->  http://localhost:3000
const http = require("http"), fs = require("fs"), path = require("path"), dns = require("dns").promises, net = require("net"), crypto = require("crypto");
const PORT = process.env.PORT || 3000, TOKEN = process.env.APP_TOKEN || "";
const DATA = path.join(__dirname, "data"), UP = path.join(DATA, "uploads"), DB = path.join(DATA, "trip.json");
fs.mkdirSync(UP, { recursive: true });
const UA = "PlanejadorViagem/1.0 (uso pessoal)";
const cache = new Map(); // cache simples em memória

const send = (res, code, body, type = "application/json; charset=utf-8", extra = {}) => { res.writeHead(code, { "Content-Type": type, ...extra }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = req => new Promise((ok, no) => { let b = ""; req.on("data", c => { b += c; if (b.length > 5e6) { no(new Error("grande")); req.destroy(); } }); req.on("end", () => ok(b)); });
const get = async (u, opt = {}) => fetch(u, { ...opt, headers: { "User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9", ...(opt.headers || {}) }, signal: AbortSignal.timeout(8000), redirect: "follow" });

// ---------- Persistência (arquivo JSON, gravação atômica) ----------
const loadTrip = () => { try { return JSON.parse(fs.readFileSync(DB, "utf8")); } catch { return null; } };
const saveTrip = t => { fs.writeFileSync(DB + ".tmp", JSON.stringify(t)); fs.renameSync(DB + ".tmp", DB); };

// ---------- Segurança: bloqueia URLs para rede interna (SSRF) ----------
async function safeUrl(u) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error("URL inválida");
  const { address } = await dns.lookup(url.hostname);
  if (net.isIP(address) === 4 && /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) || /^(::1|fc|fd|fe80)/i.test(address)) throw new Error("Endereço não permitido");
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
  const href = await safeUrl(raw), r = await get(href), html = (await r.text()).slice(0, 2e6);
  const d = parseHtml(html, raw), fu = d.fotoUrl; delete d.fotoUrl;
  d.foto = ""; if (fu) { try { d.foto = await baixarFoto(new URL(fu, href).href); } catch {} }
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

// ---------- Exportar para calendário (.ics) ----------
function ics(t) {
  const d = s => s.replace(/-/g, ""), add = (s, n) => { const x = new Date(s + "T12:00:00"); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  const esc = s => String(s || "").replace(/[\\;,]/g, m => "\\" + m).replace(/\n/g, "\\n");
  const ev = (t.items || []).filter(x => x.dia && (!["hosp", "carro"].includes(x.cat) || x.escolhida)).map(x => ["BEGIN:VEVENT", "UID:" + x.id + "@planejador", "DTSTAMP:" + new Date().toISOString().replace(/[-:]|\.\d+/g, ""), "DTSTART;VALUE=DATE:" + d(x.dia), "DTEND;VALUE=DATE:" + d(x.fim || add(x.dia, 1)), "SUMMARY:" + esc(x.nome), "DESCRIPTION:" + esc([x.preco ? "R$ " + x.preco : "", x.ret ? "Retirada: " + x.ret : "", x.dev && x.dev !== x.ret ? "Devolução: " + x.dev : "", x.nota, x.link].filter(Boolean).join("\n")), "END:VEVENT"].join("\r\n"));
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Planejador//PT", "X-WR-CALNAME:" + esc(t.dest || "Viagem"), ...ev, "END:VCALENDAR"].join("\r\n");
}

// ---------- Rotas ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  try {
    if (TOKEN && p.startsWith("/api/") && req.headers["x-token"] !== TOKEN && u.searchParams.get("token") !== TOKEN) return send(res, 401, { erro: "não autorizado" });
    if (p === "/" || p === "/index.html") return send(res, 200, fs.readFileSync(path.join(__dirname, "public", "index.html")), "text/html; charset=utf-8");
    if (p.startsWith("/uploads/")) { const f = path.join(UP, path.basename(p)); return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f), { jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[f.split(".").pop()] || "application/octet-stream", { "Cache-Control": "public, max-age=31536000" }) : send(res, 404, { erro: "não encontrado" }); }
    if (p === "/api/trip" && req.method === "GET") return send(res, 200, loadTrip() || {});
    if (p === "/api/trip" && req.method === "PUT") { const t = JSON.parse(await readBody(req)); if (typeof t !== "object" || !Array.isArray(t.items)) return send(res, 400, { erro: "formato inválido" }); saveTrip(t); return send(res, 200, { ok: true }); }
    if (p === "/api/preview") return send(res, 200, await preview(u.searchParams.get("url") || ""));
    if (p === "/api/foto") { const f = new URL(u.searchParams.get("url") || ""); if (f.hostname !== "storage.googleapis.com" || !f.pathname.startsWith("/movida-public-images/")) return send(res, 400, { erro: "origem não permitida" }); return send(res, 200, { foto: await baixarFoto(f.href) }); }
    if (p === "/api/places") { const q = (u.searchParams.get("q") || "").trim(); return send(res, 200, q.length < 3 ? [] : await places(q)); }
    if (p === "/api/weather") { const c = (u.searchParams.get("cities") || "").split("|").filter(Boolean), out = {}; for (const x of c) out[x] = await clima(x, u.searchParams.get("ini"), u.searchParams.get("fim")).catch(() => []); return send(res, 200, out); }
    if (p === "/api/calendar.ics") return send(res, 200, ics(loadTrip() || {}), "text/calendar; charset=utf-8", { "Content-Disposition": 'attachment; filename="viagem.ics"' });
    if (p === "/api/backup") return send(res, 200, fs.existsSync(DB) ? fs.readFileSync(DB) : "{}", "application/json", { "Content-Disposition": 'attachment; filename="viagem-backup.json"' });
    send(res, 404, { erro: "rota não encontrada" });
  } catch (e) { send(res, 500, { erro: e.message }); }
});
if (require.main === module) server.listen(PORT, () => console.log("Planejador rodando em http://localhost:" + PORT));
module.exports = { parseHtml };
