export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  const radiusKm = clamp(parseFloat(url.searchParams.get("radius_km") ?? "3"), 0.5, 25);

  const intent = (url.searchParams.get("intent") || "residential").toLowerCase();
  const officeLat = parseFloat(url.searchParams.get("office_lat"));
  const officeLon = parseFloat(url.searchParams.get("office_lon"));

  const marketRate = parseFloat(url.searchParams.get("market_rate"));
  const guidelineRate = parseFloat(url.searchParams.get("guideline_rate"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: "Missing/invalid lat/lon" }, 400);
  }

  // Round coords to boost cache hits (and reduce load on public APIs)
  const latR = round(lat, 3);
  const lonR = round(lon, 3);

  const cache = caches.default;

  // Fetch signals (each is cached)
  const [place, overpassRaw, climate, soil] = await Promise.allSettled([
    reverseGeocodeNominatim(latR, lonR, cache),
    fetchOverpass(latR, lonR, Math.round(radiusKm * 1000), cache),
    fetchNasaPowerDaily(latR, lonR, cache),
    fetchSoilGrids(latR, lonR, cache),
  ]);

  const overpass = overpassRaw.status === "fulfilled" ? summarizeOverpass(overpassRaw.value) : null;

  const distanceKm = (Number.isFinite(officeLat) && Number.isFinite(officeLon))
    ? haversineKm(lat, lon, officeLat, officeLon)
    : null;

  const scoring = scoreIntent(intent, overpass, climate.status === "fulfilled" ? climate.value : null, distanceKm);

  // Price math (only if user provided at least one baseline)
  const base = pickBaseRate(marketRate, guidelineRate);
  const price = base
    ? priceFromScore(base, scoring.adjustmentPct)
    : null;

  // AI summary (optional: requires env.AI binding)
  const ai = await aiExplain(env, {
    intent, coords: { lat, lon }, radiusKm,
    place: place.status === "fulfilled" ? place.value : null,
    overpass,
    climate: climate.status === "fulfilled" ? climate.value : null,
    soil: soil.status === "fulfilled" ? soil.value : null,
    distanceKm,
    scoring,
    marketRate: Number.isFinite(marketRate) ? marketRate : null,
    guidelineRate: Number.isFinite(guidelineRate) ? guidelineRate : null,
    price,
  });

  return json({
    ok: true,
    coords: { lat, lon },
    radiusKm,
    intent,
    place: place.status === "fulfilled" ? place.value : { error: place.reason?.message || "reverse geocode failed" },
    overpass,
    climate: climate.status === "fulfilled" ? climate.value : { error: climate.reason?.message || "climate fetch failed" },
    soil: soil.status === "fulfilled" ? soil.value : { error: soil.reason?.message || "soil fetch failed" },
    distanceKm,
    scoring,
    price,
    ai,
    notes: [
      "This is an MVP using open/public sources. Validate with local due diligence.",
      "If you scale, add stronger caching + rate limiting to protect upstream services."
    ]
  });
}

// -------------------- Fetchers --------------------

async function reverseGeocodeNominatim(lat, lon, cache) {
  // Nominatim policy: max 1 req/sec, identify your app, cache results. :contentReference[oaicite:14]{index=14}
  const cacheKey = new Request(`https://cache.local/nominatim/rev?lat=${lat}&lon=${lon}`, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const apiUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
  const resp = await fetch(apiUrl, {
    headers: {
      "User-Agent": "LandAIIndiaMVP/1.0 (contact: you@example.com)",
      "Accept": "application/json"
    }
  });
  if (!resp.ok) throw new Error(`Nominatim ${resp.status}`);
  const data = await resp.json();

  const out = {
    display_name: data.display_name,
    address: data.address
  };

  await cache.put(cacheKey, jsonResponse(out, 7 * 24 * 3600)); // 7 days
  return out;
}

async function fetchOverpass(lat, lon, radiusM, cache) {
  const cacheKey = new Request(`https://cache.local/overpass?lat=${lat}&lon=${lon}&r=${radiusM}`, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const q = `
[out:json][timeout:25];
(
  nwr(around:${radiusM},${lat},${lon})["amenity"~"school|college|university|hospital|clinic|doctors|bank|marketplace"];
  nwr(around:${radiusM},${lat},${lon})["shop"~"supermarket|mall"];
  nwr(around:${radiusM},${lat},${lon})["landuse"~"industrial|commercial|retail|construction"];
  nwr(around:${radiusM},${lat},${lon})["highway"~"motorway|trunk|primary|secondary"];
  nwr(around:${radiusM},${lat},${lon})["railway"="station"];
);
out tags center;
`.trim();

  const resp = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(q)
  });
  if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
  const data = await resp.json();

  await cache.put(cacheKey, jsonResponse(data, 24 * 3600)); // 1 day
  return data;
}

async function fetchNasaPowerDaily(lat, lon, cache) {
  // NASA POWER daily endpoint structure is documented, including sample query. :contentReference[oaicite:15]{index=15}
  const cacheKey = new Request(`https://cache.local/nasa/power?lat=${lat}&lon=${lon}`, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const end = yyyymmdd(new Date());
  const start = yyyymmdd(daysAgo(new Date(), 365));

  // Using Daily API: parameters=T2M,PRECTOTCORR, community=SB, format=JSON.
  const apiUrl =
    `https://power.larc.nasa.gov/api/temporal/daily/point` +
    `?parameters=T2M,PRECTOTCORR&community=SB&longitude=${lon}&latitude=${lat}` +
    `&start=${start}&end=${end}&format=JSON`;

  const resp = await fetch(apiUrl, { headers: { "accept": "application/json" } });
  if (!resp.ok) throw new Error(`NASA POWER ${resp.status}`);
  const data = await resp.json();

  const p = data?.properties?.parameter || {};
  const t2m = p.T2M || {};
  const pr = p.PRECTOTCORR || {};

  const tVals = Object.values(t2m).filter((x) => Number.isFinite(x));
  const pVals = Object.values(pr).filter((x) => Number.isFinite(x));

  const avgTempC = tVals.length ? mean(tVals) : null;
  const totalRainMm = pVals.length ? sum(pVals) : null;

  const out = { start, end, avgTempC, totalRainMm };
  await cache.put(cacheKey, jsonResponse(out, 24 * 3600));
  return out;
}

async function fetchSoilGrids(lat, lon, cache) {
  // SoilGrids REST API is beta + fair use is ~5 calls per minute. :contentReference[oaicite:16]{index=16}
  const cacheKey = new Request(`https://cache.local/soilgrids?lat=${lat}&lon=${lon}`, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const apiUrl = `https://rest.isric.org/soilgrids/v2.0/properties/query?lon=${lon}&lat=${lat}`;
  const resp = await fetch(apiUrl, { headers: { "accept": "application/json" } });
  if (!resp.ok) throw new Error(`SoilGrids ${resp.status}`);
  const data = await resp.json();

  // Keep it small: return only a few top-level hints, plus a compact raw
  const out = {
    note: "SoilGrids response format can be large; this is a compact pass-through.",
    // keep raw but truncated-ish (still JSON)
    raw: data
  };

  await cache.put(cacheKey, jsonResponse(out, 7 * 24 * 3600));
  return out;
}

// -------------------- Summaries + scoring --------------------

function summarizeOverpass(overpassJson) {
  const counts = {
    schools: 0,
    hospitals: 0,
    banks: 0,
    marketplaces: 0,
    supermarkets: 0,
    malls: 0,
    industrial: 0,
    commercial: 0,
    retail: 0,
    construction: 0,
    majorRoads: 0,
    railwayStations: 0
  };

  for (const el of (overpassJson?.elements || [])) {
    const t = el.tags || {};

    if (["school", "college", "university"].includes(t.amenity)) counts.schools++;
    if (["hospital", "clinic", "doctors"].includes(t.amenity)) counts.hospitals++;
    if (t.amenity === "bank") counts.banks++;
    if (t.amenity === "marketplace") counts.marketplaces++;

    if (t.shop === "supermarket") counts.supermarkets++;
    if (t.shop === "mall") counts.malls++;

    if (t.landuse === "industrial") counts.industrial++;
    if (t.landuse === "commercial") counts.commercial++;
    if (t.landuse === "retail") counts.retail++;
    if (t.landuse === "construction") counts.construction++;

    if (["motorway", "trunk", "primary", "secondary"].includes(t.highway)) counts.majorRoads++;
    if (t.railway === "station") counts.railwayStations++;
  }

  // A crude “peace risk” proxy
  const peaceRisk = clamp(
    (counts.industrial * 10) + (counts.construction * 6) + (counts.majorRoads * 2),
    0, 100
  );

  return { counts, peaceRisk };
}

function scoreIntent(intent, overpass, climate, distanceKm) {
  // Baseline
  let score = 50;
  const reasons = [];

  const c = overpass?.counts;

  if (intent === "residential") {
    if (c) {
      score += clamp(c.schools, 0, 10) * 1.5;
      score += clamp(c.hospitals, 0, 6) * 2;
      score -= clamp(c.industrial, 0, 5) * 6;
      score -= clamp(c.construction, 0, 5) * 3;
      score -= clamp(c.majorRoads, 0, 10) * 1.2;
      reasons.push("Residential: rewarded schools/hospitals, penalized industry/major roads.");
    }
    if (distanceKm != null) {
      score += distanceKm <= 15 ? 6 : distanceKm <= 40 ? 2 : -4;
      reasons.push("Residential: commute distance considered.");
    }
  }

  if (intent === "farming") {
    if (climate?.totalRainMm != null) {
      score += climate.totalRainMm >= 800 ? 8 : climate.totalRainMm >= 500 ? 4 : -4;
      reasons.push("Farming: rainfall signal considered.");
    }
    if (c) {
      score -= clamp(c.industrial, 0, 5) * 4;
      reasons.push("Farming: penalized industry nearby.");
    }
  }

  if (intent === "commercial") {
    if (c) {
      score += clamp(c.majorRoads, 0, 10) * 2.5;
      score += clamp(c.commercial + c.retail, 0, 10) * 2;
      reasons.push("Commercial: rewarded roads + commercial/retail signals.");
    }
    if (distanceKm != null) {
      score += distanceKm <= 20 ? 5 : distanceKm <= 50 ? 1 : -3;
    }
  }

  if (intent === "investment") {
    if (c) {
      score += clamp(c.construction, 0, 10) * 2.0;
      score += clamp(c.majorRoads, 0, 10) * 1.5;
      reasons.push("Investment: rewarded development/construction and connectivity.");
    }
  }

  score = clamp(score, 0, 100);

  // Convert score to adjustment percentage (-20% .. +20%)
  const adjustmentPct = clamp((score - 50) * 0.4, -20, 20);

  return { score0to100: score, adjustmentPct, reasons };
}

function pickBaseRate(marketRate, guidelineRate) {
  const m = Number.isFinite(marketRate) ? marketRate : null;
  const g = Number.isFinite(guidelineRate) ? guidelineRate : null;
  if (m == null && g == null) return null;
  if (m != null && g != null) return Math.max(m, g);
  return m ?? g;
}

function priceFromScore(baseRate, adjustmentPct) {
  const adj = 1 + (adjustmentPct / 100);
  const est = baseRate * adj;
  return {
    baseRate,
    adjustmentPct,
    estimatedRate: Math.round(est),
    bandLow: Math.round(est * 0.9),
    bandHigh: Math.round(est * 1.1),
    unit: "INR_per_acre"
  };
}

// -------------------- AI (Workers AI) --------------------

async function aiExplain(env, payload) {
  // Workers AI free allocation: 10,000 neurons/day. :contentReference[oaicite:17]{index=17}
  // Binding + env.AI.run() documented here. :contentReference[oaicite:18]{index=18}
  if (!env?.AI) {
    return { enabled: false, message: "Workers AI binding not configured (env.AI missing)." };
  }

  const prompt = [
    "You are a helpful Indian land-property analysis assistant.",
    "You will be given JSON signals about a land location + buyer intent.",
    "Return STRICT JSON with keys:",
    `{"summary":"...", "pros":[...], "cons":[...], "due_diligence":[...], "suggested_adjustment_pct": number, "confidence_0_1": number}`,
    "Rules:",
    "- suggested_adjustment_pct should be between -20 and +20",
    "- don’t invent specific govt prices or market prices; only use given inputs",
    "",
    "SIGNALS JSON:",
    JSON.stringify(payload).slice(0, 12000)
  ].join("\n");

  const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", { prompt });

  // result can vary by model; normalize a bit
  return { enabled: true, raw: result };
}

// -------------------- Utilities --------------------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*"
    }
  });
}

function jsonResponse(obj, ttlSeconds) {
  return new Response(JSON.stringify(obj), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${ttlSeconds}`
    }
  });
}

function clamp(x, a, b) {
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}
function round(x, d) {
  const p = Math.pow(10, d);
  return Math.round(x * p) / p;
}
function daysAgo(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() - n);
  return out;
}
function yyyymmdd(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}
function mean(arr) { return arr.reduce((a,b)=>a+b,0) / (arr.length || 1); }
function sum(arr) { return arr.reduce((a,b)=>a+b,0); }

// Haversine distance (km)
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
