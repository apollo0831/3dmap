"use strict";

// 가상 트래킹 — GPS 시각과 궤적을 따라 드론 시점으로 산행을 재생한다.
//
// 세 층으로 나뉜다.
//  1. 타임라인: GPS 실제 시각(시계 표시용)과 재생 시각(휴식 구간을 압축)을 분리.
//  2. 카메라: 매 프레임 등산객 위치·진행 방향·고도에서 카메라 위치를 계산해
//     map.calculateCameraOptionsFromTo → jumpTo. 줌을 직접 다루지 않고 "등산객
//     위 몇 m" 로 지정하므로 화면 크기·위도와 무관하게 같은 높이가 유지된다.
//  3. HUD: 재생 조작, GPS 시계, 고도 프로필 위 진행 커서, 자막.
const Trek = (() => {
  const SPEEDS = [30, 60, 120, 240];
  const DEFAULT_SPEED = 60;

  // 타임라인
  const GAP_CAP_S = 150;      // 재생 시간에서 한 구간이 차지하는 최대 길이 (휴식 압축)
  const REST_MIN_S = 180;     // 이 이상 멈추면 "휴식" 자막
  const WALK_MPS = 3.5 / 3.6; // 시각 없는 트랙 합성: 평지 시속 3.5 km
  const CLIMB_S_PER_M = 6;    //  + 10 m 상승당 1분

  // 카메라
  const EXAGGERATION = 1.4;   // app.js setTerrain 과 일치
  const LOOK_BACK_M = 40, LOOK_AHEAD_M = 220;
  const ALT_NEAR = 380, ALT_FAR = 1300;     // 등산객 위 카메라 높이 (m)
  const PITCH_NEAR = 62, PITCH_FAR = 56;    // 도(°). 높이 올라갈수록 조금 내려다본다
  const TAU_TARGET = 0.5, TAU_BEARING = 2.5, TAU_ALT = 4; // 지수 평활 시간상수 (초)
  const MAX_TURN_DEG_S = 20;
  const ORBIT_DEG_S = 6;      // 휴식 중 느린 궤도 회전
  const CAM_CLEARANCE_M = 120; // 카메라와 그 아래 지형의 최소 여유
  const INTRO_MS = 3800, RESUME_MS = 1200, OUTRO_MS = 3000;

  let map = null, hike = null, feature = null;
  let pts = [], cum = [], tReal = [], tPlay = [], resting = [], vista = [];
  let totalPlay = 0, totalDist = 0, startDate = null;
  let vt = 0, speed = DEFAULT_SPEED;
  let phase = "idle"; // idle | intro | play | pause | user | outro | done
  let raf = 0, lastTs = 0;
  let cam = { bearing: 0, alt: ALT_NEAR, tgt: null, orbit: 0 };
  let restCaptionKey = null;
  let onStop = null;
  let ui = null, profileImg = null;

  // ---------- 기하 ----------
  const R = 6371000, D2R = Math.PI / 180;
  function haversine(a, b) {
    const p1 = a[1] * D2R, p2 = b[1] * D2R;
    const dp = p2 - p1, dl = (b[0] - a[0]) * D2R;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearingBetween(a, b) {
    const p1 = a[1] * D2R, p2 = b[1] * D2R, dl = (b[0] - a[0]) * D2R;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return ((Math.atan2(y, x) / D2R) + 360) % 360;
  }
  function offset(p, bearingDeg, distM) {
    const br = bearingDeg * D2R, d = distM / R;
    const p1 = p[1] * D2R, l1 = p[0] * D2R;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br));
    const l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [l2 / D2R, p2 / D2R];
  }
  const lerp = (a, b, f) => a + (b - a) * f;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // 지수 평활: dt 초 동안 시간상수 tau 로 목표에 접근
  const ease = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));
  function easeAngle(cur, target, dt, tau, maxRate) {
    let d = ((target - cur + 540) % 360) - 180;
    const step = d * (1 - Math.exp(-dt / tau));
    const cap = maxRate * dt;
    return (cur + clamp(step, -cap, cap) + 360) % 360;
  }
  // 정렬된 배열에서 v 가 속한 구간 인덱스 i (arr[i] <= v < arr[i+1])
  function locate(arr, v) {
    let lo = 0, hi = arr.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid] <= v) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // ---------- 타임라인 ----------
  function buildTimeline(f) {
    pts = f.geometry.coordinates;
    cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
    totalDist = cum[cum.length - 1];

    let times = f.properties.times;
    if (!times || times.length !== pts.length) {
      // 시각 없음: 거리와 상승고도로 합성 (Naismith)
      times = [0];
      for (let i = 1; i < pts.length; i++) {
        const up = Math.max(0, (pts[i][2] ?? 0) - (pts[i - 1][2] ?? 0));
        times.push(times[i - 1] + (cum[i] - cum[i - 1]) / WALK_MPS + up * CLIMB_S_PER_M);
      }
      startDate = null;
    } else {
      startDate = f.properties.start_time ? new Date(f.properties.start_time) : null;
    }
    tReal = times;
    tPlay = [0]; resting = [];
    for (let i = 1; i < pts.length; i++) {
      const dt = Math.max(0, tReal[i] - tReal[i - 1]);
      resting.push(dt >= REST_MIN_S && cum[i] - cum[i - 1] < 150);
      tPlay.push(tPlay[i - 1] + Math.min(dt, GAP_CAP_S));
    }
    totalPlay = tPlay[tPlay.length - 1];

    // 전망 점수: 정규화한 고도를 ±300 m 창으로 평활. 정상·능선에서 카메라가 뒤로 빠진다
    const eles = pts.map((p) => p[2] ?? 0);
    const eMin = Math.min(...eles), eMax = Math.max(...eles);
    vista = eles.map((e, i) => {
      let s = 0, n = 0;
      for (let j = i; j >= 0 && cum[i] - cum[j] < 300; j--) { s += eles[j]; n++; }
      for (let j = i + 1; j < pts.length && cum[j] - cum[i] < 300; j++) { s += eles[j]; n++; }
      const v = eMax > eMin ? (s / n - eMin) / (eMax - eMin) : 0.3;
      return v * v; // 낮은 곳은 바싹, 높은 곳만 크게 빠지도록 제곱
    });
  }

  function posAtPlay(t) {
    const i = locate(tPlay, t);
    const span = tPlay[i + 1] - tPlay[i];
    const f = span > 0 ? clamp((t - tPlay[i]) / span, 0, 1) : 1;
    const a = pts[i], b = pts[i + 1];
    return {
      i, f,
      lng: lerp(a[0], b[0], f), lat: lerp(a[1], b[1], f),
      ele: lerp(a[2] ?? 0, b[2] ?? 0, f),
      dist: lerp(cum[i], cum[i + 1], f),
      real: lerp(tReal[i], tReal[i + 1], f),
      resting: resting[i],
      restLen: tReal[i + 1] - tReal[i],
      vista: lerp(vista[i], vista[i + 1], f),
    };
  }
  function posAtDist(d) {
    d = clamp(d, 0, totalDist);
    const i = locate(cum, d);
    const span = cum[i + 1] - cum[i];
    const f = span > 0 ? (d - cum[i]) / span : 0;
    return [lerp(pts[i][0], pts[i + 1][0], f), lerp(pts[i][1], pts[i + 1][1], f)];
  }

  // ---------- 지형 ----------
  function groundElev(lngLat, fallbackEle) {
    // 4.7.1의 queryTerrainElevation 은 화면 중심 고도를 뺀 상대값이라 terrain 객체를 직접 쓴다
    const t = map.terrain;
    if (t) {
      const e = t.getElevationForLngLatZoom(maplibregl.LngLat.convert(lngLat), map.transform.tileZoom);
      // 타일 미로딩 시 0 근처가 나오므로 GPS 고도와 크게 어긋나면 GPS 를 신뢰
      if (Number.isFinite(e) && (fallbackEle == null || Math.abs(e - fallbackEle * EXAGGERATION) < 400)) return e;
    }
    return fallbackEle != null ? fallbackEle * EXAGGERATION : 0;
  }

  // ---------- 카메라 ----------
  function headingAt(p) {
    const a = posAtDist(p.dist - LOOK_BACK_M), b = posAtDist(p.dist + LOOK_AHEAD_M);
    return haversine(a, b) > 5 ? bearingBetween(a, b) : cam.bearing;
  }

  // 현재 평활 상태에서 카메라 옵션을 만든다. dt=0 이면 상태를 갱신하지 않는다 (인트로용)
  function cameraOptions(p, dt) {
    if (!cam.tgt) cam.tgt = [p.lng, p.lat];
    if (dt > 0) {
      const k = 1 - Math.exp(-dt / TAU_TARGET);
      cam.tgt = [cam.tgt[0] + (p.lng - cam.tgt[0]) * k, cam.tgt[1] + (p.lat - cam.tgt[1]) * k];
      const hdg = headingAt(p);
      if (p.resting) {
        cam.orbit += ORBIT_DEG_S * dt;
        cam.bearing = easeAngle(cam.bearing, hdg + cam.orbit, dt, TAU_BEARING, MAX_TURN_DEG_S);
      } else {
        cam.orbit = ease(cam.orbit, 0, dt, TAU_BEARING);
        cam.bearing = easeAngle(cam.bearing, hdg, dt, TAU_BEARING, MAX_TURN_DEG_S);
      }
      cam.alt = ease(cam.alt, lerp(ALT_NEAR, ALT_FAR, p.vista), dt, TAU_ALT);
    }
    const pitch = lerp(PITCH_NEAR, PITCH_FAR, (cam.alt - ALT_NEAR) / (ALT_FAR - ALT_NEAR));
    const tgtElev = groundElev(cam.tgt, p.ele);
    const camLL = offset(cam.tgt, cam.bearing + 180, cam.alt * Math.tan(pitch * D2R));
    let camAlt = tgtElev + cam.alt;
    // 뒤쪽 사면이 카메라보다 높으면 카메라를 띄운다 (피치는 자동으로 얕아진다)
    const camGround = groundElev(camLL, null);
    if (camAlt < camGround + CAM_CLEARANCE_M) camAlt = camGround + CAM_CLEARANCE_M;
    return map.calculateCameraOptionsFromTo(
      maplibregl.LngLat.convert(camLL), camAlt, maplibregl.LngLat.convert(cam.tgt), tgtElev
    );
  }

  function resetCamera(p) {
    cam = { bearing: 0, alt: lerp(ALT_NEAR, ALT_FAR, p.vista), tgt: [p.lng, p.lat], orbit: 0 };
    cam.bearing = headingAt(p);
  }

  // ---------- 지도 레이어 ----------
  function ensureLayers() {
    if (!map.getSource("trek-hiker")) {
      map.addSource("trek-hiker", { type: "geojson", data: { type: "Point", coordinates: pts[0] } });
      map.addLayer({
        id: "trek-hiker-halo", type: "circle", source: "trek-hiker",
        paint: { "circle-radius": 16, "circle-color": "#ffd166", "circle-opacity": 0.25, "circle-blur": 0.6 },
      });
      map.addLayer({
        id: "trek-hiker", type: "circle", source: "trek-hiker",
        paint: { "circle-radius": 6, "circle-color": "#ffd166", "circle-stroke-color": "#14171c", "circle-stroke-width": 2 },
      });
    }
  }
  function removeLayers() {
    for (const id of ["trek-hiker", "trek-hiker-halo"]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource("trek-hiker")) map.removeSource("trek-hiker");
    if (map.getLayer("track-line")) map.setPaintProperty("track-line", "line-gradient", null);
  }
  function updateHiker(p) {
    const src = map.getSource("trek-hiker");
    if (src) src.setData({ type: "Point", coordinates: [p.lng, p.lat] });
    // 지나온 길은 밝게, 남은 길은 흐리게 — line-progress 는 길이 비율이므로 거리 비율로 대응
    if (map.getLayer("track-line") && totalDist > 0) {
      const frac = clamp(p.dist / totalDist, 0.0001, 0.9999);
      map.setPaintProperty("track-line", "line-gradient", [
        "step", ["line-progress"], "#ffd166", frac, "rgba(255,92,58,0.45)",
      ]);
    }
    const halo = 10 + 6 * Math.sin(performance.now() / 300);
    if (map.getLayer("trek-hiker-halo")) map.setPaintProperty("trek-hiker-halo", "circle-radius", halo);
  }

  // ---------- HUD ----------
  function buildUI() {
    if (ui) return;
    const root = document.getElementById("trek-hud");
    ui = {
      root,
      play: root.querySelector("#trek-play"),
      speed: root.querySelector("#trek-speed"),
      clock: root.querySelector("#trek-clock"),
      dist: root.querySelector("#trek-dist"),
      ele: root.querySelector("#trek-ele"),
      title: root.querySelector("#trek-title"),
      canvas: root.querySelector("#trek-profile"),
      caption: document.getElementById("trek-caption"),
      exit: root.querySelector("#trek-exit"),
    };
    ui.play.addEventListener("click", togglePlay);
    ui.speed.addEventListener("click", cycleSpeed);
    ui.exit.addEventListener("click", stop);
    ui.canvas.addEventListener("click", (e) => {
      const r = ui.canvas.getBoundingClientRect();
      seekTo(((e.clientX - r.left) / r.width) * totalPlay);
    });
    document.addEventListener("keydown", onKey);
    // 사용자가 지도를 직접 움직이면 일시정지. jumpTo 는 originalEvent 가 없어 구분된다
    map.on("movestart", onUserMove);
  }
  function onUserMove(e) {
    if (e.originalEvent && (phase === "play" || phase === "pause")) {
      phase = "user";
      ui.play.textContent = "▶";
      ui.root.classList.add("detached");
    }
  }
  function onKey(e) {
    if (phase === "idle" || e.target.matches("input, textarea")) return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.key === "ArrowRight") seekTo(vt + 60 * 10);
    else if (e.key === "ArrowLeft") seekTo(vt - 60 * 10);
    else if (e.key === "+" || e.key === "=") cycleSpeed(1);
    else if (e.key === "-") cycleSpeed(-1);
    else if (e.key === "Escape") stop();
  }
  function cycleSpeed(dir) {
    const i = SPEEDS.indexOf(speed);
    speed = SPEEDS[(i + (dir === -1 ? -1 : 1) + SPEEDS.length) % SPEEDS.length];
    ui.speed.textContent = `${speed}×`;
  }
  function fmtClock(realSec) {
    if (startDate) {
      const d = new Date(startDate.getTime() + realSec * 1000);
      return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Seoul" });
    }
    const h = Math.floor(realSec / 3600), m = Math.floor((realSec % 3600) / 60);
    return `+${h}:${String(m).padStart(2, "0")}`;
  }
  function fmtDuration(sec) {
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h}시간 ${m}분` : `${m}분`;
  }
  function caption(text, ms) {
    ui.caption.textContent = text;
    ui.caption.classList.add("show");
    clearTimeout(caption.timer);
    if (ms) caption.timer = setTimeout(() => ui.caption.classList.remove("show"), ms);
  }
  function hideCaption() { clearTimeout(caption.timer); ui.caption.classList.remove("show"); }

  function renderProfileBase() {
    const c = ui.canvas, ctx = c.getContext("2d");
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    const prof = feature.properties.profile || [];
    if (prof.length >= 2) {
      const xMax = prof[prof.length - 1][0] || 1;
      const ys = prof.map((p) => p[1]);
      const yMin = Math.min(...ys), yMax = Math.max(...ys);
      const sx = (x) => (x / xMax) * W;
      const sy = (y) => H - 3 - ((y - yMin) / Math.max(1, yMax - yMin)) * (H - 8);
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (const p of prof) ctx.lineTo(sx(p[0]), sy(p[1]));
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = "rgba(232,163,61,0.28)";
      ctx.fill();
      ctx.beginPath();
      prof.forEach((p, i) => (i ? ctx.lineTo(sx(p[0]), sy(p[1])) : ctx.moveTo(sx(p[0]), sy(p[1]))));
      ctx.strokeStyle = "#e8a33d"; ctx.lineWidth = 1.5; ctx.stroke();
    }
    profileImg = ctx.getImageData(0, 0, W, H);
  }
  function updateHUD(p) {
    ui.clock.textContent = fmtClock(p.real);
    ui.dist.textContent = `${(p.dist / 1000).toFixed(1)} km`;
    ui.ele.textContent = `${Math.round(p.ele)} m`;
    const c = ui.canvas, ctx = c.getContext("2d");
    if (profileImg) ctx.putImageData(profileImg, 0, 0);
    const x = totalDist > 0 ? (p.dist / totalDist) * c.width : 0;
    ctx.fillStyle = "rgba(255,209,102,0.18)";
    ctx.fillRect(0, 0, x, c.height);
    ctx.fillStyle = "#ffd166";
    ctx.fillRect(x - 1, 0, 2, c.height);

    if (p.resting && phase === "play") {
      const key = p.i;
      if (restCaptionKey !== key) {
        restCaptionKey = key;
        caption(`휴식 · ${fmtDuration(p.restLen)}`, 0);
      }
    } else if (restCaptionKey !== null) {
      restCaptionKey = null;
      hideCaption();
    }
  }

  // ---------- 재생 루프 ----------
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    // 백그라운드 탭처럼 프레임이 드문 환경에서도 시간은 벽시계대로 흐르되, 탭 복귀 시 튀지 않게 1초로 제한
    const dt = lastTs ? Math.min((ts - lastTs) / 1000, 1) : 0.016;
    lastTs = ts;
    if (phase !== "play" && phase !== "pause") return;

    if (phase === "play") vt = Math.min(totalPlay, vt + dt * speed);
    const p = posAtPlay(vt);
    // MapLibre 4.7.1: flyTo/easeTo 가 지형 고도 갱신을 잠근 뒤(freezeElevation 없이는) 풀지 않아
    // 화면 중심 고도가 애니메이션 시작 시점의 거친 값에 고정된다. 카메라를 우리가 쥐는 동안은 매 프레임 푼다.
    map._elevationFreeze = false;
    map.jumpTo(cameraOptions(p, dt));
    updateHiker(p);
    updateHUD(p);
    if (phase === "play" && vt >= totalPlay) finish();
  }

  function togglePlay() {
    if (phase === "play") {
      phase = "pause";
      ui.play.textContent = "▶";
    } else if (phase === "pause") {
      phase = "play";
      ui.play.textContent = "❚❚";
    } else if (phase === "user") {
      // 사용자가 둘러본 뒤 재생: 카메라를 등산객 뒤로 날려 붙이고 이어간다
      ui.root.classList.remove("detached");
      const p = posAtPlay(vt);
      resetCamera(p);
      phase = "intro";
      map.flyTo({ ...cameraOptions(p, 0), duration: RESUME_MS, essential: true });
      map.once("moveend", () => { if (phase === "intro") { phase = "play"; ui.play.textContent = "❚❚"; lastTs = 0; } });
    } else if (phase === "done") {
      replay();
    }
  }
  function seekTo(t) {
    vt = clamp(t, 0, totalPlay);
    if (phase === "done") { phase = "pause"; ui.play.textContent = "▶"; hideCaption(); }
    if (phase === "pause" || phase === "user") {
      const p = posAtPlay(vt);
      updateHiker(p); updateHUD(p);
    }
  }

  function finish() {
    phase = "outro";
    ui.play.textContent = "↻";
    const [w, s, e, n] = hike.bounds;
    map.fitBounds([[w, s], [e, n]], {
      padding: { top: 90, bottom: 160, left: 60, right: 60 },
      pitch: 55, bearing: cam.bearing, duration: OUTRO_MS, essential: true,
    });
    const realTotal = tReal[tReal.length - 1];
    caption(`도착 ${fmtClock(realTotal)} · ${(totalDist / 1000).toFixed(1)} km · ${fmtDuration(realTotal)} · ↑${hike.elevation_gain_m} m`, 0);
    map.once("moveend", () => { if (phase === "outro") phase = "done"; });
  }
  function replay() {
    hideCaption();
    vt = 0;
    begin();
  }

  // 인트로: 현재 뷰에서 출발점 위로 날아간 뒤 재생 시작
  function begin() {
    const p = posAtPlay(vt);
    resetCamera(p);
    phase = "intro";
    ui.play.textContent = "❚❚";
    updateHiker(p); updateHUD(p);
    const when = startDate ? ` · ${fmtClock(0)} 출발` : "";
    caption(`${hike.mountain}${hike.date ? " · " + hike.date : ""}${when}`, INTRO_MS + 2500);
    map.flyTo({ ...cameraOptions(p, 0), duration: INTRO_MS, essential: true });
    const go = () => { if (phase === "intro") { phase = "play"; lastTs = 0; } };
    map.once("moveend", go);
    // 비행이 다른 이동에 끊겨 moveend 가 안 오더라도 재생은 시작한다
    setTimeout(go, INTRO_MS + 600);
  }

  // ---------- 공개 API ----------
  function start(mapInstance, h, f, opts = {}) {
    if (phase !== "idle") stop();
    map = mapInstance; hike = h; feature = f; onStop = opts.onStop || null;
    speed = DEFAULT_SPEED;
    vt = 0;
    buildTimeline(f);
    buildUI();
    ui.speed.textContent = `${speed}×`;
    ui.title.textContent = h.mountain;
    ui.root.classList.remove("hidden", "detached");
    document.body.classList.add("trekking");
    renderProfileBase();
    ensureLayers();
    lastTs = 0;
    if (!raf) raf = requestAnimationFrame(frame);
    begin();
  }

  function stop() {
    if (phase === "idle") return;
    phase = "idle";
    cancelAnimationFrame(raf); raf = 0;
    hideCaption();
    ui.root.classList.add("hidden");
    document.body.classList.remove("trekking");
    map.off("movestart", onUserMove);
    map.stop();
    removeLayers();
    // 다음 start 에서 다시 등록되도록
    const cb = onStop; onStop = null;
    ui.root.classList.remove("detached");
    ui = null;
    document.removeEventListener("keydown", onKey);
    if (cb) cb();
  }

  const isActive = () => phase !== "idle";

  return { start, stop, isActive };
})();
