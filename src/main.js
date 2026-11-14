import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { gpx } from '@tmcw/togeojson';
import distance from '@turf/distance';
import { computeStats, fmt, fmtDuration } from './stats.js';
import './style.css';

const $ = (sel) => document.querySelector(sel);
const COLORS = { facile: '#2e5b4e', media: '#b7791f', impegnativa: '#9b2c2c' };

// ---------- Mappa ----------
const map = L.map('map').setView([44.873807, 8.285832], 14);
const OSM = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const DEFAULT_BASE = 'Topografica (OpenTopoMap)';

const BASES = {
  [DEFAULT_BASE]: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxNativeZoom: 17, maxZoom: 19,
    attribution: `${OSM}, SRTM | stile © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
  }),
  'Standard OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: OSM,
  }),
  'CyclOSM (sentieri e ciclabili)': L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: `${OSM} | stile © <a href="https://www.cyclosm.org">CyclOSM</a>`,
  }),
  'Umanitaria (HOT)': L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: `${OSM} | stile © <a href="https://www.hotosm.org">HOT</a>, ospitato da OpenStreetMap France`,
  }),
};

const OVERLAYS = {
  'Sentieri segnalati (Waymarked Trails)': L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', {
    maxNativeZoom: 18, maxZoom: 19, opacity: 0.7,
    attribution: '© <a href="https://waymarkedtrails.org">Waymarked Trails</a> (CC-BY-SA)',
  }),
};

// ricorda l'ultima mappa scelta
let savedBase = null;
try { savedBase = localStorage.getItem('baseMap'); } catch { /* storage non disponibile */ }
(BASES[savedBase] ?? BASES[DEFAULT_BASE]).addTo(map);
L.control.layers(BASES, OVERLAYS).addTo(map);
map.on('baselayerchange', (e) => {
  try { localStorage.setItem('baseMap', e.name); } catch { /* ignora */ }
});

// ---------- Stato ----------
let routes = [];            // metadati + layer + coordinate
let pois = [];              // { feature, marker }
let selectedId = null;

// ---------- Caricamento dati ----------
async function load() {
  const [routesMeta, poiData] = await Promise.all([
    fetch('data/routes.json').then((r) => r.json()),
    fetch('data/pois.geojson').then((r) => r.json()),
  ]);

  for (const base of routesMeta) {
    const xml = await fetch(`data/gpx/${base.gpx}`).then((r) => r.text());
    const geo = gpx(new DOMParser().parseFromString(xml, 'text/xml'));
    const track = geo.features.find((f) => /LineString/.test(f.geometry?.type));
    const multi = track.geometry.type === 'MultiLineString';
    const line = multi ? track.geometry.coordinates.flat() : track.geometry.coordinates;
    const times = (track.properties.coordinateProperties?.times ?? []).flat();

    // lunghezza e dislivello vengono calcolati dal GPX (i valori in routes.json sono solo un ripiego)
    const stats = computeStats(line, times);
    const meta = {
      ...base,
      km: Math.round(stats.km * 10) / 10,
      ascent: stats.hasEle ? Math.round(stats.ascent) : base.ascent,
    };

    const coords = line.map(([lng, lat]) => [lat, lng]);
    const layer = L.polyline(coords, { color: COLORS[meta.difficulty], weight: 5, opacity: 0.85 });
    layer.bindPopup(routePopupHtml(meta, stats), { minWidth: 270, maxWidth: 320 });
    layer.on('click', () => { selectedId = meta.id; applyFilters(); });
    layer.on('popupopen', (e) => attachProfileHover(e.popup, stats.profile));
    layer.on('popupclose', hideHover);
    routes.push({ ...meta, coords, layer, markers: endpoints(meta, coords) });
  }

  pois = poiData.features.map((f) => {
    const [lng, lat] = f.geometry.coordinates;
    const marker = L.marker([lat, lng]).bindPopup(popupHtml(f.properties));
    return { feature: f, marker };
  });

  applyFilters();
}

// Marker automatici di inizio e fine, presi dal primo e dall'ultimo punto del GPX.
// Se il percorso è ad anello (partenza e arrivo a meno di 50 m) ne basta uno solo.
function endpoints(meta, coords) {
  const first = coords[0];
  const last = coords[coords.length - 1];
  const isLoop = distance([first[1], first[0]], [last[1], last[0]], { units: 'meters' }) < 50;
  const make = (pt, cls, label, width, tip) =>
    L.marker(pt, {
      icon: L.divIcon({ className: '', html: `<div class="pin ${cls}">${label}</div>`, iconSize: [width, 26] }),
      keyboard: false,
    }).bindTooltip(`${meta.name}: ${tip}`);
  return isLoop
    ? [make(first, 'pin-start', 'I/F', 38, 'inizio e fine')]
    : [make(first, 'pin-start', 'I', 26, 'inizio'), make(last, 'pin-end', 'F', 26, 'fine')];
}

// ---------- Popup del percorso: dati e profilo altimetrico ----------
const PROF = { W: 290, H: 120, PL: 40, PR: 8, PT: 8, PB: 20 }; // misure del grafico (viewBox)
let hoverMarker = null; // pallino sulla mappa che segue il mouse sul profilo

function showHover(lat, lng) {
  if (!hoverMarker) {
    hoverMarker = L.circleMarker([lat, lng], {
      radius: 8, color: '#fff', weight: 3, fillColor: '#b7791f', fillOpacity: 1, interactive: false,
    });
  }
  hoverMarker.setLatLng([lat, lng]);
  if (!map.hasLayer(hoverMarker)) hoverMarker.addTo(map);
  hoverMarker.bringToFront();
}
const hideHover = () => hoverMarker?.remove();

// Collega il grafico del popup alla mappa: muovendo il mouse (o il dito) sul profilo
// il pallino segue il punto corrispondente del percorso.
function attachProfileHover(popup, profile) {
  const svg = popup.getElement()?.querySelector('.prof');
  if (!svg) return;
  const { W, H, PL, PR, PT, PB } = PROF;
  const xMax = +svg.dataset.xmax, yMin = +svg.dataset.ymin, yMax = +svg.dataset.ymax;
  const cursor = svg.querySelector('.prof-cursor');
  const vline = cursor.querySelector('line');
  const dot = cursor.querySelector('circle');
  const label = cursor.querySelector('text');

  const update = (ev) => {
    const r = svg.getBoundingClientRect();
    const vx = ((ev.clientX - r.left) / r.width) * W;
    const km = Math.min(xMax, Math.max(0, ((vx - PL) / (W - PL - PR)) * xMax));
    // punto del profilo più vicino a quella distanza (ricerca binaria)
    let lo = 0, hi = profile.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (profile[mid][0] <= km) lo = mid; else hi = mid; }
    const p = Math.abs(profile[lo][0] - km) <= Math.abs(profile[hi][0] - km) ? profile[lo] : profile[hi];

    const x = PL + (p[0] / xMax) * (W - PL - PR);
    const y = PT + (1 - (p[1] - yMin) / (yMax - yMin)) * (H - PT - PB);
    vline.setAttribute('x1', x); vline.setAttribute('x2', x);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    label.textContent = `${fmt(p[0])} km · ${Math.round(p[1])} m`;
    label.setAttribute('x', x > W / 2 ? x - 6 : x + 6);
    label.setAttribute('text-anchor', x > W / 2 ? 'end' : 'start');
    label.setAttribute('y', PT + 10);
    cursor.classList.add('on');
    showHover(p[2], p[3]);
  };
  const clear = (ev) => {
    if (ev.pointerType === 'touch') return; // col dito il pallino resta dopo aver sollevato
    cursor.classList.remove('on');
    hideHover();
  };
  svg.addEventListener('pointermove', update);
  svg.addEventListener('pointerdown', update);
  svg.addEventListener('pointerleave', clear);
}

function profileSvg(profile) {
  const { W, H, PL, PR, PT, PB } = PROF;
  const xMax = profile[profile.length - 1][0] || 1;
  let yMin = Math.min(...profile.map((p) => p[1]));
  let yMax = Math.max(...profile.map((p) => p[1]));
  if (yMax - yMin < 20) { const mid = (yMax + yMin) / 2; yMin = mid - 10; yMax = mid + 10; }
  const px = (x) => (PL + (x / xMax) * (W - PL - PR)).toFixed(1);
  const py = (y) => (PT + (1 - (y - yMin) / (yMax - yMin)) * (H - PT - PB)).toFixed(1);
  const line = profile.map((p, i) => `${i ? 'L' : 'M'}${px(p[0])} ${py(p[1])}`).join(' ');
  const area = `${line} L${px(xMax)} ${H - PB} L${px(0)} ${H - PB} Z`;
  return `<svg class="prof" viewBox="0 0 ${W} ${H}" role="img" aria-label="Profilo altimetrico"
      data-xmax="${xMax}" data-ymin="${yMin}" data-ymax="${yMax}">
    <path class="prof-area" d="${area}"/>
    <line class="prof-axis" x1="${PL}" y1="${H - PB}" x2="${W - PR}" y2="${H - PB}"/>
    <path class="prof-line" d="${line}"/>
    <g class="prof-cursor"><line y1="${PT}" y2="${H - PB}"/><circle r="4"/><text></text></g>
    <text x="${PL - 4}" y="${PT + 4}" text-anchor="end">${Math.round(yMax)} m</text>
    <text x="${PL - 4}" y="${H - PB}" text-anchor="end">${Math.round(yMin)} m</text>
    <text x="${PL}" y="${H - 5}">0 km</text>
    <text x="${W - PR}" y="${H - 5}" text-anchor="end">${fmt(xMax)} km</text>
  </svg>`;
}

function routePopupHtml(meta, st) {
  const cell = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<div class="popup" style="--c:${COLORS[meta.difficulty]}">
    <h3>${meta.name}</h3>
    <div class="cat">${meta.difficulty} · ${meta.themes.join(', ')}</div>
    ${st.hasEle ? profileSvg(st.profile) : '<p class="note">Profilo altimetrico non disponibile: il GPX non contiene le quote.</p>'}
    <dl class="stats">
      ${cell('Lunghezza', `${fmt(st.km)} km`)}
      ${cell(st.estimated ? 'Durata (stima)' : 'Durata', fmtDuration(st.hours))}
      ${cell(st.estimated ? 'Velocità (stima)' : 'Velocità media', `${fmt(st.speed)} km/h`)}
      ${st.hasEle ? cell('Salita', `+${Math.round(st.ascent)} m`) + cell('Discesa', `−${Math.round(st.descent)} m`) + cell('Quota min–max', `${Math.round(st.min)}–${Math.round(st.max)} m`) : ''}
    </dl>
    ${st.estimated ? '<p class="note">Durata stimata: 5 km/h più 1 ora ogni 600 m di salita.</p>' : ''}
  </div>`;
}

function popupHtml(p) {
  return `<div class="popup">
    <h3>${p.title}</h3>
    <div class="cat">${p.category}</div>
    ${p.image ? `<img src="${p.image}" alt="" loading="lazy">` : ''}
    <p>${p.text}</p>
    ${p.audio ? `<audio controls src="${p.audio}"></audio>` : ''}
  </div>`;
}

// ---------- Filtri ----------
const checked = (name) => [...document.querySelectorAll(`input[name=${name}]:checked`)].map((i) => i.value);

function applyFilters() {
  const diffs = checked('diff');
  const themes = checked('theme');
  const maxKm = +$('#km').value;
  $('#kmOut').textContent = maxKm;

  const visible = routes.filter(
    (r) => diffs.includes(r.difficulty) && r.km <= maxKm && r.themes.some((t) => themes.includes(t))
  );
  const visibleIds = new Set(visible.map((r) => r.id));

  if (selectedId && !visibleIds.has(selectedId)) selectedId = null;

  routes.forEach((r) => {
    const on = visibleIds.has(r.id);
    const focus = r.id === selectedId;
    on ? r.layer.addTo(map) : r.layer.remove();
    r.markers.forEach((m) => (on ? m.addTo(map) : m.remove()));
    // percorso in focus: tratto più spesso; gli altri si attenuano leggermente
    r.layer.setStyle({ weight: focus ? 9 : 5, opacity: selectedId && !focus ? 0.6 : 0.9 });
    if (focus) r.layer.bringToFront();
  });

  // un POI è visibile se è un servizio, oppure se appartiene a un percorso visibile e al tema scelto
  pois.forEach(({ feature, marker }) => {
    const p = feature.properties;
    const show = p.category === 'servizi' || (p.routes.some((id) => visibleIds.has(id)) && themes.includes(p.category));
    show ? marker.addTo(map) : marker.remove();
  });

  renderList(visible);
}

function renderList(visible) {
  $('#count').textContent = `${visible.length} percorsi`;
  $('#routeList').innerHTML = visible
    .map(
      (r) => `<li>
        <button data-id="${r.id}" class="${r.id === selectedId ? 'on' : ''}" style="--c:${COLORS[r.difficulty]}">
          ${r.name}<small>${r.km} km · +${r.ascent} m · ${r.difficulty}</small></button>
        <a class="dl" href="data/gpx/${r.gpx}" download="${r.id}.gpx" aria-label="Scarica il GPX di ${r.name}">↓ GPX</a>
      </li>`
    )
    .join('');
}

function select(id) {
  selectedId = id;
  const r = routes.find((x) => x.id === id);
  map.fitBounds(r.layer.getBounds(), { padding: [40, 40] });
  r.layer.bringToFront();
  applyFilters();
}

document.addEventListener('change', (e) => e.target.closest('#panel') && applyFilters());
$('#km').addEventListener('input', applyFilters);
$('#routeList').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) select(b.dataset.id);
});

// ---------- Posizione e "seguimi" ----------
let userMarker = null;
let accuracyCircle = null;
let watchId = null;     // id di watchPosition (posizione reale)
let simTimer = null;    // timer del simulatore
let follow = false;     // la mappa segue l'utente?

const locateBtn = $('#locate');
const simBtn = $('#simulate');

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}

function updateLocateBtn() {
  const tracking = watchId !== null || simTimer !== null;
  locateBtn.textContent = !tracking ? 'Dove sono' : follow ? 'Interrompi' : 'Torna a seguirmi';
  locateBtn.classList.toggle('off', tracking && follow);
}

function setUser(lat, lng, accuracy) {
  if (!userMarker) {
    userMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [16, 16] }),
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(map);
  } else userMarker.setLatLng([lat, lng]);

  if (accuracy) {
    if (!accuracyCircle) {
      accuracyCircle = L.circle([lat, lng], { radius: accuracy, color: '#2563eb', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    } else accuracyCircle.setLatLng([lat, lng]).setRadius(accuracy);
  }
  if (follow) map.panTo([lat, lng], { animate: simTimer === null });
}

function clearUser() {
  userMarker?.remove(); userMarker = null;
  accuracyCircle?.remove(); accuracyCircle = null;
}

function startTracking() {
  if (!('geolocation' in navigator)) return toast('Geolocalizzazione non disponibile.');
  stopSim();
  follow = true;
  let firstFix = true;
  toast('Cerco la tua posizione…');
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      if (firstFix) {
        firstFix = false;
        $('#toast').hidden = true;
        map.setView([latitude, longitude], Math.max(map.getZoom(), 15));
      }
      setUser(latitude, longitude, accuracy);
    },
    (err) => {
      if (err.code === 1) { toast('Permesso di posizione negato. Controlla le impostazioni del browser.'); stopTracking(); }
      else toast('Posizione al momento non disponibile.');
    },
    { enableHighAccuracy: true, maximumAge: 5000 }
  );
  updateLocateBtn();
}

function stopTracking() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  follow = false;
  clearUser();
  updateLocateBtn();
}

locateBtn.addEventListener('click', () => {
  const tracking = watchId !== null || simTimer !== null;
  if (!tracking) return startTracking();
  if (!follow) {                       // in pausa: torna a seguire
    follow = true;
    if (userMarker) map.panTo(userMarker.getLatLng());
    return updateLocateBtn();
  }
  simTimer !== null ? stopSim() : stopTracking();
});

// se l'utente trascina la mappa a mano, il "seguimi" si mette in pausa
map.on('dragstart', () => {
  if (follow) { follow = false; updateLocateBtn(); }
});

// ---------- Simulatore (per la demo da scrivania) ----------
function stopSim() {
  if (simTimer === null) return;
  clearInterval(simTimer);
  simTimer = null;
  simBtn.textContent = 'Simula cammino';
  simBtn.classList.remove('off');
  follow = false;
  clearUser();
  updateLocateBtn();
}

simBtn.addEventListener('click', () => {
  if (simTimer !== null) return stopSim();
  const r = routes.find((x) => x.id === selectedId) ?? routes.find((x) => map.hasLayer(x.layer));
  if (!r) return toast('Nessun percorso visibile da simulare.');
  if (watchId !== null) stopTracking();

  // infittisce il tracciato: un passo ogni ~4 m
  const path = [];
  for (let i = 0; i < r.coords.length - 1; i++) {
    const [a, b] = [r.coords[i], r.coords[i + 1]];
    const n = Math.max(1, Math.ceil(distance([a[1], a[0]], [b[1], b[0]], { units: 'meters' }) / 4));
    for (let s = 0; s < n; s++) path.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
  }
  selectedId = r.id;
  applyFilters();
  map.setView(path[0], 16, { animate: false });

  let i = 0;
  follow = true;
  simBtn.textContent = 'Ferma simulazione';
  simBtn.classList.add('off');
  simTimer = setInterval(() => {
    if (i >= path.length) return stopSim();
    setUser(...path[i++]);
  }, 50);
  updateLocateBtn();
});

load();
