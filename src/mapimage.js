// Immagine della mappa del percorso per la relazione: tile OpenStreetMap + traccia + marker.
// Se i tile non sono raggiungibili (offline, blocco CORS) si ripiega su uno sfondo neutro con la sola traccia.
import L from 'leaflet';

const W = 1000, H = 600, PAD = 70, TILE = 256;
const cache = new Map();

const loadTile = (z, x, y) =>
  new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // necessario per poter esportare il canvas
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  });

// coords: [[lat, lng], ...]  marks: [{ lat, lng, label, bg }]  →  { url, hasBase }
export function buildMapImage({ id, coords, color, marks = [] }) {
  if (cache.has(id)) return cache.get(id);
  const p = build(coords, color, marks);
  cache.set(id, p);
  p.catch(() => cache.delete(id));
  return p;
}

async function build(coords, color, marks) {
  const project = (lat, lng, z) => L.CRS.EPSG3857.latLngToPoint(L.latLng(lat, lng), z);

  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const [la, lo] of coords) {
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (lo < minLng) minLng = lo;
    if (lo > maxLng) maxLng = lo;
  }
  // zoom più alto (max 16) in cui il percorso sta nell'immagine
  let z = 16;
  for (; z > 6; z--) {
    const a = project(minLat, minLng, z), b = project(maxLat, maxLng, z);
    if (Math.abs(b.x - a.x) <= W - 2 * PAD && Math.abs(a.y - b.y) <= H - 2 * PAD) break;
  }
  const c = project((minLat + maxLat) / 2, (minLng + maxLng) / 2, z);
  const ox = c.x - W / 2, oy = c.y - H / 2;
  const n = 2 ** z;

  const jobs = [];
  for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + H - 1) / TILE); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + W - 1) / TILE); tx++) {
      jobs.push(loadTile(z, ((tx % n) + n) % n, ty).then((img) => ({ img, dx: tx * TILE - ox, dy: ty * TILE - oy })));
    }
  }
  const loaded = (await Promise.all(jobs)).filter((t) => t.img);

  const render = (withTiles) => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e9edea';
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'middle';
    if (withTiles) {
      for (const t of loaded) ctx.drawImage(t.img, t.dx, t.dy);
    } else {
      ctx.fillStyle = '#7b8883';
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillText('Sfondo cartografico non disponibile', 16, 24);
    }

    const pt = (la, lo) => { const q = project(la, lo, z); return [q.x - ox, q.y - oy]; };
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    coords.forEach(([la, lo], i) => { const [x, y] = pt(la, lo); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 10; ctx.stroke();
    ctx.strokeStyle = color;  ctx.lineWidth = 5;  ctx.stroke();

    const pill = (x, y, w, h) => {
      const r = h / 2;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const m of marks) {
      const [x, y] = pt(m.lat, m.lng);
      const w = m.label.length > 1 ? 42 : 28;
      pill(x - w / 2, y - 14, w, 28);
      ctx.fillStyle = m.bg; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillText(m.label, x, y + 1);
    }

    if (withTiles) {
      const text = '© OpenStreetMap contributors';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'right';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.fillRect(W - tw - 16, H - 22, tw + 16, 22);
      ctx.fillStyle = '#333';
      ctx.fillText(text, W - 8, H - 11);
    }
    return canvas;
  };

  let hasBase = loaded.length > 0;
  let url;
  try {
    url = render(hasBase).toDataURL('image/jpeg', 0.88);
  } catch {
    url = render(false).toDataURL('image/jpeg', 0.88); // canvas "contaminato" dai tile: ripiego senza sfondo
    hasBase = false;
  }
  return { url, hasBase };
}
