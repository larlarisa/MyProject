document.querySelectorAll('input[name="periode"]').forEach(r => {
  console.log("radio:", r.value, "| label:", r.closest("label")?.innerText?.trim());
});

document.addEventListener("DOMContentLoaded", async () => {
  const page = document.body.dataset.page;

  // 1) Navigasi aktif
  document.querySelectorAll(".nav__link").forEach((a) => {
    if (a.dataset.page === page) a.classList.add("is-active");
  });

  // 2) Jalankan fungsi sesuai halaman
  try {
    if (page === "peta") {
      await initMapApplication();
    } else if (page === "beranda") {
      if (typeof setupHeroFullSlider === "function")
        setupHeroFullSlider();
      await initHomeMap();
    }
  } catch (err) {
    console.error("Error init page:", err);
  }
});

/* ========================= GLOBALS ========================= */
let homeMap = null;
let petaMap = null;
let baseOSM = null;
let baseSAT = null;
let adminLayer = null;
let landcoverLayer = null;
let landcoverRaster2020 = null;
let landcoverRaster2023 = null;
let landcoverRaster2025 = null;
let landcoverRasterBencana = null;
let floodLayer = null;
let currentPeriode = "2020-2022";

/* ========================= PATHS (FILE DATA) ========================= */
const ADMIN_CANDIDATE_PATHS = [
  "./assets/admin.geojson",
  "./data/admin.geojson",
  "./admin.geojson",
];

// ===============================
// LANDCOVER DATA
// ===============================

// RASTER (KHUSUS 2020–2022)
const LANDCOVER_RASTER_TILES = {
  "2020-2022": {
    url: "assets/tiles2020/{z}/{x}/{y}.png",
    minZoom: 6,
    maxZoom: 10
  }
};

// BANJIR (PMTILES)
const FLOOD_PATH = "./assets/flood.pmtiles";
const FLOOD_TILE_LAYER = "flood gpkg";

/* ========================= HELPERS ========================= */
async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok)
    throw new Error(`Gagal load ${url} (${r.status})`);
  return r.json();
}

async function loadGeoJSONAny(paths) {
  for (const p of paths) {
    try {
      const j = await fetchJSON(p);
      console.log(`✅ Loaded: ${p}`);
      return { json: j, path: p };
    } catch (e) {
      console.warn(`⚠️ Gagal load ${p}`);
    }
  }
  throw new Error("❌ File GeoJSON tidak ditemukan");
}

function safeText(elId, text) {
  const el = document.getElementById(elId);
  if (el) el.textContent = text;
}

function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .trim();
}

/* ========================= PERSENTASE DASHBOARD ========================= */
const LANDCOVER_DATA = {
  "2020-2022": {
    desc: "Tutupan lahan didominasi vegetasi (73,75%) disusul sawit (17,28%). Aktivitas terbangun masih kecil (2,18%).",
    pct: {
      air: 0.3899682494,
      infrastruktur: 2.184534865,
      pertanian: 0.4359790744,
      vegetasi: 73.74626338,
      lahanTerbuka: 5.967968218,
      sawit: 17.27528622,
    }
  },

  "2023-2024": {
    desc: "Vegetasi meningkat menjadi 76,12% dan sawit turun ke 15,56%. Kondisi relatif lebih “hijau” dibanding 2020–2022.",
    pct: {
      air: 0.5534092184,
      infrastruktur: 0.7758904735,
      pertanian: 0.9759089789,
      vegetasi: 76.11831028,
      lahanTerbuka: 6.017909168,
      sawit: 15.55857189,
    }
  },

  "2025": {
    desc: "Terjadi perubahan besar: vegetasi turun ke 53,73% sementara sawit naik tajam ke 41,96% (indikasi konversi lahan).",
    pct: {
      air: 0.58668909,
      infrastruktur: 0.0439150467,
      pertanian: 0.2975394375,
      vegetasi: 53.72645152,
      lahanTerbuka: 3.38305878,
      sawit: 41.96286967,
    }
  },

  "Bencana Pulau Sumatera November 2025": {
    desc: "Saat bencana, badan air naik ke 4,33% (indikasi genangan/luapan). Vegetasi 66,32% dan sawit 24,21%.",
    pct: {
      air: 4.329067938,
      infrastruktur: 0.8906631619,
      pertanian: 0.533371292,
      vegetasi: 66.32315597,
      lahanTerbuka: 3.713349184,
      sawit: 24.21039245,
    }
  }
};


function formatPct(p) {
  return Number(p || 0).toFixed(2) + "%";
}

function updateUIByPeriode(periode) {
  const d = LANDCOVER_DATA[periode];
  if (!d) return;

  // update deskripsi
  safeText("infoDesc", d.desc);

  // update judul
  if (periode === "Bencana Pulau Sumatera November 2025") {
    safeText("infoTitle", "Tutupan Lahan Saat Bencana");
  } else {
    safeText("infoTitle", `Tutupan Lahan ${periode.replace("-", "–")}`);
  }

  // update persentase
  const order = ["air","infrastruktur","pertanian","vegetasi","lahanTerbuka","sawit"];
  const els = document.querySelectorAll(".miniStat .miniStat__value");
  els.forEach((el, i) => {
    el.textContent = formatPct(d.pct[order[i]]);
  });
}

/* ======= Mapping class angka (0–5) -> label ======= */
const CLASS_MAP = {
  0: "Air",
  1: "Infrastruktur",
  2: "Pertanian",
  3: "Vegetasi",
  4: "Lahan Terbuka",
  5: "Sawit"
};

function pickClassName(props = {}) {
  if (props.class != null) {
    const n = Number(props.class);
    if (!Number.isNaN(n) && CLASS_MAP[n]) return CLASS_MAP[n];
    return String(props.class);
  }

  const keys = [
    "kelas",
    "Kelas",
    "Class",
    "kategori",
    "KATEGORI",
    "tutupan",
    "Tutupan",
    "label",
    "LABEL",
    "name",
    "NAME"
  ];

  for (const k of keys) {
    if (props[k] != null) return String(props[k]);
  }

  return "Lahan Terbuka";
}

function landcoverColor(cls) {
  const n = normalize(cls);

  if (n.includes("air")) return "#38bdf8";
  if (n.includes("infrastruktur")) return "#ef4444";
  if (n.includes("pertanian")) return "#a3e635";
  if (n.includes("vegetasi")) return "#22c55e";
  if (n.includes("lahan terbuka")) return "#eab308";
  if (n.includes("sawit")) return "#a855f7";

  return "#94a3b8";
}
// ===== RASTER 2020-2022 (PNG Overlay) =====
const BOUNDS_2020_2022 = [
  [1.4238297, 98.0250621], // SOUTH, WEST
  [2.3046279, 99.0601010]  // NORTH, EAST
];

function showRaster2020() {
  if (!petaMap) return;

  // hapus dulu biar ga dobel
  if (landcoverRaster2020) {
    petaMap.removeLayer(landcoverRaster2020);
    landcoverRaster2020 = null;
  }

  landcoverRaster2020 = L.imageOverlay(
    "assets/Raster/Tutupan_Lahan_2020-2022_color.png", // << INI FILE WARNA
    BOUNDS_2020_2022,
    { opacity: 0.85 }
  ).addTo(petaMap);

  // zoom ke raster (biar pasti kelihatan)
  petaMap.fitBounds(BOUNDS_2020_2022);
}

function hideRaster2020() {
  if (!petaMap || !landcoverRaster2020) return;
  petaMap.removeLayer(landcoverRaster2020);
  landcoverRaster2020 = null;
}

// ===== RASTER 2023-2024 (PNG Overlay) =====
const BOUNDS_2023_2024 = [
  [1.4238297, 98.0250621], // SOUTH, WEST
  [2.3046279, 99.0601010], // NORTH, EAST
];

function showRaster2023() {
  if (!petaMap) return;

  if (landcoverRaster2023) {
    petaMap.removeLayer(landcoverRaster2023);
    landcoverRaster2023 = null;
  }

  landcoverRaster2023 = L.imageOverlay(
    "assets/Raster/Tutupan_Lahan_2023-2024_color.png", // file hasil gdaldem
    BOUNDS_2023_2024,
    { opacity: 0.85 }
  ).addTo(petaMap);

  petaMap.fitBounds(BOUNDS_2023_2024);
}

function hideRaster2023() {
  if (!petaMap || !landcoverRaster2023) return;
  petaMap.removeLayer(landcoverRaster2023);
  landcoverRaster2023 = null;
}

// ===== RASTER 2025 (PNG Overlay) =====
const BOUNDS_2025 = [
  [1.4238297, 98.0250621], // SOUTH, WEST
  [2.3046279, 99.0601010], // NORTH, EAST
];

function showRaster2025() {
  if (!petaMap) return;

  if (landcoverRaster2025) {
    petaMap.removeLayer(landcoverRaster2025);
    landcoverRaster2025 = null;
  }

  landcoverRaster2025 = L.imageOverlay(
    "./assets/Raster/Tutupan_Lahan_2025_color.png",
    BOUNDS_2025,
    { opacity: 0.85 }
  ).addTo(petaMap);

  petaMap.fitBounds(BOUNDS_2025);
}

function hideRaster2025() {
  if (!petaMap || !landcoverRaster2025) return;
  petaMap.removeLayer(landcoverRaster2025);
  landcoverRaster2025 = null;
}

// ===== RASTER SAAT BENCANA (PNG Overlay) =====
const BOUNDS_BENCANA = [
  [1.4238297, 98.0250621], // SOUTH, WEST
  [2.3046279, 99.0601010]  // NORTH, EAST
];

function showRasterBencana() {
  if (!petaMap) return;

  if (landcoverRasterBencana) {
    petaMap.removeLayer(landcoverRasterBencana);
    landcoverRasterBencana = null;
  }

  landcoverRasterBencana = L.imageOverlay(
    "assets/Raster/Tutupan_Lahan_Saat_Bencana_color.png",
    BOUNDS_BENCANA,
    { opacity: 0.85 }
  ).addTo(petaMap);

  petaMap.fitBounds(BOUNDS_BENCANA);
}

function hideRasterBencana() {
  if (!petaMap || !landcoverRasterBencana) return;
  petaMap.removeLayer(landcoverRasterBencana);
  landcoverRasterBencana = null;
}

// ===== FLOOD (PNG Overlay) =====
const BOUNDS_FLOOD = [
  [1.4238297, 98.0250621], // SOUTH, WEST
  [2.3046279, 99.0601010]  // NORTH, EAST
];

function showFlood() {
  if (!petaMap) return;

  if (floodLayer) {
    petaMap.removeLayer(floodLayer);
    floodLayer = null;
  }

  floodLayer = L.imageOverlay(
    "assets/Raster/flood_color.png", // <= INI SESUAI FOLDER KAMU
    BOUNDS_FLOOD,
    { opacity: 0.85 }
  ).addTo(petaMap);

  // optional: biar di atas raster tutupan lahan
  floodLayer.bringToFront();
}

function hideFlood() {
  if (!petaMap || !floodLayer) return;
  petaMap.removeLayer(floodLayer);
  floodLayer = null;
}
/* ========================= BERANDA - HOME MAP ========================= */
async function initHomeMap() {
  const el = document.getElementById("homeMap");
  if (!el || typeof L === "undefined") return;

  if (homeMap) {
    homeMap.invalidateSize();
    return;
  }

  homeMap = L.map("homeMap", { zoomControl: true }).setView([1.8642, 98.5426], 9);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(homeMap);

  // batas administrasi
  const { json: batas } = await loadGeoJSONAny(ADMIN_CANDIDATE_PATHS);
  const homeAdmin = L.geoJSON(batas, {
    style: { color: "#ef4444", weight: 2, fillOpacity: 0 }
  }).addTo(homeMap);

  homeMap.fitBounds(homeAdmin.getBounds(), { padding: [12, 12] });

  setTimeout(() => homeMap.invalidateSize(), 50);
}

/* ========================= MAP ========================= */
async function initMapApplication() {
  const el = document.getElementById("map");
  if (!el || typeof L === "undefined") return;

  // kalau sudah pernah dibuat, jangan bikin ulang
  if (petaMap) {
    petaMap.invalidateSize();
    return;
  }

  // INIT MAP
  petaMap = L.map("map", { zoomControl: true }).setView([1.8642, 98.5426], 9);

  // BASEMAPS
  baseOSM = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  });

  baseSAT = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Tiles &copy; Esri" }
  );

  // default OSM
  baseOSM.addTo(petaMap);

  // tombol OSM/Satelit kamu
  const btnOSM = document.querySelector('[data-basemap="OSM"]');
  const btnSat = document.querySelector('[data-basemap="Satelit"]');

  function setActive(btn) {
    document.querySelectorAll(".basemap__btn").forEach(b => b.classList.remove("is-active"));
    btn?.classList.add("is-active");
  }

  btnOSM?.addEventListener("click", () => {
    petaMap.removeLayer(baseSAT);
    baseOSM.addTo(petaMap);
    setActive(btnOSM);
  });

  btnSat?.addEventListener("click", () => {
    petaMap.removeLayer(baseOSM);
    baseSAT.addTo(petaMap);
    setActive(btnSat);
  });

  // ADMIN GEOJSON (pakai helper kamu)
  try {
    const { json: batas } = await loadGeoJSONAny(ADMIN_CANDIDATE_PATHS);
    adminLayer = L.geoJSON(batas, {
      style: { color: "#ef4444", weight: 2, fillOpacity: 0 }
    });

    // default sesuai checkbox
    const cb = document.getElementById("layerAdmin");
    if (!cb || cb.checked) adminLayer.addTo(petaMap);

    // zoom ke admin
    petaMap.fitBounds(adminLayer.getBounds(), { padding: [12, 12] });

  } catch (e) {
    console.error(e);
    petaMap.setView([-2.5, 118], 5);
  }

  // Toggle checkbox admin
  document.getElementById("layerAdmin")?.addEventListener("change", (e) => {
    if (!adminLayer) return;
    if (e.target.checked) adminLayer.addTo(petaMap);
    else petaMap.removeLayer(adminLayer);
  });

    // ✅ TARUH DI SINI (toggle flood)
  document.getElementById("layerFlood")?.addEventListener("change", (e) => {
    if (e.target.checked) showFlood();
    else hideFlood();
  });

  // ===== TAMPILKAN RASTER DEFAULT 2020-2022 =====
  showRaster2020();
  safeText("mapStatusPeriode", "Periode Data: 2020–2022");
  updateUIByPeriode("2020-2022");

  // ===== RADIO PERIODE =====
document.querySelectorAll('input[name="periode"]').forEach((r) => {
  r.addEventListener("change", (e) => {
    const v = e.target.value;
    updateUIByPeriode(v);

    hideRaster2020();
    hideRaster2023();
    hideRaster2025();
    hideRasterBencana();
    hideFlood();

    if (v === "2020-2022") {
    showRaster2020();
    safeText("mapStatusPeriode", "Periode Data: 2020–2022");
    safeText("infoTitle", "Tutupan Lahan 2020–2022");
    safeText("infoDesc", "Tutupan lahan didominasi vegetasi (73,75%) disusul sawit (17,28%). Aktivitas terbangun masih kecil (2,18%).");

    } else if (v === "2023-2024") {
      showRaster2023();
      safeText("mapStatusPeriode", "Periode Data: 2023–2024");
      safeText("infoTitle", "Tutupan Lahan 2023–2024");
      safeText("infoDesc", "Vegetasi meningkat menjadi 76,12% dan sawit turun ke 15,56%. Kondisi relatif lebih “hijau” dibanding 2020–2022.");
    
    } else if (v === "2025") {
      showRaster2025();
      safeText("mapStatusPeriode", "Periode Data: 2025");
      safeText("infoTitle", "Tutupan Lahan 2025");
      safeText("infoDesc", "Terjadi perubahan besar: vegetasi turun ke 53,73% sementara sawit naik tajam ke 41,96% (indikasi konversi lahan).");
    
    } else if (v === "Bencana Pulau Sumatera November 2025") {
      console.log("masuk bencana, showRasterBencana()");
      showRasterBencana();
      safeText("mapStatusPeriode", "Periode Data: Saat Bencana");

    } else {
      safeText("mapStatusPeriode", "Periode Data: " + v);
    }
  });
});


  // penting supaya ukuran map bener di layout kamu
  setTimeout(() => petaMap.invalidateSize(), 50);
}

/* ========================= LANDCOVER STATS ========================= */
const LANDCOVER_STATS = {
  /* =============================== 2020–2022 → 2023–2024 =============================== */
  "2020-2022__2023-2024": {
    labels: [
      "Badan Air",
      "Infrastruktur",
      "Pertanian",
      "Vegetasi",
      "Lahan Terbuka",
      "Sawit"
    ],
    fromLabel: "2020–2022 (ha)",
    toLabel: "2023–2024 (ha)",
    from: [
      908.12737,
      5087.17285,
      1015.27375,
      171734.49372,
      13897.73466,
      40229.32684
    ],
    to: [
      1288.73583,
      1806.83267,
      2272.62002,
      177258.32984,
      14014.03321,
      36231.57762
    ],
    delta: [
      380.60846,
      -3280.34019,
      1257.34626,
      5523.83612,
      116.29855,
      -3997.74921
    ],
    trend: ["Naik", "Menurun", "Naik", "Naik", "Naik", "Menurun"]
  },

  /* =============================== 2020–2022 → 2025 =============================== */
  "2020-2022__2025": {
    labels: [
      "Badan Air",
      "Infrastruktur",
      "Pertanian",
      "Vegetasi",
      "Lahan Terbuka",
      "Sawit"
    ],
    fromLabel: "2020–2022 (ha)",
    toLabel: "2025 (ha)",
    from: [
      908.12737,
      5087.17285,
      1015.27375,
      171734.49372,
      13897.73466,
      40229.32684
    ],
    to: [
      1366.23538,
      101.04672,
      692.88642,
      125113.93159,
      7878.20101,
      97719.82807
    ],
    delta: [
      458.10801,
      -4986.12613,
      -322.38733,
      -46620.56213,
      -6019.53365,
      57490.50123
    ],
    trend: ["Naik", "Menurun", "Menurun", "Menurun", "Menurun", "Naik"]
  },

  /* =============================== 2023–2024 → 2025 =============================== */
  "2023-2024__2025": {
    labels: [
      "Badan Air",
      "Infrastruktur",
      "Pertanian",
      "Vegetasi",
      "Lahan Terbuka",
      "Sawit"
    ],
    fromLabel: "2023–2024 (ha)",
    toLabel: "2025 (ha)",
    from: [
      1288.73583,
      1806.83267,
      2272.62002,
      177258.32984,
      14014.03321,
      36231.57762
    ],
    to: [
      1366.23538,
      101.04672,
      692.88642,
      125113.93159,
      7878.20101,
      97719.82807
    ],
    delta: [
      77.49955,
      -1705.78594,
      -1579.73359,
      -52144.39825,
      -6135.83220,
      61488.25045
    ],
    trend: ["Naik", "Menurun", "Menurun", "Menurun", "Menurun", "Naik"]
  },

  /* =============================== 2020–2022 → Saat Bencana =============================== */
  "2020-2022__bencana": {
    labels: [
      "Badan Air",
      "Infrastruktur",
      "Pertanian",
      "Vegetasi",
      "Lahan Terbuka",
      "Sawit"
    ],
    fromLabel: "2020–2022 (ha)",
    toLabel: "Saat Bencana (ha)",
    from: [
      908.12737,
      5087.17285,
      1015.27375,
      171734.49372,
      13897.73466,
      40229.32684
    ],
    to: [
      10081.19268,
      2074.10627,
      1242.07308,
      154448.14546,
      8647.35531,
      56379.25639
    ],
    delta: [
      9173.06532,
      -3013.06658,
      226.79933,
      -17286.34826,
      -5250.37935,
      16149.92955
    ],
    trend: ["Naik", "Menurun", "Naik", "Menurun", "Menurun", "Naik"]
  },

  /* =============================== 2023–2024 → Saat Bencana =============================== */
  "2023-2024__bencana": {
    labels: [
      "Badan Air",
      "Infrastruktur",
      "Pertanian",
      "Vegetasi",
      "Lahan Terbuka",
      "Sawit"
    ],
    fromLabel: "2023–2024 (ha)",
    toLabel: "Saat Bencana (ha)",
    from: [
      1288.73583,
      1806.83267,
      2272.62002,
      177258.32984,
      14014.03321,
      36231.57762
    ],
    to: [
      10081.19268,
      2074.10627,
      1242.07308,
      154448.14546,
      8647.35531,
      56379.25639
    ],
    delta: [
      8792.45685,
      267.27360,
      -1030.54693,
      -22810.18438,
      -5366.67790,
      20147.67877
    ],
    trend: ["Naik", "Naik", "Menurun", "Menurun", "Menurun", "Naik"]
  }
};

/* ========================= CHART ========================= */
function renderChart(periode) {
  const d = LANDCOVER_STATS[periode];
  if (!d) return;

  const canvas = document.getElementById("chart-" + periode);
  if (!canvas) return;

  if (canvas._chart) canvas._chart.destroy();

  const MAX_Y = 200000;

  const chart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: d.labels,
      datasets: [
        {
          label: d.fromLabel,
          data: d.from,
          backgroundColor: "#4F81BD",
          categoryPercentage: 0.6,
          barPercentage: 0.8
        },
        {
          label: d.toLabel,
          data: d.to,
          backgroundColor: "#C0504D",
          categoryPercentage: 0.6,
          barPercentage: 0.8
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "top",
          labels: {
            boxWidth: 14,
            boxHeight: 14
          }
        },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `${ctx.dataset.label}: ${ctx.raw.toLocaleString()} ha`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: "#111" }
        },
        y: {
          min: 0,
          max: MAX_Y,
          grid: { color: "#e5e7eb" },
          ticks: {
            stepSize: 50000,
            callback: (v) => v.toLocaleString()
          },
          title: {
            display: true,
            text: "Luas (ha)"
          }
        }
      }
    }
  });

  canvas._chart = chart;
}

/* ========================= TABLE ========================= */
function renderTable(periode) {
  const d = LANDCOVER_STATS[periode];
  if (!d) return;

  const tbody = document.querySelector(`#table-${periode} tbody`);
  if (!tbody) return;

  tbody.innerHTML = "";

  d.labels.forEach((label, i) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${label}</td>
      <td>${d.from[i].toLocaleString()}</td>
      <td>${d.to[i].toLocaleString()}</td>
      <td>${d.delta[i] > 0 ? "+" : ""}${d.delta[i].toLocaleString()}</td>
      <td>${d.trend[i]}</td>
    `;
    tbody.appendChild(row);
  });
}

/* ========================= INIT CHART + TABLE ========================= */
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".fullBlock").forEach((block) => {
    const periode = block.dataset.periode;
    renderChart(periode);
    renderTable(periode);
  });
});

// ✅ TARUH PALING BAWAH script.js
window.addEventListener("resize", () => {
  if (petaMap && typeof petaMap.invalidateSize === "function") {
    petaMap.invalidateSize();
  }
  if (homeMap && typeof homeMap.invalidateSize === "function") {
    homeMap.invalidateSize();
  }
});

window.addEventListener("resize", () => {
  setTimeout(() => {
    petaMap?.invalidateSize?.();
    homeMap?.invalidateSize?.();
  }, 150);
});

window.addEventListener("resize", () => {
  setTimeout(() => {
    petaMap?.invalidateSize?.();
  }, 150);
});


