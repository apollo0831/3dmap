"use strict";

// AWS terrarium 타일은 z<=12 중간 줌에서 남해안 일대에 수천 m짜리
// 노이즈 스파이크가 있음 (z13+는 정상). 오염된 픽셀만 찾아서 깨끗한
// z13 자식 타일의 실측 고도 평균으로 치환한다 — 이웃 값으로 뭉개는
// 방식은 스파이크 자리가 언덕 잔재로 남아 위성 이미지가 일그러짐.
const DESPIKE_MAX_ZOOM = 12;
const DESPIKE_THRESHOLD_M = 200;
const REPAIR_ZOOM = 13;

const TERRARIUM_BASE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

function decodeTerrariumPng(buf) {
  return createImageBitmap(new Blob([buf], { type: "image/png" })).then((bmp) => {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return { canvas, ctx, img: ctx.getImageData(0, 0, bmp.width, bmp.height) };
  });
}

function elevationsFromImage(img) {
  const { width: w, height: h, data } = img;
  const ele = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    ele[i] = data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768;
  }
  return ele;
}

// 스파이크 픽셀 탐지: 이웃 8개의 2번째 최대/최소 범위를 T 이상 벗어나면
// 플래그. 군집 내부까지 잡기 위해 작업 사본을 깎아가며 반복.
function detectSpikes(ele, w, h) {
  const T = DESPIKE_THRESHOLD_M;
  const work = Float32Array.from(ele);
  const flagged = new Set();
  for (let pass = 0; pass < 8; pass++) {
    let changed = 0;
    for (let r = 1; r < h - 1; r++) {
      const row = r * w;
      for (let c = 1; c < w - 1; c++) {
        const i = row + c;
        if (flagged.has(i)) continue;
        let max1 = -Infinity, max2 = -Infinity, min1 = Infinity, min2 = Infinity;
        for (let dr = -w; dr <= w; dr += w) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const v = work[i + dr + dc];
            if (v > max1) { max2 = max1; max1 = v; }
            else if (v > max2) max2 = v;
            if (v < min1) { min2 = min1; min1 = v; }
            else if (v < min2) min2 = v;
          }
        }
        const e = work[i];
        if (e > max2 + T) { flagged.add(i); work[i] = max2; changed++; }
        else if (e < min2 - T) { flagged.add(i); work[i] = min2; changed++; }
      }
    }
    if (!changed) break;
  }
  // 군집 가장자리의 어중간하게 오염된 픽셀까지 복구되도록 2픽셀 팽창
  const dilated = new Set(flagged);
  for (const i of flagged) {
    const c = i % w, r = (i / w) | 0;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < h && cc >= 0 && cc < w) dilated.add(rr * w + cc);
      }
    }
  }
  return { flagged: dilated, work };
}

// z13 자식 타일의 고도 그리드 캐시 (스파이크 복구 전용)
const repairGridCache = new Map();
const REPAIR_CACHE_MAX = 64;

function fetchRepairGrid(x, y) {
  const key = `${x}/${y}`;
  let p = repairGridCache.get(key);
  if (!p) {
    p = fetch(`${TERRARIUM_BASE}/${REPAIR_ZOOM}/${x}/${y}.png`)
      .then((r) => { if (!r.ok) throw new Error(`repair tile ${r.status}`); return r.arrayBuffer(); })
      .then(decodeTerrariumPng)
      .then(({ img }) => elevationsFromImage(img));
    p.catch(() => repairGridCache.delete(key));
    repairGridCache.set(key, p);
    if (repairGridCache.size > REPAIR_CACHE_MAX) {
      repairGridCache.delete(repairGridCache.keys().next().value);
    }
  }
  return p;
}

// dem/demHillshade 소스가 같은 타일을 각각 요청하므로 URL 단위로
// 결과(Promise)를 캐시해 fetch·디코드·복구를 한 번만 수행한다.
const demTileCache = new Map();
const DEM_CACHE_MAX = 400;

async function loadDemTile(url) {
  const m = url.match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/);
  const z = m ? +m[1] : 99, tx = m ? +m[2] : 0, ty = m ? +m[3] : 0;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`DEM tile ${resp.status}`);
  const buf = await resp.arrayBuffer();
  if (z > DESPIKE_MAX_ZOOM) return buf;

  const { canvas, ctx, img } = await decodeTerrariumPng(buf);
  const w = img.width, h = img.height;
  const ele = elevationsFromImage(img);
  const { flagged, work } = detectSpikes(ele, w, h);
  if (!flagged.size) return buf;

  // 오염 픽셀 하나가 덮는 z13 블록(s x s)은 항상 한 자식 타일 안에
  // 들어가므로 (256이 s의 배수) 필요한 자식 타일만 모아서 받는다.
  const s = 2 ** (REPAIR_ZOOM - z);
  const needed = new Map();
  for (const i of flagged) {
    const c = i % w, r = (i / w) | 0;
    const X = (tx * w + c) * s, Y = (ty * h + r) * s;
    needed.set(`${(X / 256) | 0}/${(Y / 256) | 0}`, null);
  }
  let repaired = false;
  if (needed.size <= 12) {
    try {
      await Promise.all(
        [...needed.keys()].map(async (key) => {
          const [cx, cy] = key.split("/").map(Number);
          needed.set(key, await fetchRepairGrid(cx, cy));
        })
      );
      for (const i of flagged) {
        const c = i % w, r = (i / w) | 0;
        const X = (tx * w + c) * s, Y = (ty * h + r) * s;
        const grid = needed.get(`${(X / 256) | 0}/${(Y / 256) | 0}`);
        const ox = X % 256, oy = Y % 256;
        let sum = 0;
        for (let dy = 0; dy < s; dy++)
          for (let dx = 0; dx < s; dx++) sum += grid[(oy + dy) * 256 + ox + dx];
        ele[i] = sum / (s * s);
      }
      repaired = true;
    } catch (e) {
      /* 자식 타일 실패 시 아래 폴백 사용 */
    }
  }
  if (!repaired) {
    for (const i of flagged) ele[i] = work[i];
  }

  for (const i of flagged) {
    const v = Math.round((ele[i] + 32768) * 256);
    img.data[i * 4] = (v >> 16) & 255;
    img.data[i * 4 + 1] = (v >> 8) & 255;
    img.data[i * 4 + 2] = v & 255;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blob.arrayBuffer();
}

maplibregl.addProtocol("dem", async (params) => {
  const url = params.url.replace("dem://", "https://");
  let p = demTileCache.get(url);
  if (!p) {
    p = loadDemTile(url);
    p.catch(() => demTileCache.delete(url));
    demTileCache.set(url, p);
    if (demTileCache.size > DEM_CACHE_MAX) {
      demTileCache.delete(demTileCache.keys().next().value);
    }
  }
  return { data: await p };
});

const KOREA_CENTER = [127.8, 36.3];
const KOREA_VIEW = { center: KOREA_CENTER, zoom: 6.6, pitch: 0, bearing: 0 };

const map = new maplibregl.Map({
  container: "map",
  center: KOREA_VIEW.center,
  zoom: KOREA_VIEW.zoom,
  maxPitch: 75,
  attributionControl: { compact: true },
  style: {
    version: 8,
    sources: {
      satellite: {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        maxzoom: 18,
        attribution: "Esri, Maxar, Earthstar Geographics",
      },
      dem: {
        type: "raster-dem",
        tiles: ["dem://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 14,
        attribution: "Terrain: Mapzen/AWS",
      },
      demHillshade: {
        type: "raster-dem",
        tiles: ["dem://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 14,
      },
    },
    layers: [
      { id: "satellite", type: "raster", source: "satellite" },
      {
        id: "hillshade",
        type: "hillshade",
        source: "demHillshade",
        paint: { "hillshade-exaggeration": 0.35 },
      },
    ],
  },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

// 목록은 지도 load 전에 먼저 뜨므로, 레이어를 만지는 코드는 이걸 기다린다
const mapReady = new Promise((resolve) => {
  if (map.loaded()) resolve();
  else map.once("load", resolve);
});

map.on("load", () => {
  map.setTerrain({ source: "dem", exaggeration: 1.4 });
  if (map.setSky) {
    map.setSky({
      "sky-color": "#1a2b45",
      "horizon-color": "#8fa8c0",
      "fog-color": "#5a6b7d",
      "sky-horizon-blend": 0.6,
      "horizon-fog-blend": 0.7,
    });
  }
  // 모바일에서는 저작권 표시가 기본 펼침이면 좁은 화면을 가리므로 접어둔다
  if (isMobile()) {
    const attrib = document.querySelector("details.maplibregl-ctrl-attrib");
    if (attrib) attrib.open = false;
  }
});

// ---------- state ----------
let hikes = [];
let activeHikeId = null;
const markers = new Map();

// ---------- data ----------
async function loadHikes() {
  let data;
  try {
    const res = await fetch("data/index.json");
    data = await res.json();
  } catch (e) {
    document.getElementById("stats-line").textContent =
      "data/index.json 없음 — build_data.py를 먼저 실행하세요.";
    return;
  }
  hikes = data.hikes || [];
  renderList(hikes);
  renderMarkers(hikes);
  renderStats(hikes);
}

function renderStats(list) {
  const mountains = new Set(list.map((h) => h.mountain));
  const km = list.reduce((s, h) => s + (h.distance_km || 0), 0);
  document.getElementById("stats-line").textContent =
    `산행 ${list.length}회 · 산 ${mountains.size}곳 · 누적 ${km.toFixed(0)} km`;
}

// ---------- sidebar ----------
function renderList(list) {
  const ul = document.getElementById("hike-list");
  ul.innerHTML = "";
  let lastYear = null;
  for (const h of list) {
    const year = h.date ? h.date.slice(0, 4) : "날짜 미상";
    if (year !== lastYear) {
      const div = document.createElement("li");
      div.className = "year-divider";
      div.textContent = year;
      ul.appendChild(div);
      lastYear = year;
    }
    const li = document.createElement("li");
    li.dataset.id = h.id;
    if ((h.report_len || 0) >= ESSAY_MIN_LEN) li.classList.add("has-essay");
    li.innerHTML =
      `<div class="hike-title"></div><div class="hike-meta"></div>`;
    li.querySelector(".hike-title").textContent = h.mountain;
    li.querySelector(".hike-meta").textContent =
      `${h.date || ""} · ${h.distance_km} km · ↑${h.elevation_gain_m} m`;
    li.addEventListener("click", () => selectHike(h.id));
    ul.appendChild(li);
  }
}

document.getElementById("search").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  const filtered = q
    ? hikes.filter(
        (h) =>
          h.mountain.toLowerCase().includes(q) ||
          (h.title || "").toLowerCase().includes(q) ||
          (h.date || "").includes(q)
      )
    : hikes;
  renderList(filtered);
  renderStats(filtered);
});

// ---------- markers ----------
function renderMarkers(list) {
  for (const h of list) {
    const el = document.createElement("div");
    el.className = "hike-marker";
    const label = document.createElement("div");
    label.className = "hike-marker-label";
    label.textContent = h.mountain;
    el.appendChild(label);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      selectHike(h.id, { fromMarker: true });
    });
    const m = new maplibregl.Marker({ element: el }).setLngLat(h.marker).addTo(map);
    m.getElement().__label = label;
    markers.set(h.id, m);
  }
  scheduleLabelLayout();
}

// ---------- label collision ----------
// 같은 들머리에서 출발한 산행들은 마커가 몇 m 안에 겹쳐서 라벨이 서로를
// 가린다. 줌인하면 라벨을 세로로 어긋나게 쌓아 전부 읽히게 하고, 전국
// 뷰처럼 자리가 없을 때만 최신 산행 순으로 우선 노출한다.
const LABEL_STACK_ZOOM = 11;
const LABEL_STACK_OFFSETS = [-2, 12, -16, 26, -30, 40];

function scheduleLabelLayout() {
  if (scheduleLabelLayout.pending) return;
  scheduleLabelLayout.pending = true;
  requestAnimationFrame(() => {
    scheduleLabelLayout.pending = false;
    layoutLabels();
  });
}

function layoutLabels() {
  const offsets = map.getZoom() >= LABEL_STACK_ZOOM ? LABEL_STACK_OFFSETS : [LABEL_STACK_OFFSETS[0]];
  const vw = window.innerWidth, vh = window.innerHeight;

  // 마커가 수백 개라 읽기/쓰기를 섞으면 프레임마다 레이아웃이 재계산된다.
  // 측정은 한 번에 몰아서 하고, 스타일 변경은 그 뒤에만.
  const candidates = [];
  for (const h of hikes) {
    const marker = markers.get(h.id);
    if (!marker) continue;
    const el = marker.getElement();
    const label = el.__label;
    const dot = el.getBoundingClientRect();
    if (dot.right < 0 || dot.left > vw || dot.bottom < 0 || dot.top > vh) {
      candidates.push({ label, fit: undefined });
      continue;
    }
    if (label.__w === undefined) {
      label.__w = label.offsetWidth;
      label.__h = label.offsetHeight;
    }
    candidates.push({ label, x: dot.left + 18, y: dot.top, w: label.__w, h: label.__h });
  }

  const placed = [];
  for (const c of candidates) {
    if (c.w === undefined) continue;
    c.fit = offsets.find((dy) => {
      const t = c.y + dy, b = t + c.h, r = c.x + c.w;
      return !placed.some((p) => c.x < p.r && r > p.l && t < p.b && b > p.t);
    });
    if (c.fit !== undefined) {
      placed.push({ l: c.x, t: c.y + c.fit, r: c.x + c.w, b: c.y + c.fit + c.h });
    }
  }

  for (const c of candidates) {
    if (c.fit === undefined) {
      c.label.classList.add("hidden");
    } else {
      c.label.style.top = `${c.fit}px`;
      c.label.classList.remove("hidden");
    }
  }
}

for (const ev of ["move", "zoom", "rotate", "pitch", "resize", "idle"]) {
  map.on(ev, scheduleLabelLayout);
}

// ---------- mobile bottom sheet ----------
const sidebar = document.getElementById("sidebar");
const mobileQuery = window.matchMedia("(max-width: 720px)");
const isMobile = () => mobileQuery.matches;

if (isMobile()) sidebar.classList.add("collapsed");
mobileQuery.addEventListener("change", (e) => {
  if (!e.matches) sidebar.classList.remove("collapsed");
});

document.querySelector("#sidebar header").addEventListener("click", (e) => {
  if (!isMobile()) return;
  if (e.target.closest("input, a")) return;
  const opening = sidebar.classList.contains("collapsed");
  sidebar.classList.toggle("collapsed");
  // 목록 시트가 펼쳐지면 산행 카드는 닫는다 — 활성 시트는 항상 하나
  if (opening) {
    collapseReport();
    document.getElementById("hike-card").classList.add("hidden");
  }
});

// ---------- track ----------
// 모바일에서는 화면이 좁고 바텀 시트가 하단을 덮으므로 padding을
// 화면 크기에 맞춰 계산한다. 고정 padding(left 360)이 지도 폭보다
// 크면 MapLibre가 fitBounds를 통째로 무시해 애니메이션이 안 된다.
function trackPadding() {
  const h = window.innerHeight;
  if (isMobile()) {
    return { top: 70, bottom: Math.round(h * 0.16), left: 28, right: 28 };
  }
  return { top: 80, bottom: 80, left: 360, right: 100 };
}

// 모바일: 목록에서 고르면 비행 애니메이션이 가려지지 않게 카드를 띄우지
// 않고, 지도 위 마커(점)를 터치했을 때만 산행 요약 카드를 보여준다.
async function selectHike(id, { fromMarker = false } = {}) {
  const h = hikes.find((x) => x.id === id);
  if (!h) return;
  activeHikeId = id;

  if (isMobile()) sidebar.classList.add("collapsed");

  document.querySelectorAll("#hike-list li").forEach((li) => {
    li.classList.toggle("active", li.dataset.id === id);
  });

  const res = await fetch(`data/tracks/${id}.json`);
  const feature = await res.json();
  await mapReady;
  if (activeHikeId !== id) return; // 기다리는 사이 다른 산행을 선택함

  if (map.getLayer("track-line")) map.removeLayer("track-line");
  if (map.getLayer("track-casing")) map.removeLayer("track-casing");
  if (map.getSource("track")) map.removeSource("track");

  map.addSource("track", { type: "geojson", data: feature });
  map.addLayer({
    id: "track-casing",
    type: "line",
    source: "track",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#14171c", "line-width": 7, "line-opacity": 0.6 },
  });
  map.addLayer({
    id: "track-line",
    type: "line",
    source: "track",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ff5c3a", "line-width": 3.5 },
  });

  const [w, s, e, n] = h.bounds;
  map.fitBounds([[w, s], [e, n]], {
    padding: trackPadding(),
    pitch: 62,
    bearing: -18,
    duration: 2600,
    essential: true,
  });

  if (!isMobile() || fromMarker) {
    showCard(h, feature.properties.profile || []);
  } else {
    collapseReport();
    document.getElementById("hike-card").classList.add("hidden");
  }
}

// ---------- report (산행기 본문) ----------
const cardEl = document.getElementById("hike-card");
const reportBox = document.getElementById("report-box");
const reportTextEl = document.getElementById("report-text");
const reportToggle = document.getElementById("report-toggle");
const reportCache = new Map();

// 800자 이상이면 본격 산행기(에세이), 그 미만은 코스·거리 위주 정보형 글
const ESSAY_MIN_LEN = 800;
let reportLabel = "산행기 읽기";

function reportIdFromUrl(url) {
  const m = /woosengzlsamo\/(\w+)\/(\w+)/.exec(url || "");
  return m ? `${m[1]}_${m[2]}` : null;
}

function fetchReport(rid) {
  if (!reportCache.has(rid)) {
    const p = fetch(`data/reports/${rid}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    reportCache.set(rid, p);
  }
  return reportCache.get(rid);
}

function collapseReport() {
  cardEl.classList.remove("expanded");
  reportBox.classList.add("hidden");
  reportToggle.textContent = reportLabel;
}

function expandReport() {
  cardEl.classList.add("expanded");
  reportBox.classList.remove("hidden");
  reportToggle.textContent = "접기";
  reportBox.scrollTop = 0;
}

reportToggle.addEventListener("click", () => {
  cardEl.classList.contains("expanded") ? collapseReport() : expandReport();
});

// 본문이 사진 위주(글 100자 미만)면 펼치기 대신 카페 링크만 남긴다
async function updateReport(h) {
  reportToggle.classList.add("hidden");
  reportTextEl.textContent = "";
  const rid = reportIdFromUrl(h.cafe_url);
  const rep = rid ? await fetchReport(rid) : null;
  if (activeHikeId !== h.id) return;
  if (rep && rep.text_len >= 100) {
    reportLabel = rep.text_len >= ESSAY_MIN_LEN ? "산행기 읽기" : "코스 정보 보기";
    reportTextEl.textContent = rep.text;
    reportToggle.classList.remove("hidden");
    reportToggle.classList.toggle("info", rep.text_len < ESSAY_MIN_LEN);
    reportToggle.textContent = cardEl.classList.contains("expanded") ? "접기" : reportLabel;
    reportBox.scrollTop = 0;
  } else {
    collapseReport();
    if (rep && rep.img_count > 0) {
      document.getElementById("card-link").textContent = `사진 ${rep.img_count}장 · 카페에서 보기 →`;
    }
  }
}

// ---------- card ----------
function showCard(h, profile) {
  document.getElementById("card-title").textContent = h.title;
  document.getElementById("card-date").textContent = h.date || "";
  document.getElementById("card-dist").innerHTML = `거리 <b>${h.distance_km} km</b>`;
  document.getElementById("card-gain").innerHTML = `상승 <b>${h.elevation_gain_m} m</b>`;
  document.getElementById("card-ele").innerHTML =
    h.ele_max != null ? `최고 <b>${h.ele_max} m</b>` : "";
  const link = document.getElementById("card-link");
  if (h.cafe_url) {
    link.href = h.cafe_url;
    link.classList.remove("disabled");
    link.textContent = "카페 원문 →";
  } else {
    link.href = "#";
    link.classList.add("disabled");
    link.textContent = "산행기 링크 없음";
  }
  drawProfile(profile || []);
  updateReport(h);
  document.getElementById("hike-card").classList.remove("hidden");
}

function drawProfile(profile) {
  const canvas = document.getElementById("profile");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (profile.length < 2) return;

  const xs = profile.map((p) => p[0]);
  const ys = profile.map((p) => p[1]);
  const xMax = Math.max(...xs) || 1;
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const pad = 8;
  const sx = (x) => pad + (x / xMax) * (W - pad * 2);
  const sy = (y) => H - pad - ((y - yMin) / Math.max(1, yMax - yMin)) * (H - pad * 2);

  ctx.beginPath();
  ctx.moveTo(sx(xs[0]), H - pad);
  for (let i = 0; i < profile.length; i++) ctx.lineTo(sx(xs[i]), sy(ys[i]));
  ctx.lineTo(sx(xs[xs.length - 1]), H - pad);
  ctx.closePath();
  ctx.fillStyle = "rgba(232, 163, 61, 0.25)";
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < profile.length; i++) {
    i === 0 ? ctx.moveTo(sx(xs[i]), sy(ys[i])) : ctx.lineTo(sx(xs[i]), sy(ys[i]));
  }
  ctx.strokeStyle = "#e8a33d";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = "#9aa3ad";
  ctx.font = "10px sans-serif";
  ctx.fillText(`${Math.round(yMax)}m`, pad + 2, sy(yMax) + 10);
  ctx.fillText(`${xMax.toFixed(1)}km`, W - 44, H - pad - 4);
}

document.getElementById("card-close").addEventListener("click", () => {
  collapseReport();
  document.getElementById("hike-card").classList.add("hidden");
});

document.getElementById("reset-view").addEventListener("click", () => {
  map.flyTo({ ...KOREA_VIEW, duration: 2200, essential: true });
  collapseReport();
  document.getElementById("hike-card").classList.add("hidden");
  activeHikeId = null;
  document.querySelectorAll("#hike-list li.active").forEach((li) =>
    li.classList.remove("active")
  );
});

// 지도 load 이벤트(렌더 프레임 의존)와 무관하게 목록/마커는 바로 채운다
loadHikes();
