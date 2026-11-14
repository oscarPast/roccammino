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
    const step = Math.max(1, Math.ceil(line.length / 150)); // al massimo ~150 punti nel grafico
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
