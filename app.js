// --- Small helpers ---
const $ = (id) => document.getElementById(id);
const setStatus = (msg) => { $("status").textContent = msg || ""; };

const state = {
  pickMode: "land",     // "land" | "office"
  land: null,           // {lat, lon}
  office: null,         // {lat, lon}
  bhuvanVisible: false,
};

function setInputsFromState() {
  $("landLat").value = state.land?.lat ?? "";
  $("landLon").value = state.land?.lon ?? "";
  $("officeLat").value = state.office?.lat ?? "";
  $("officeLon").value = state.office?.lon ?? "";
}

// --- Map setup (OpenLayers + OpenFreeMap style) ---
const map = new ol.Map({ target: "map" });

// Apply OpenFreeMap vector style
const openFreeMapStyleUrl = "https://tiles.openfreemap.org/styles/liberty";
const applyResult = olms.apply(map, openFreeMapStyleUrl);

// Marker layers
const landSource = new ol.source.Vector();
const officeSource = new ol.source.Vector();

const markerStyle = (label) =>
  new ol.style.Style({
    image: new ol.style.Circle({
      radius: 7,
      fill: new ol.style.Fill({ color: "#000" }),
      stroke: new ol.style.Stroke({ color: "#fff", width: 2 }),
    }),
    text: new ol.style.Text({
      text: label,
      offsetY: -18,
      fill: new ol.style.Fill({ color: "#000" }),
      stroke: new ol.style.Stroke({ color: "#fff", width: 3 }),
    }),
  });

const landLayer = new ol.layer.Vector({ source: landSource, style: markerStyle("LAND") });
const officeLayer = new ol.layer.Vector({ source: officeSource, style: markerStyle("OFFICE") });

// Bhuvan WMS (example LULC layer from Bhuvan wiki)
// NOTE: Replace LAYERS with the layer you want (use GetCapabilities to discover).
const bhuvanWms = new ol.layer.Tile({
  source: new ol.source.TileWMS({
    url: "https://bhuvan-vec2.nrsc.gov.in/bhuvan/wms",
    params: {
      LAYERS: "lulc:BR_LULC50K_1112", // example from Bhuvan wiki
      VERSION: "1.1.1",
      FORMAT: "image/png",
      TRANSPARENT: true
    },
    crossOrigin: "anonymous",
  }),
  opacity: 0.55,
  visible: false,
});

function initAfterBase() {
  // Center on India
  map.setView(
    new ol.View({
      center: ol.proj.fromLonLat([78.9629, 20.5937]),
      zoom: 4,
    })
  );

  map.addLayer(bhuvanWms);
  map.addLayer(landLayer);
  map.addLayer(officeLayer);

  map.on("click", (evt) => {
    const [lon, lat] = ol.proj.toLonLat(evt.coordinate);
    const point = { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };

    if (state.pickMode === "land") {
      state.land = point;
      landSource.clear();
      landSource.addFeature(new ol.Feature(new ol.geom.Point(evt.coordinate)));
    } else {
      state.office = point;
      officeSource.clear();
      officeSource.addFeature(new ol.Feature(new ol.geom.Point(evt.coordinate)));
    }
    setInputsFromState();
  });
}

// olms.apply may return a promise depending on build; handle both safely
if (applyResult && typeof applyResult.then === "function") {
  applyResult.then(initAfterBase).catch(initAfterBase);
} else {
  initAfterBase();
}

// --- UI events ---
$("pickLandBtn").onclick = () => {
  state.pickMode = "land";
  setStatus("Pick mode: LAND. Click on the map.");
};

$("pickOfficeBtn").onclick = () => {
  state.pickMode = "office";
  setStatus("Pick mode: OFFICE. Click on the map.");
};

$("bhuvanToggle").onchange = (e) => {
  state.bhuvanVisible = !!e.target.checked;
  bhuvanWms.setVisible(state.bhuvanVisible);
};

$("analyzeBtn").onclick = async () => {
  // Read from inputs (user can type too)
  const landLat = parseFloat($("landLat").value);
  const landLon = parseFloat($("landLon").value);
  const officeLat = parseFloat($("officeLat").value);
  const officeLon = parseFloat($("officeLon").value);

  if (!Number.isFinite(landLat) || !Number.isFinite(landLon)) {
    alert("Pick a LAND point on the map first.");
    return;
  }

  const radiusKm = Math.max(0.5, parseFloat($("radiusKm").value) || 3);
  const intent = $("intent").value;

  const marketRate = parseFloat($("marketRate").value);
  const guidelineRate = parseFloat($("guidelineRate").value);

  const url = new URL("/api/analyze", window.location.origin);
  url.searchParams.set("lat", landLat);
  url.searchParams.set("lon", landLon);
  url.searchParams.set("radius_km", radiusKm);
  url.searchParams.set("intent", intent);
  if (Number.isFinite(officeLat) && Number.isFinite(officeLon)) {
    url.searchParams.set("office_lat", officeLat);
    url.searchParams.set("office_lon", officeLon);
  }
  if (Number.isFinite(marketRate)) url.searchParams.set("market_rate", marketRate);
  if (Number.isFinite(guidelineRate)) url.searchParams.set("guideline_rate", guidelineRate);

  setStatus("Analyzing… (fetching open data)");
  $("output").textContent = "{}";

  try {
    const res = await fetch(url.toString());
    const data = await res.json();
    $("output").textContent = JSON.stringify(data, null, 2);
    setStatus("Done.");
  } catch (err) {
    console.error(err);
    setStatus("Error: " + (err?.message || err));
  }
};
