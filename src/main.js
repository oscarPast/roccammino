import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { gpx } from '@tmcw/togeojson';
import distance from '@turf/distance';
import { computeStats, fmt, fmtDuration, snapToProfile, eleAtKm } from './stats.js';
import './style.css';

const $ = (sel) => document.querySelector(sel);
const COLORS = { facile: '#2e5b4e', media: '#b7791f', impegnativa: '#9b2c2c' };

// Apertura e chiusura pannello
const panel = document.getElementById('panel');
const togglePanel = document.getElementById('togglePanel');

const isMobile = () => window.matchMedia('(max-width: 720px)').matches;

function setPanelHidden(hidden) {
  panel.classList.toggle('hidden', hidden);
  togglePanel.classList.toggle('hidden-panel', hidden);
  togglePanel.textContent = hidden ? 'Percorsi ▼' : 'Nascondi pannello ▲';
  togglePanel.setAttribute('aria-expanded', String(!hidden));
}
togglePanel.addEventListener('click', () => setPanelHidden(!panel.classList.contains('hidden')));

// ---------- Mappa ----------
const map = L.map('map', { renderer: L.canvas({ tolerance: 10 }) }).setView([44.873807, 8.285832], 12);
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
let sheetRoute = null;      // percorso mostrato nella scheda inferiore
let panelWasHidden = false; // su telefono il pannello si nasconde mentre la scheda è aperta
const sheetEl = $('#sheet');

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
    const layer = L.polyline(coords, { color: COLORS[meta.difficulty], weight: 3, opacity: 0.9 });
    layer.on('click', () => select(meta.id));
    routes.push({ ...meta, coords, layer, stats, markers: endpoints(meta, coords) });
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

// Posizione di un punto (km, quota) nel grafico, in coordinate del viewBox
function profXY(svg, km, ele) {
  const { W, H, PL, PR, PT, PB } = PROF;
  const xMax = +svg.dataset.xmax, yMin = +svg.dataset.ymin, yMax = +svg.dataset.ymax;
  return [PL + (km / xMax) * (W - PL - PR), PT + (1 - (ele - yMin) / (yMax - yMin)) * (H - PT - PB)];
}

// Collega il grafico alla mappa: muovendo il mouse (o il dito) sul profilo
// il pallino segue il punto corrispondente del percorso.
function attachProfileHover(root, profile) {
  const svg = root.querySelector('.prof');
  if (!svg) return;
  const { W, PL, PR, PT } = PROF;
  const xMax = +svg.dataset.xmax;
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

    const [x, y] = profXY(svg, p[0], p[1]);
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
    <rect class="prof-past" x="${PL}" y="${PT}" width="0" height="${H - PT - PB}"/>
    <rect class="prof-next" x="${PL}" y="${PT}" width="0" height="${H - PT - PB}"/>
    <g class="prof-me"><line y1="${PT}" y2="${H - PB}"/><circle r="5"/></g>
    <g class="prof-cursor"><line y1="${PT}" y2="${H - PB}"/><circle r="4"/><text></text></g>
    <text x="${PL - 4}" y="${PT + 4}" text-anchor="end">${Math.round(yMax)} m</text>
    <text x="${PL - 4}" y="${H - PB}" text-anchor="end">${Math.round(yMin)} m</text>
    <text x="${PL}" y="${H - 5}">0 km</text>
    <text x="${W - PR}" y="${H - 5}" text-anchor="end">${fmt(xMax)} km</text>
  </svg>`;
}

// ---------- Scheda inferiore del percorso (al posto del popup) ----------
function sheetHtml(r) {
  const st = r.stats;
  const cell = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<div class="sheet-head" style="--c:${COLORS[r.difficulty]}">
    <div><h3>${r.name}</h3><div class="cat">${r.difficulty} · ${r.themes.join(', ')}</div></div>
    <button class="sheet-close" aria-label="Chiudi">×</button>
  </div>
  <div class="sheet-body" style="--c:${COLORS[r.difficulty]}">
    <div>
      <div class="sheet-profile"></div>
      <p class="here" hidden></p>
    </div>
    <div>
      <dl class="stats">
        ${cell('Lunghezza', `${fmt(st.km)} km`)}
        ${cell(st.estimated ? 'Durata (stima)' : 'Durata', fmtDuration(st.hours))}
        ${cell(st.estimated ? 'Velocità (stima)' : 'Velocità media', `${fmt(st.speed)} km/h`)}
        ${st.hasEle ? cell('Salita', `+${Math.round(st.ascent)} m`) + cell('Discesa', `−${Math.round(st.descent)} m`) + cell('Quota min–max', `${Math.round(st.min)}–${Math.round(st.max)} m`) : ''}
      </dl>
      ${st.estimated ? '<p class="note">Durata stimata: 5 km/h più 1 ora ogni 600 m di salita.</p>' : ''}
    </div>
  </div>`;
}

function renderSheet(r) {
  sheetEl.innerHTML = sheetHtml(r);
  sheetEl.hidden = false;
  document.body.classList.add('sheet-open');
  const holder = sheetEl.querySelector('.sheet-profile');
  if (r.stats.hasEle) {
    PROF.W = Math.round(Math.min(900, Math.max(260, holder.clientWidth))); // il grafico occupa la larghezza disponibile
    holder.innerHTML = profileSvg(r.stats.profile);
    attachProfileHover(holder, r.stats.profile);
  } else {
    holder.innerHTML = '<p class="note">Profilo altimetrico non disponibile: il GPX non contiene le quote.</p>';
  }
  document.documentElement.style.setProperty('--sheet-h', `${sheetEl.offsetHeight}px`);
  updateHere();
}

function openSheet(r, { fit = true } = {}) {
  if (!sheetRoute && isMobile()) {      // su telefono libera lo schermo: nasconde il pannello
    panelWasHidden = panel.classList.contains('hidden');
    setPanelHidden(true);
  }
  sheetRoute = r;
  hideHover();
  renderSheet(r);
  // inquadra il percorso nella parte di mappa che resta sopra la scheda
  if (fit) map.fitBounds(r.layer.getBounds(), { paddingTopLeft: [40, 40], paddingBottomRight: [40, sheetEl.offsetHeight + 24] });
  placeUser();
}

// Con il seguimi attivo e un percorso in focus, la scheda con l'altimetria deve essere visibile
function showSheetForFocus() {
  if (sheetRoute || !selectedId) return;
  const r = routes.find((x) => x.id === selectedId);
  if (!r) return;
  openSheet(r, { fit: false }); // il seguimi inquadra già la posizione
  applyFilters();
}

function closeSheet() {
  if (!sheetRoute) return;
  sheetRoute = null;
  sheetEl.hidden = true;
  sheetEl.innerHTML = '';
  document.body.classList.remove('sheet-open');
  document.documentElement.style.removeProperty('--sheet-h');
  hideHover();
  if (isMobile() && !panelWasHidden) setPanelHidden(false);
  placeUser();
  applyFilters(); // tutte le tracce tornano visibili
}

sheetEl.addEventListener('click', (e) => { if (e.target.closest('.sheet-close')) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => sheetRoute && renderSheet(sheetRoute), 200);
});

// Posizione dell'utente sul percorso aperto: indicatore sul profilo, tratto già fatto attenuato,
// tratto che sta per affrontare evidenziato, avanzamento in km e pendenza di quello che segue
const OFF_ROUTE = 120; // metri: oltre questa distanza dalla traccia si è "fuori percorso"
const AHEAD_KM = 1;    // lunghezza del tratto "in arrivo" evidenziato

function updateHere() {
  const el = sheetEl.querySelector('.here');
  const svg = sheetEl.querySelector('.prof');
  const marks = svg ? [...svg.querySelectorAll('.prof-me, .prof-past, .prof-next')] : [];
  const clearMarks = () => marks.forEach((m) => m.classList.remove('on'));
  if (!sheetRoute || !el) return;
  if (!userPos) { el.hidden = true; clearMarks(); return; }

  const profile = sheetRoute.stats.profile;
  const snap = snapToProfile(profile, userPos[0], userPos[1]);
  if (!snap) { el.hidden = true; clearMarks(); return; }
  el.hidden = false;

  if (snap.meters > OFF_ROUTE) {
    clearMarks();
    el.innerHTML = `<span>Sei a circa ${Math.round(snap.meters)} m dal percorso</span>`;
  } else {
    const total = sheetRoute.stats.km;
    const left = Math.max(0, total - snap.km);
    const ahead = Math.min(AHEAD_KM, left);
    let html = `<span>Sei al km ${fmt(snap.km)} di ${fmt(total)} · mancano ${fmt(left)} km</span>`;
    if (ahead >= 0.05) {
      const d = eleAtKm(profile, snap.km + ahead) - snap.ele;
      const slope = (Math.abs(d) / (ahead * 1000)) * 100;
      const dist = ahead >= 1 ? `${fmt(ahead)} km` : `${Math.round(ahead * 1000)} m`;
      const what = Math.abs(d) < 3 ? 'in piano'
        : d > 0 ? `salita +${Math.round(d)} m (${fmt(slope, 0)}%)` : `discesa −${Math.round(-d)} m (${fmt(slope, 0)}%)`;
      html += `<span class="ahead">Prossimi ${dist}: ${what}</span>`;
    }
    el.innerHTML = html;

    if (svg) {
      const { PL } = PROF;
      const [x, y] = profXY(svg, snap.km, snap.ele);
      const band = (sel, x0, x1) => {
        const r = svg.querySelector(sel);
        r.setAttribute('x', x0); r.setAttribute('width', Math.max(0, x1 - x0));
        r.classList.add('on');
      };
      band('.prof-past', PL, x);
      if (ahead >= 0.05) band('.prof-next', x, profXY(svg, snap.km + ahead, snap.ele)[0]);
      else svg.querySelector('.prof-next').classList.remove('on');
      const me = svg.querySelector('.prof-me');
      const line = me.querySelector('line'), dot = me.querySelector('circle');
      line.setAttribute('x1', x); line.setAttribute('x2', x);
      dot.setAttribute('cx', x); dot.setAttribute('cy', y);
      me.classList.add('on');
    }
  }
  // l'altezza della scheda può cambiare (riga in più): aggiorna lo spazio riservato ai comandi della mappa
  document.documentElement.style.setProperty('--sheet-h', `${sheetEl.offsetHeight}px`);
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
  // l'icona dei filtri si colora quando almeno un filtro è disattivato
  filterUi.btn.classList.toggle('on', [...document.querySelectorAll('input[name=diff], input[name=theme]')].some((i) => !i.checked));
  $('#kmOut').textContent = maxKm;

  const visible = routes.filter(
    (r) => diffs.includes(r.difficulty) && r.km <= maxKm && r.themes.some((t) => themes.includes(t))
  );
  const visibleIds = new Set(visible.map((r) => r.id));

  if (selectedId && !visibleIds.has(selectedId)) selectedId = null;
  if (sheetRoute && !visibleIds.has(sheetRoute.id)) { closeSheet(); return; } // closeSheet richiama applyFilters

  // con la scheda aperta si vede solo il percorso scelto: gli altri vengono nascosti
  const shownIds = sheetRoute ? new Set([sheetRoute.id]) : visibleIds;

  routes.forEach((r) => {
    const on = shownIds.has(r.id);
    const focus = r.id === selectedId;
    on ? r.layer.addTo(map) : r.layer.remove();
    r.markers.forEach((m) => (on ? m.addTo(map) : m.remove()));
    // percorso in focus: tratto più spesso
    r.layer.setStyle({ weight: focus ? 5 : 3, opacity: 0.9 });
    if (focus) r.layer.bringToFront();
  });

  // un POI è visibile se è un servizio, oppure se appartiene a un percorso mostrato e al tema scelto
  pois.forEach(({ feature, marker }) => {
    const p = feature.properties;
    const show = p.category === 'servizi' || (p.routes.some((id) => shownIds.has(id)) && themes.includes(p.category));
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
  openSheet(r);
  applyFilters(); // nasconde le altre tracce
  r.layer.bringToFront();
}

document.addEventListener('change', (e) => e.target.closest('#panel, .filter-card') && applyFilters());
$('#km').addEventListener('input', applyFilters);
$('#routeList').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) select(b.dataset.id);
});

// ---------- Posizione e "seguimi" ----------
let userMarker = null;
let accuracyCircle = null;
let watchId = null;     // id di watchPosition
let follow = false;     // la mappa segue l'utente?

// Pulsante "Dove sono": icona sulla mappa, sotto il selettore delle mappe, sempre raggiungibile
const locateBtn = (() => {
  let btn;
  const Locate = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const box = L.DomUtil.create('div', 'leaflet-bar locate-control');
      btn = L.DomUtil.create('a', '', box);
      btn.href = '#';
      btn.setAttribute('role', 'button');
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/>
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>`;
      L.DomEvent.disableClickPropagation(box);
      return box;
    },
  });
  new Locate().addTo(map);
  return btn;
})();

// Pulsante "Filtri": icona sulla mappa sotto "Dove sono"; apre una scheda con difficoltà e tema
const filterUi = (() => {
  let btn, card;
  const setOpen = (open) => {
    card.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  const Filters = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const box = L.DomUtil.create('div', 'filter-control');
      const bar = L.DomUtil.create('div', 'leaflet-bar', box);
      btn = L.DomUtil.create('a', '', bar);
      btn.href = '#';
      btn.title = 'Filtri';
      btn.setAttribute('role', 'button');
      btn.setAttribute('aria-label', 'Filtri');
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>`;
      card = L.DomUtil.create('div', 'filter-card', box);
      card.hidden = true;
      card.innerHTML = `
        <fieldset>
          <legend>Difficoltà</legend>
          <label><input type="checkbox" name="diff" value="facile" checked /> Facile</label>
          <label><input type="checkbox" name="diff" value="media" checked /> Media</label>
          <label><input type="checkbox" name="diff" value="impegnativa" checked /> Impegnativa</label>
        </fieldset>
        <fieldset>
          <legend>Tema</legend>
          <label><input type="checkbox" name="theme" value="storia" checked /> Storia</label>
          <label><input type="checkbox" name="theme" value="ambiente" checked /> Ambiente</label>
          <label><input type="checkbox" name="theme" value="cultura" checked /> Cultura</label>
        </fieldset>`;
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      L.DomEvent.on(btn, 'click', (e) => { L.DomEvent.preventDefault(e); setOpen(card.hidden); });
      return box;
    },
  });
  new Filters().addTo(map);
  return { btn, setOpen };
})();
map.on('click', () => filterUi.setOpen(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') filterUi.setOpen(false); });

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}

function updateLocateBtn() {
  const tracking = watchId !== null;
  const label = !tracking ? 'Dove sono' : follow ? 'Interrompi' : 'Torna a seguirmi';
  locateBtn.title = label;
  locateBtn.setAttribute('aria-label', label);
  locateBtn.classList.toggle('active', tracking && follow);   // blu pieno: ti sta seguendo
  locateBtn.classList.toggle('paused', tracking && !follow);  // blu: in pausa
}
updateLocateBtn();

// centro della mappa che lascia l'utente al centro della parte visibile sopra la scheda
function offsetCenter(lat, lng, zoom = map.getZoom()) {
  const h = sheetRoute ? sheetEl.offsetHeight : 0;
  return map.unproject(map.project([lat, lng], zoom).add([0, h / 2]), zoom);
}

let userPos = null;       // ultima posizione GPS grezza [lat, lng]
const SNAP_METERS = 15;   // entro questa distanza dalla traccia il pallino si appoggia alla linea

// posizione da mostrare: agganciata al percorso selezionato se si è a meno di SNAP_METERS, altrimenti il GPS grezzo
function displayPos() {
  const r = sheetRoute ?? routes.find((x) => x.id === selectedId);
  const snap = r && snapToProfile(r.stats.profile, userPos[0], userPos[1]);
  return snap && snap.meters <= SNAP_METERS ? [snap.lat, snap.lng] : userPos;
}

function placeUser() {
  if (!userPos) return;
  const pos = displayPos();
  if (!userMarker) {
    userMarker = L.marker(pos, {
      icon: L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [16, 16] }),
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(map);
  } else userMarker.setLatLng(pos);
}

function setUser(lat, lng, accuracy) {
  userPos = [lat, lng];
  placeUser();
  if (accuracy) { // il cerchio resta sulla posizione GPS vera: mostra l'incertezza reale
    if (!accuracyCircle) {
      accuracyCircle = L.circle([lat, lng], { radius: accuracy, color: '#2563eb', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    } else accuracyCircle.setLatLng([lat, lng]).setRadius(accuracy);
  }
  updateHere();
  if (follow) map.panTo(offsetCenter(...displayPos()));
}

function clearUser() {
  userPos = null;
  userMarker?.remove(); userMarker = null;
  accuracyCircle?.remove(); accuracyCircle = null;
  updateHere();
}

function startTracking() {
  if (!('geolocation' in navigator)) return toast('Geolocalizzazione non disponibile.');
  follow = true;
  showSheetForFocus();
  let firstFix = true;
  toast('Cerco la tua posizione…');
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      if (firstFix) {
        firstFix = false;
        $('#toast').hidden = true;
        const z = Math.max(map.getZoom(), 15);
        map.setView(offsetCenter(latitude, longitude, z), z);
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

locateBtn.addEventListener('click', (e) => {
  e.preventDefault();
  if (watchId === null) return startTracking();
  if (!follow) {                       // in pausa: torna a seguire
    follow = true;
    showSheetForFocus();
    if (userPos) map.panTo(offsetCenter(...displayPos()));
    return updateLocateBtn();
  }
  stopTracking();
});

// se l'utente trascina la mappa a mano, il "seguimi" si mette in pausa
map.on('dragstart', () => {
  if (follow) { follow = false; updateLocateBtn(); }
});

load();
