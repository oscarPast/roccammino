// Testi e media dei punti di interesse e delle relazioni: nessuna dipendenza dal DOM.

export const esc = (t) =>
  String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- Relazione: file Markdown semplificato ----------
const inline = (t) =>
  esc(t)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');

// Supporta: titoli (# ## ###), paragrafi, elenchi con "-", **grassetto**, *corsivo*, [testo](https://...)
export function mdLite(src) {
  const out = [];
  let para = [];
  let list = [];
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
    if (list.length) { out.push(`<ul>${list.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`); list = []; }
  };
  for (const line of src.split('\n')) {
    const t = line.trim();
    let m;
    if (!t) flush();
    else if ((m = t.match(/^(#{1,3})\s+(.+)$/))) {
      flush();
      const h = m[1].length === 3 ? 3 : 2;
      out.push(`<h${h}>${inline(m[2])}</h${h}>`);
    } else if ((m = t.match(/^[-*]\s+(.+)$/))) {
      if (para.length) flush();
      list.push(m[1]);
    } else {
      if (list.length) flush();
      para.push(t);
    }
  }
  flush();
  return out.join('\n');
}

// Intestazione opzionale "chiave: valore" tra due righe "---", poi il testo
export function parseRelazione(text) {
  let body = text.replace(/\r/g, '');
  const meta = {};
  const m = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) {
        const key = line.slice(0, i).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        meta[key] = line.slice(i + 1).trim();
      }
    }
    body = body.slice(m[0].length);
  }
  return { meta, html: mdLite(body) };
}

// ---------- Foto e video dei punti di interesse ----------
export const IMG_DIR = 'poi-image/';
export const MEDIA_DIR = 'poi-media/';

export const asList = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : [v]);
const src = (name, dir) => (/^https?:\/\//i.test(name) ? name : dir + encodeURI(name));

export const imageUrls = (p) => asList(p.image).map((n) => src(n, IMG_DIR));

export const imagesHtml = (p) =>
  imageUrls(p)
    .map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="${esc(p.title)}" loading="lazy"></a>`)
    .join('');

// "media": video (mp4, webm...) o audio (mp3, m4a...), riconosciuti dall'estensione. "audio" resta valido.
export const mediaHtml = (p) =>
  [...asList(p.media), ...asList(p.audio)]
    .map((n) => {
      const u = esc(src(n, MEDIA_DIR));
      return /\.(mp4|webm|m4v|mov|ogv)(\?|$)/i.test(n)
        ? `<video controls preload="metadata" playsinline src="${u}"></video>`
        : `<audio controls preload="none" src="${u}"></audio>`;
    })
    .join('');
