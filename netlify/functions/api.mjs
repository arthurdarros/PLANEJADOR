import dns from "node:dns/promises";
import net from "node:net";
import crypto from "node:crypto";

const UA = "PlanejadorViagem/1.0 (uso pessoal)";
const TOKEN = process.env.APP_TOKEN || "";

const cache = new Map();

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers
    },
    body:
      typeof body === "string"
        ? body
        : JSON.stringify(body)
  };
}

async function get(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      "User-Agent": UA,
      "Accept-Language": "pt-BR,pt;q=0.9",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(8000),
    redirect: "follow"
  });
}

// --------------------------------------------------
// Segurança contra SSRF
// --------------------------------------------------

async function safeUrl(value) {
  const url = new URL(value);

  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("URL inválida");
  }

  const { address } = await dns.lookup(url.hostname);

  const privateIPv4 =
    net.isIP(address) === 4 &&
    /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
      .test(address);

  const privateIPv6 =
    /^(::1|fc|fd|fe80)/i.test(address);

  if (privateIPv4 || privateIPv6) {
    throw new Error("Endereço não permitido");
  }

  return url.href;
}

// --------------------------------------------------
// HTML / metadata
// --------------------------------------------------

function decode(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function meta(html, key) {
  const a =
    html.match(
      new RegExp(
        `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`,
        "i"
      )
    );

  const b =
    html.match(
      new RegExp(
        `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`,
        "i"
      )
    );

  return a
    ? decode(a[1])
    : b
      ? decode(b[1])
      : "";
}

function parseHtml(html, href) {
  const url = new URL(href);
  const search = url.searchParams;
  const airbnb = /airbnb\./.test(url.hostname);

  const title =
    decode(
      meta(html, "og:title") ||
      meta(html, "twitter:title") ||
      ((html.match(/<title[^>]*>([^<]*)/i) || [])[1] || "").trim()
    );

  const twitterTitle = decode(
    meta(html, "twitter:title") ||
      ((html.match(/<title[^>]*>([^<]*)/i) || [])[1] || "")
  );

  const parts = twitterTitle
    .split(" - ")
    .map(x => x.trim())
    .filter(x => x && x !== "Airbnb");

  if (parts.length > 1) {
    parts.pop();
  }

  const parsedTitle = parts.join(" - ");

  let nome = title;
  let nota = "";
  let cidade = "";

  if (airbnb) {
    const p = title
      .split(" · ")
      .map(x => x.trim());

    if (p.length >= 3) {
      nome =
        meta(html, "og:description") ||
        parsedTitle;

      cidade = p[1];

      nota = [
        p[0],
        ...p.slice(2)
      ].join(" · ");
    } else {
      nome = parsedTitle || title;
    }

    if (!cidade) {
      cidade =
        (
          decode(
            html.match(/<title[^>]*>([^<]*)/i)?.[1] || ""
          ).match(/ em ([^,]+),/) || []
        )[1] || "";
    }
  }

  if (nome === "Airbnb") {
    nome = "";
  }

  let preco =
    meta(html, "og:price:amount") ||
    meta(html, "product:price:amount");

  if (!preco) {
    for (
      const match of html.matchAll(
        /<script[^>]+ld\+json[^>]*>([\s\S]*?)<\/script>/gi
      )
    ) {
      const value =
        (
          match[1].match(
            /"price"\s*:\s*"?([\d.,]+)/
          ) || []
        )[1];

      if (value) {
        preco = value;
        break;
      }
    }
  }

  if (preco) {
    preco = String(
      Number(
        preco.includes(",")
          ? preco.replace(/\./g, "").replace(",", ".")
          : preco
      ) || ""
    );
  }

  const date = key => {
    const value =
      search.get(key) ||
      search.get(key.replace("_", "")) ||
      "";

    return /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : "";
  };

  const hour =
    decode(html).match(
      /a partir das (\d{1,2})(?:h|:(\d{2}))/i
    );

  const hin =
    hour && +hour[1] < 24
      ? String(hour[1]).padStart(2, "0") +
        ":" +
        (hour[2] || "00")
      : "";

  return {
    nome: nome.trim(),
    preco,
    nota,
    cidade,
    ci: date("check_in"),
    co: date("check_out"),
    hin,
    fotoUrl:
      meta(html, "og:image") ||
      meta(html, "twitter:image")
  };
}

// --------------------------------------------------
// Foto
// --------------------------------------------------

async function baixarFoto(url) {
  await safeUrl(url);

  const response = await get(url);

  const contentType =
    response.headers.get("content-type") || "";

  const extension = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp"
  }[contentType.split(";")[0]];

  if (!extension) {
    throw new Error("tipo");
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  if (buffer.length > 4e6) {
    throw new Error("grande");
  }

  /*
   * IMPORTANTE:
   * No Netlify não vamos salvar essa imagem
   * permanentemente no disco.
   *
   * Por enquanto retornamos a URL original.
   */
  return url;
}

// --------------------------------------------------
// Preview
// --------------------------------------------------

async function preview(raw) {
  const href = await safeUrl(raw);

  const result = await get(href);

  const html =
    (await result.text()).slice(0, 2e6);

  const data = parseHtml(html, raw);

  const fotoUrl = data.fotoUrl;

  delete data.fotoUrl;

  data.foto = "";

  if (fotoUrl) {
    try {
      data.foto =
        await baixarFoto(
          new URL(fotoUrl, href).href
        );
    } catch {}
  }

  return data;
}

// --------------------------------------------------
// Cidades
// --------------------------------------------------

async function places(query) {
  const key =
    "p:" + query.toLowerCase();

  if (cache.has(key)) {
    return cache.get(key);
  }

  const url =
    "https://nominatim.openstreetmap.org/search?" +
    "format=json" +
    "&addressdetails=1" +
    "&limit=6" +
    "&featuretype=settlement" +
    "&q=" +
    encodeURIComponent(query);

  const result = await get(url);

  const json = await result.json();

  const output = json.map(item => {
    const address = item.address || {};

    const city =
      address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      address.county ||
      item.name;

    const region =
      address["ISO3166-2-lvl4"] &&
      address.country_code === "br"
        ? address["ISO3166-2-lvl4"].split("-")[1]
        : (
            address.state &&
            address.country_code !== "br"
              ? address.country
              : address.country
          );

    return {
      nome:
        city +
        ", " +
        (region || ""),
      lat: +item.lat,
      lon: +item.lon
    };
  });

  const unique =
    [...new Map(
      output.map(item => [
        item.nome,
        item
      ])
    ).values()];

  cache.set(key, unique);

  return unique;
}

// --------------------------------------------------
// Clima
// --------------------------------------------------

async function clima(cidade, inicio, fim) {
  const key =
    `w:${cidade}:${inicio}:${fim}`;

  if (cache.has(key)) {
    return cache.get(key);
  }

  const placesResult =
    await places(cidade);

  const place = placesResult[0];

  if (!place) {
    return [];
  }

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${place.lat}` +
    `&longitude=${place.lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=auto` +
    `&start_date=${inicio}` +
    `&end_date=${fim}`;

  const result = await get(url);

  const json = await result.json();

  const daily = json.daily;

  const output = daily
    ? daily.time.map((date, index) => ({
        dia: date,
        max:
          daily.temperature_2m_max[index],
        min:
          daily.temperature_2m_min[index],
        chuva:
          daily.precipitation_probability_max[index]
      }))
    : [];

  cache.set(key, output);

  return output;
}

// --------------------------------------------------
// Calendário
// --------------------------------------------------

function ics(trip) {
  const date = value =>
    value.replace(/-/g, "");

  const addDay = (value, amount) => {
    const d =
      new Date(value + "T12:00:00");

    d.setDate(
      d.getDate() + amount
    );

    return d
      .toISOString()
      .slice(0, 10);
  };

  const escape = value =>
    String(value || "")
      .replace(
        /[\\;,]/g,
        match => "\\" + match
      )
      .replace(/\n/g, "\\n");

  const events =
    (trip.items || [])
      .filter(
        item =>
          item.dia &&
          (
            !["hosp", "carro"]
              .includes(item.cat) ||
            item.escolhida
          )
      )
      .map(item =>
        [
          "BEGIN:VEVENT",
          "UID:" +
            item.id +
            "@planejador",
          "DTSTAMP:" +
            new Date()
              .toISOString()
              .replace(
                /[-:]|\.\d+/g,
                ""
              ),
          "DTSTART;VALUE=DATE:" +
            date(item.dia),
          "DTEND;VALUE=DATE:" +
            date(
              item.fim ||
              addDay(item.dia, 1)
            ),
          "SUMMARY:" +
            escape(item.nome),
          "DESCRIPTION:" +
            escape(
              [
                item.preco
                  ? "R$ " + item.preco
                  : "",
                item.ret
                  ? "Retirada: " +
                    item.ret
                  : "",
                item.dev &&
                item.dev !== item.ret
                  ? "Devolução: " +
                    item.dev
                  : "",
                item.nota,
                item.link
              ]
                .filter(Boolean)
                .join("\n")
            ),
          "END:VEVENT"
        ].join("\r\n")
      );

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Planejador//PT",
    "X-WR-CALNAME:" +
      escape(trip.dest || "Viagem"),
    ...events,
    "END:VCALENDAR"
  ].join("\r\n");
}

// --------------------------------------------------
// Handler principal
// --------------------------------------------------

export async function handler(event) {
  try {
    const path =
      event.path || "";

    const query =
      event.queryStringParameters || {};

    // Token opcional
    if (
      TOKEN &&
      path.startsWith("/api/") &&
      event.headers?.["x-token"] !== TOKEN &&
      query.token !== TOKEN
    ) {
      return response(
        401,
        { erro: "não autorizado" }
      );
    }

    // --------------------------------------------
    // PREVIEW
    // --------------------------------------------

    if (path === "/api/preview") {
      const url = query.url || "";

      if (!url) {
        return response(
          400,
          { erro: "URL não informada" }
        );
      }

      return response(
        200,
        await preview(url)
      );
    }

    // --------------------------------------------
    // PLACES
    // --------------------------------------------

    if (path === "/api/places") {
      const q =
        (query.q || "").trim();

      return response(
        200,
        q.length < 3
          ? []
          : await places(q)
      );
    }

    // --------------------------------------------
    // WEATHER
    // --------------------------------------------

    if (path === "/api/weather") {
      const cities =
        (query.cities || "")
          .split("|")
          .filter(Boolean);

      const output = {};

      for (const city of cities) {
        output[city] =
          await clima(
            city,
            query.ini,
            query.fim
          ).catch(() => []);
      }

      return response(
        200,
        output
      );
    }

    // --------------------------------------------
    // CALENDAR
    // --------------------------------------------

    if (
      path === "/api/calendar.ics"
    ) {
      /*
       * Nesta primeira versão,
       * a persistência ainda será ajustada.
       */
      return response(
        501,
        {
          erro:
            "Calendário será conectado ao armazenamento na próxima etapa."
        }
      );
    }

    // --------------------------------------------
    // TRIP
    // --------------------------------------------

    if (
      path === "/api/trip"
    ) {
      return response(
        501,
        {
          erro:
            "Armazenamento da viagem será conectado na próxima etapa."
        }
      );
    }

    // --------------------------------------------
    // BACKUP
    // --------------------------------------------

    if (
      path === "/api/backup"
    ) {
      return response(
        501,
        {
          erro:
            "Backup será conectado ao armazenamento na próxima etapa."
        }
      );
    }

    // --------------------------------------------
    // FOTO
    // --------------------------------------------

    if (
      path === "/api/foto"
    ) {
      const url =
        query.url || "";

      const parsed =
        new URL(url);

      if (
        parsed.hostname !==
          "storage.googleapis.com" ||
        !parsed.pathname.startsWith(
          "/movida-public-images/"
        )
      ) {
        return response(
          400,
          {
            erro:
              "origem não permitida"
          }
        );
      }

      return response(
        200,
        {
          foto:
            await baixarFoto(
              parsed.href
            )
        }
      );
    }

    return response(
      404,
      {
        erro:
          "rota não encontrada"
      }
    );

  } catch (error) {
    console.error(error);

    return response(
      500,
      {
        erro:
          error?.message ||
          "Erro interno"
      }
    );
  }
}