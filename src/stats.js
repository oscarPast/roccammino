import distance from '@turf/distance';

const SOGLIA_QUOTA = 3; // metri: variazioni minori sono considerate rumore GPS

// line: [[lng, lat, ele?], ...]  times: array di stringhe ISO (opzionale, dal GPX)
export function computeStats(line, times = []) {
  let meters = 0;
  const dist = [0]; // distanza cumulata in km, un valore per punto
  for (let i = 1; i < line.length; i++) {
    meters += distance(line[i - 1], line[i], { units: 'meters' });
    dist.push(meters / 1000);
  }
  const km = meters / 1000;

  const hasEle = line.length > 1 && line.every((p) => Number.isFinite(p[2]));
  let ascent = null, descent = null, min = null, max = null, profile = [];
  if (hasEle) {
    const ele = line.map((p) => p[2]);
    // salita/discesa con soglia: conta solo gli scarti superiori a SOGLIA_QUOTA dall'ultimo punto di riferimento
    let ref = ele[0];
    ascent = 0; descent = 0;
    for (const e of ele) {
      const d = e - ref;
      if (d >= SOGLIA_QUOTA) { ascent += d; ref = e; }
      else if (d <= -SOGLIA_QUOTA) { descent -= d; ref = e; }
    }
    min = Math.min(...ele); max = Math.max(...ele);
    const step = Math.max(1, Math.ceil(line.length / 400)); // al massimo ~400 punti (grafico e aggancio alla traccia)
    const pt = (i) => [dist[i], ele[i], line[i][1], line[i][0]]; // [km, quota, lat, lng]
    for (let i = 0; i < line.length; i += step) profile.push(pt(i));
    const last = line.length - 1;
    if (profile[profile.length - 1][0] !== dist[last]) profile.push(pt(last));
  }

  // durata: reale se il GPX ha gli orari, altrimenti stimata con la regola di Naismith
  let hours = null, estimated = true;
  if (times.length === line.length && times.length > 1) {
    const h = (new Date(times[times.length - 1]) - new Date(times[0])) / 3.6e6;
    if (Number.isFinite(h) && h > 0) { hours = h; estimated = false; }
  }
  if (hours === null) { hours = km / 5 + (ascent ?? 0) / 600; }

  return { km, hasEle, ascent, descent, min, max, profile, hours, estimated, speed: hours > 0 ? km / hours : null };
}

export const fmt = (n, d = 1) => n.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });

export function fmtDuration(hours) {
  const min = Math.round(hours * 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

// Aggancia una posizione (lat, lng) al profilo: restituisce a che km del percorso si trova,
// la quota corrispondente, il punto sulla traccia (lat, lng) e la distanza in metri da essa.
// profile: [[km, quota, lat, lng], ...]
export function snapToProfile(profile, lat, lng) {
  if (!profile || profile.length < 2) return null;
  const k = Math.cos((lat * Math.PI) / 180);
  const xy = (la, lo) => [(lo - lng) * 111320 * k, (la - lat) * 110574]; // metri rispetto all'utente
  let best = null;
  for (let i = 0; i < profile.length - 1; i++) {
    const [ax, ay] = xy(profile[i][2], profile[i][3]);
    const [bx, by] = xy(profile[i + 1][2], profile[i + 1][3]);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)); // proiezione sul segmento
    const meters = Math.hypot(ax + u * dx, ay + u * dy);
    if (!best || meters < best.meters) {
      best = {
        meters,
        km: profile[i][0] + u * (profile[i + 1][0] - profile[i][0]),
        ele: profile[i][1] + u * (profile[i + 1][1] - profile[i][1]),
        lat: profile[i][2] + u * (profile[i + 1][2] - profile[i][2]),
        lng: profile[i][3] + u * (profile[i + 1][3] - profile[i][3]),
      };
    }
  }
  return best;
}

// Quota (interpolata) a un dato km del percorso
export function eleAtKm(profile, km) {
  if (!profile || !profile.length) return null;
  if (km <= profile[0][0]) return profile[0][1];
  const last = profile[profile.length - 1];
  if (km >= last[0]) return last[1];
  let lo = 0, hi = profile.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (profile[mid][0] <= km) lo = mid; else hi = mid; }
  const [k0, e0] = profile[lo], [k1, e1] = profile[hi];
  return k1 === k0 ? e0 : e0 + ((e1 - e0) * (km - k0)) / (k1 - k0);
}
