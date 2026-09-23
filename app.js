'use strict';
/* Вслух — читалка, которая читает вслух. Всё работает на устройстве. */

const $ = (s) => document.querySelector(s);
const SR = 22050;               // частота голоса Piper
const CH = 4;                   // предложений в одном аудио-куске
const MAX_TRACK = 20 * 60;      // максимум секунд в одном «треке» (дальше трек сменяется сам)
const VOICES = [
  { id: 'denis', name: 'Денис', desc: 'мужской' },
  { id: 'dmitri', name: 'Дмитрий', desc: 'мужской' },
  { id: 'irina', name: 'Ирина', desc: 'женский' },
  { id: 'ruslan', name: 'Руслан', desc: 'мужской' },
];
const SPEEDS = [1, 1.15, 1.3, 1.5, 1.75, 2, 0.85];
const ASSET_CACHE = 'vsluh-assets-v1';

/* ───────────── хранилища ───────────── */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('vsluh:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('vsluh:' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('vsluh:' + k); } catch (e) {} },
};

const DB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('vsluh', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('books', { keyPath: 'id' });
      d.createObjectStore('texts');
      d.createObjectStore('pcm');
      d.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = (store, mode, fn) => open().then((db) => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    let out;
    const r = fn(t.objectStore(store));
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
  const bound = (prefix) => IDBKeyRange.bound(prefix, prefix + '\uffff');
  return {
    get: (st, k) => tx(st, 'readonly', (s) => s.get(k)),
    put: (st, v, k) => tx(st, 'readwrite', (s) => (k === undefined ? s.put(v) : s.put(v, k))),
    del: (st, k) => tx(st, 'readwrite', (s) => s.delete(k)),
    all: (st) => tx(st, 'readonly', (s) => s.getAll()),
    delPrefix: (st, prefix) => tx(st, 'readwrite', (s) => s.delete(bound(prefix))),
    entries: (st, prefix) => open().then((db) => new Promise((res, rej) => {
      const out = [];
      const r = db.transaction(st).objectStore(st).openCursor(bound(prefix));
      r.onsuccess = () => { const c = r.result; if (c) { out.push([c.key, c.value]); c.continue(); } else res(out); };
      r.onerror = () => rej(r.error);
    })),
  };
})();

const settings = Object.assign({ voice: 'denis', speed: 1, font: 19, theme: 'auto' }, LS.get('settings', {}));
// Озвучка готовится «порциями»: когда впереди меньше AHEAD_LOW — движок просыпается и готовит
// до AHEAD_HIGH, потом выгружается из памяти. Слушание при этом идёт с готовых файлов на диске.
const AHEAD_HIGH = 40 * 60, AHEAD_LOW = 12 * 60;
settings.ahead = AHEAD_HIGH;
const AUDIO_VER = 3;             // сменить, чтобы выбросить старую озвучку
const saveSettings = () => LS.set('settings', settings);

/* ───────────── мелочи ───────────── */
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = (n) => String(n).padStart(6, '0');
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + ' с';
  const m = Math.round(sec / 60);
  if (m < 60) return m + ' мин';
  const h = Math.floor(m / 60), mm = m % 60;
  return h + ' ч' + (mm ? ' ' + mm + ' мин' : '');
}
const fmtMB = (b) => (b / 1048576).toFixed(b > 104857600 ? 0 : 1).replace('.', ',') + ' МБ';
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600);
}

/* ───────────── ZIP (для fb2.zip и epub) ───────────── */
async function unzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Архив повреждён');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  const dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + xl + cl;
    files.set(name, { method, csize, off });
  }
  return {
    names: [...files.keys()],
    async read(name) {
      const f = files.get(name);
      if (!f) return null;
      const lnl = dv.getUint16(f.off + 26, true), lxl = dv.getUint16(f.off + 28, true);
      const start = f.off + 30 + lnl + lxl;
      const data = u8.slice(start, start + f.csize);
      if (f.method === 0) return data.buffer;
      if (f.method !== 8) throw new Error('Неподдерживаемое сжатие в архиве');
      const ds = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return await new Response(ds).arrayBuffer();
    },
  };
}

/* ───────────── разбор книг ───────────── */
function decodeText(buf) {
  const head = new TextDecoder('ascii').decode(new Uint8Array(buf, 0, Math.min(400, buf.byteLength)));
  const m = head.match(/encoding=["']([\w-]+)["']/i);
  if (m) { try { return new TextDecoder(m[1].toLowerCase()).decode(buf); } catch (e) {} }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('windows-1251').decode(buf); }
}
const clean = (s) => s.replace(/\u00AD|\u0301/g, '').replace(/[ \t\r\n\u00A0]+/g, ' ').trim();

function parseFB2(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length && !doc.getElementsByTagName('body').length) throw new Error('Не получилось прочитать FB2');
  const byTag = (el, tag) => [...el.getElementsByTagName(tag)];
  const kid = (el, tag) => [...el.children].find((c) => c.localName === tag);
  const ti = byTag(doc, 'title-info')[0];
  let title = '', author = '', cover = null;
  if (ti) {
    title = clean((kid(ti, 'book-title') || {}).textContent || '');
    const a = kid(ti, 'author');
    if (a) author = ['first-name', 'last-name'].map((t) => clean((kid(a, t) || {}).textContent || '')).filter(Boolean).join(' ');
    const cp = kid(ti, 'coverpage');
    const img = cp && byTag(cp, 'image')[0];
    if (img) {
      const href = (img.getAttribute('l:href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || img.getAttribute('xlink:href') || '').replace('#', '');
      const bin = byTag(doc, 'binary').find((b) => b.getAttribute('id') === href);
      if (bin) cover = 'data:' + (bin.getAttribute('content-type') || 'image/jpeg') + ';base64,' + bin.textContent.replace(/\s+/g, '');
    }
  }
  const paras = [], chaps = [];
  const textOf = (el) => {
    const c = el.cloneNode(true);
    [...c.getElementsByTagName('a')].forEach((a) => { if ((a.getAttribute('type') || '') === 'note' || /^\[?\d+\]?$|^\*+$/.test(a.textContent.trim())) a.remove(); });
    return clean(c.textContent);
  };
  const add = (kind, el) => { const t = textOf(el); if (t) paras.push({ k: kind, t }); };
  function walk(el, depth) {
    for (const c of el.children) {
      const n = c.localName;
      if (n === 'title') {
        const ps = byTag(c, 'p');
        const ttl = (ps.length ? ps.map(textOf) : [textOf(c)]).filter(Boolean);
        if (ttl.length) {
          if (depth > 0) chaps.push({ title: ttl.join('. '), p: paras.length });
          ttl.forEach((t) => paras.push({ k: 'h', t }));
        }
      } else if (n === 'section') walk(c, depth + 1);
      else if (n === 'p') add('p', c);
      else if (n === 'subtitle') add('s', c);
      else if (n === 'epigraph') { for (const x of c.children) if (x.localName === 'p' || x.localName === 'text-author') add('e', x); else if (x.localName === 'poem') walkPoem(x); }
      else if (n === 'cite') { for (const x of c.children) if (x.localName === 'p' || x.localName === 'text-author') add('q', x); else if (x.localName === 'poem') walkPoem(x); }
      else if (n === 'poem') walkPoem(c);
      else if (n === 'table') byTag(c, 'tr').forEach((tr) => add('p', tr));
    }
  }
  function walkPoem(el) {
    for (const x of el.children) {
      if (x.localName === 'title') add('s', x);
      else if (x.localName === 'stanza') byTag(x, 'v').forEach((v) => add('v', v));
      else if (x.localName === 'v') add('v', x);
      else if (x.localName === 'text-author') add('e', x);
    }
  }
  const bodies = byTag(doc, 'body').filter((b) => !/notes|comments|footnotes/i.test(b.getAttribute('name') || ''));
  bodies.forEach((b) => walk(b, 0));
  return { title: title || 'Без названия', author, cover, paras, chaps };
}

async function parseEPUB(zip) {
  const dec = (b) => new TextDecoder().decode(b);
  const cont = await zip.read('META-INF/container.xml');
  const opfPath = new DOMParser().parseFromString(dec(cont), 'application/xml').querySelector('rootfile').getAttribute('full-path');
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = new DOMParser().parseFromString(dec(await zip.read(opfPath)), 'application/xml');
  const meta = (tag) => clean((opf.getElementsByTagName(tag)[0] || opf.getElementsByTagName('dc:' + tag)[0] || {}).textContent || '');
  const title = meta('title'), author = meta('creator');
  const items = {};
  [...opf.getElementsByTagName('item')].forEach((i) => { items[i.getAttribute('id')] = i; });
  const resolve = (href) => {
    const parts = (dir + decodeURIComponent(href)).split('/'); const out = [];
    for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); }
    return out.join('/');
  };
  let cover = null;
  try {
    const cm = [...opf.getElementsByTagName('meta')].find((m) => m.getAttribute('name') === 'cover');
    const ci = (cm && items[cm.getAttribute('content')]) || [...opf.getElementsByTagName('item')].find((i) => /cover-image/.test(i.getAttribute('properties') || ''));
    if (ci) {
      const b = await zip.read(resolve(ci.getAttribute('href')));
      if (b && b.byteLength < 1.5e6) cover = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob([b], { type: ci.getAttribute('media-type') || 'image/jpeg' })); });
    }
  } catch (e) {}
  const paras = [], chaps = [];
  const BLOCK = /^(p|div|h[1-6]|li|blockquote|section|article|body|ul|ol|table|tbody|tr|td|dd|dt|dl|pre|figure|header|footer|aside|nav|main)$/;
  function walk(el) {
    for (const c of el.children) {
      const n = c.localName;
      if (/^(script|style|head|nav|aside)$/.test(n)) continue;
      if (/^h[1-3]$/.test(n)) { const t = clean(c.textContent); if (t) { chaps.push({ title: t, p: paras.length }); paras.push({ k: 'h', t }); } continue; }
      if (/^h[4-6]$/.test(n)) { const t = clean(c.textContent); if (t) paras.push({ k: 's', t }); continue; }
      const hasBlock = [...c.children].some((x) => BLOCK.test(x.localName));
      if (hasBlock) walk(c);
      else if (BLOCK.test(n) || n === 'p') {
        const cc = c.cloneNode(true);
        [...cc.querySelectorAll('sup, a[epub\\:type="noteref"]')].forEach((x) => x.remove());
        const t = clean(cc.textContent);
        if (t) paras.push({ k: n === 'blockquote' ? 'q' : 'p', t });
      }
    }
  }
  for (const ref of opf.getElementsByTagName('itemref')) {
    const it = items[ref.getAttribute('idref')];
    if (!it) continue;
    const b = await zip.read(resolve(it.getAttribute('href')));
    if (!b) continue;
    const txt = dec(b);
    let d = new DOMParser().parseFromString(txt, 'application/xhtml+xml');
    if (d.getElementsByTagName('parsererror').length) d = new DOMParser().parseFromString(txt, 'text/html');
    const body = d.getElementsByTagName('body')[0];
    if (body) walk(body);
  }
  return { title: title || 'Без названия', author, cover, paras, chaps };
}

function parseTXT(text, name) {
  const paras = [], chaps = [];
  const blocks = /\n\s*\n/.test(text) ? text.split(/\n\s*\n/) : text.split(/\n/);
  for (const b of blocks) {
    const t = clean(b);
    if (!t) continue;
    if (t.length < 80 && /^(глава|часть|chapter|пролог|эпилог)\b/i.test(t)) { chaps.push({ title: t, p: paras.length }); paras.push({ k: 'h', t }); }
    else paras.push({ k: 'p', t });
  }
  return { title: name.replace(/\.[^.]+$/, ''), author: '', cover: null, paras, chaps };
}

async function parseFile(file) {
  const buf = await file.arrayBuffer();
  const name = file.name || 'книга';
  const u8 = new Uint8Array(buf, 0, 4);
  const isZip = u8[0] === 0x50 && u8[1] === 0x4b;
  if (isZip) {
    const zip = await unzip(buf);
    if (zip.names.includes('META-INF/container.xml')) return parseEPUB(zip);
    const fb = zip.names.find((n) => /\.fb2$/i.test(n));
    if (fb) return parseFB2(decodeText(await zip.read(fb)));
    const tx = zip.names.find((n) => /\.txt$/i.test(n));
    if (tx) return parseTXT(decodeText(await zip.read(tx)), tx);
    throw new Error('В архиве нет книги');
  }
  const text = decodeText(buf);
  if (/<FictionBook/i.test(text.slice(0, 3000))) return parseFB2(text);
  if (/\.(fb2|xml)$/i.test(name)) return parseFB2(text);
  return parseTXT(text, name);
}

/* Режем текст на предложения */
const segmenter = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter('ru', { granularity: 'sentence' }) : null;
function splitSentences(text) {
  let parts;
  if (segmenter) parts = [...segmenter.segment(text)].map((s) => s.segment.trim());
  else parts = text.match(/[^.!?…]+(?:[.!?…]+["»”)]*|$)\s*/g) || [text];
  const out = [];
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    // слишком короткие обрывки (инициалы, «т. е.») приклеиваем к предыдущему
    if (out.length && (p.length < 4 || /^[a-zа-яё]/.test(p) || /(?:^|\s)[А-ЯЁA-Z]\.$/.test(out[out.length - 1]))) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out.length ? out : [text];
}

/* Превращаем разобранную книгу в модель: предложения, абзацы, главы */
function buildModel(raw) {
  const sents = [], paras = [];
  const pStart = [];
  for (const p of raw.paras) {
    pStart.push(sents.length);
    const list = p.k === 'h' || p.k === 's' || p.k === 'v' ? [p.t] : splitSentences(p.t);
    paras.push([sents.length, list.length, p.k]);
    sents.push(...list);
  }
  let chaps = raw.chaps.filter((c) => c.p < raw.paras.length).map((c) => ({ title: c.title, p: c.p }));
  // убираем дубли (вложенные заголовки подряд)
  chaps = chaps.filter((c, i) => i === 0 || c.p !== chaps[i - 1].p);
  if (!chaps.length || chaps[0].p > 0) chaps.unshift({ title: chaps.length ? '' : raw.title, p: 0, auto: true });
  // глава, в которой одни заголовки (например «Часть первая» перед «Глава 1»), сливается со следующей
  for (let i = 0; i < chaps.length - 1; i++) {
    const a = chaps[i], b = chaps[i + 1];
    let onlyHeads = true;
    for (let p = a.p; p < b.p; p++) if (raw.paras[p].k !== 'h' && raw.paras[p].k !== 's') { onlyHeads = false; break; }
    if (onlyHeads) {
      b.title = a.auto || !a.title ? b.title : a.title + ' · ' + b.title;
      b.p = a.p; chaps.splice(i, 1); i--;
    }
  }
  chaps.forEach((c) => { if (!c.title) c.title = 'Начало'; });
  // слишком длинные главы режем на части — чтобы телефону было легко
  const out = [];
  chaps.forEach((c, i) => {
    const end = i + 1 < chaps.length ? chaps[i + 1].p : paras.length;
    const n = end - c.p;
    if (n <= 400) { out.push({ title: c.title, p0: c.p, p1: end }); return; }
    const parts = Math.ceil(n / 300);
    for (let j = 0; j < parts; j++) {
      const a = c.p + Math.round((n * j) / parts), b = c.p + Math.round((n * (j + 1)) / parts);
      out.push({ title: c.title + (parts > 1 ? ' · ' + (j + 1) : ''), p0: a, p1: b });
    }
  });
  return { sents, paras, chaps: out.filter((c) => c.p1 > c.p0) };
}

/* Текст → куски для синтеза */
const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100 };
function roman(s) { let n = 0; for (let i = 0; i < s.length; i++) { const a = ROMAN[s[i]], b = ROMAN[s[i + 1]] || 0; n += a < b ? -a : a; } return n; }
function ttsPieces(text, kind) {
  let t = text
    .replace(/\[[^\]]{0,6}\]|\{[^}]{0,6}\}/g, '')
    .replace(/[«»“”„"]/g, '')
    .replace(/…/g, '...')
    .replace(/(^|\s)[—–-](\s|$)/g, '$1, $2')
    .replace(/^[,\s]+/, '')
    .replace(/\s+,/g, ',')
    .replace(/,(\s*,)+/g, ',')
    .replace(/\*+/g, '')
    .replace(/№/g, ' номер ').replace(/§/g, ' параграф ')
    .replace(/[^\p{L}\p{N}\s.,!?;:()%'\-]/gu, ' ')   // эмодзи и редкие символы движок не любит
    .replace(/\s+/g, ' ').trim();
  if (kind === 'h' || kind === 's') t = t.replace(/\b([IVXLC]{1,7})\b/g, (m) => String(roman(m)));
  if (!/[\p{L}\p{N}]/u.test(t)) return [];
  if (!/[.!?…:;]$/.test(t)) t += '.';
  const out = [];
  while (t.length > 180) {
    let cut = -1;
    for (const re of [/[;:]\s/g, /,\s/g, /\s/g]) {
      re.lastIndex = 0; let m;
      while ((m = re.exec(t)) && m.index < 180) if (m.index > 50) cut = m.index + 1;
      if (cut > 0) break;
    }
    if (cut < 0) cut = 180;
    out.push(t.slice(0, cut).trim());
    t = t.slice(cut).trim();
  }
  if (t) out.push(t);
  return out;
}

/* ───────────── встроенная книжка ───────────── */
const DEMO = {
  title: 'Как устроен «Вслух»', author: 'Короткая инструкция',
  paras: [
    ['h', 'Одна книга, два способа'],
    ['p', 'Это приложение умеет две вещи: показывать книгу и читать её вслух. Между ними нет границы. Вы читаете глазами, нажимаете большую кнопку внизу, и голос продолжает с того же места.'],
    ['p', 'Нажмите на любое предложение, и оно станет закладкой. Если в этот момент идёт чтение вслух, голос сразу перепрыгнет туда.'],
    ['p', 'Когда вы ставите на паузу, подсвеченное предложение остаётся на экране. Прокрутите текст дальше, и закладка тихо переедет к первой видимой строке.'],
    ['h', 'Голос живёт внутри'],
    ['p', 'Голос здесь — небольшая нейросеть, которая работает прямо на телефоне. Никаких серверов, подписок и интернета после первой загрузки.'],
    ['p', 'Телефону нужно время, чтобы озвучить текст, поэтому приложение готовит запас впрок. Внизу видно, на сколько минут вперёд всё готово.'],
    ['h', 'Когда экран погаснет'],
    ['p', 'Готовый запас играет и при заблокированном экране, как обычный подкаст. Управлять можно с экрана блокировки и кнопками наушников.'],
    ['p', 'Пока приложение открыто и озвучивает текст, экран сам не гаснет. Можно положить телефон рядом на пару минут, и запас вырастет.'],
    ['h', 'Ваши книги'],
    ['p', 'Нажмите «Книга» в библиотеке и выберите файл: FB2, FB2 в архиве, EPUB или обычный текст. Всё хранится только на этом устройстве.'],
    ['p', 'Приятного чтения. И слушания.'],
  ].map(([k, t]) => ({ k, t })),
};

/* ───────────── состояние ───────────── */
let books = [];          // мета всех книг
let book = null;         // открытая книга (мета)
let M = null;            // модель открытой книги {sents, paras, chaps}
let sentPara = null;     // предложение → абзац
let sentChap = null;     // предложение → глава
let pos = 0;             // текущее предложение (закладка)
let chapShown = -1;
let spans = [];

/* ───────────── библиотека ───────────── */
async function loadLibrary() {
  books = (await DB.all('books').catch(() => [])) || [];
  if (!books.length && !LS.get('demoAdded', false)) {
    LS.set('demoAdded', true);
    await addBook(DEMO, { silent: true });
    books = await DB.all('books');
  }
  books.sort((a, b) => (b.opened || b.added) - (a.opened || a.added));
  renderLibrary();
}

function coverHTML(b) {
  return `<div class="cover">${b.cover ? `<img src="${b.cover}" alt="">` : esc(b.title.slice(0, 40))}</div>`;
}
function renderLibrary() {
  const ul = $('#books');
  if (!books.length) { ul.innerHTML = '<li class="empty">Пока пусто. Добавьте книгу кнопкой «Книга».</li>'; return; }
  ul.innerHTML = books.map((b) => {
    const p = LS.get('pos:' + b.id, b.pos || 0);
    const pct = b.n ? Math.min(100, Math.round((p / Math.max(1, b.n - 1)) * 100)) : 0;
    return `<li class="book" data-id="${b.id}">
      <button class="book-open" data-open="${b.id}" style="display:contents">${coverHTML(b)}
      <span class="book-open"><span class="book-title">${esc(b.title)}</span>
      <span class="book-meta">${b.author ? esc(b.author) + ' ·' : ''} <span class="pbar"><i style="width:${pct}%"></i></span> ${pct}%</span></span></button>
      <button class="more" data-more="${b.id}" aria-label="Удалить книгу"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>
    </li>`;
  }).join('');
}

$('#books').addEventListener('click', async (e) => {
  const o = e.target.closest('[data-open]');
  if (o) return openBook(o.dataset.open);
  const m = e.target.closest('[data-more]');
  if (m) {
    const li = m.closest('.book');
    if (li.querySelector('.confirm')) { li.querySelector('.confirm').remove(); return; }
    li.insertAdjacentHTML('beforeend', `<div class="confirm">Удалить книгу и её озвучку? <button data-no>Нет</button><button class="danger" data-del="${m.dataset.more}">Удалить</button></div>`);
    return;
  }
  if (e.target.closest('[data-no]')) { e.target.closest('.confirm').remove(); return; }
  const d = e.target.closest('[data-del]');
  if (d) {
    const id = d.dataset.del;
    await DB.del('books', id); await DB.del('texts', id);
    await DB.delPrefix('pcm', id + '|'); await DB.delPrefix('meta', id + '|');
    LS.del('pos:' + id);
    books = books.filter((b) => b.id !== id);
    renderLibrary(); toast('Книга удалена');
  }
});

async function addBook(raw, opt = {}) {
  if (!raw.chaps) { raw.chaps = []; raw.paras.forEach((p, i) => { if (p.k === 'h') raw.chaps.push({ title: p.t, p: i }); }); }
  const model = buildModel(raw);
  if (!model.sents.length) throw new Error('В файле не нашлось текста');
  const id = uid();
  const meta = { id, title: raw.title, author: raw.author || '', cover: raw.cover || null, n: model.sents.length, added: Date.now(), pos: 0 };
  await DB.put('texts', model, id);
  await DB.put('books', meta);
  if (!opt.silent) toast('Добавлено: ' + raw.title);
  return id;
}

$('#fileIn').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  toast('Открываю «' + f.name + '»…');
  try {
    const raw = await parseFile(f);
    const id = await addBook(raw);
    books = await DB.all('books');
    openBook(id);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Не получилось открыть файл');
  }
});
$('.add').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileIn').click(); } });

/* подсказка про экран «Домой» */
(() => {
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !standalone && !LS.get('hintHidden', false)) $('#installHint').hidden = false;
  $('#hintX').onclick = () => { $('#installHint').hidden = true; LS.set('hintHidden', true); };
})();

/* ───────────── читалка ───────────── */
async function openBook(id) {
  const meta = books.find((b) => b.id === id) || await DB.get('books', id);
  const model = await DB.get('texts', id);
  if (!meta || !model) { toast('Книга не найдена'); return; }
  if (book && book.id !== id) Player.stop();
  book = meta; M = model;
  sentPara = new Int32Array(M.sents.length);
  M.paras.forEach(([s0, n], i) => { for (let j = 0; j < n; j++) sentPara[s0 + j] = i; });
  sentChap = new Int32Array(M.sents.length);
  M.chaps.forEach((c, ci) => {
    const s0 = M.paras[c.p0][0];
    const last = M.paras[c.p1 - 1];
    for (let s = s0; s < last[0] + last[1]; s++) sentChap[s] = ci;
  });
  pos = Math.min(LS.get('pos:' + id, meta.pos || 0), M.sents.length - 1);
  book.opened = Date.now(); DB.put('books', book).catch(() => {});
  LS.set('lastBook', id);   // если iOS перезапустит приложение — вернёмся сюда же
  $('#libView').hidden = true; $('#readView').hidden = false;
  chapShown = -1;
  renderChapter(sentChap[pos]);
  markCur(pos, true);
  requestAnimationFrame(() => scrollToSent(pos, 'auto'));
  await Engine.openBook();
  updateTrackBar();
  updateMediaMeta();
}

function closeBook() {
  savePos(true);
  LS.del('lastBook');
  $('#readView').hidden = true; $('#libView').hidden = false;
  renderLibrary();
  window.scrollTo(0, 0);
}
$('#backBtn').onclick = closeBook;

function renderChapter(ci) {
  if (ci === chapShown) return;
  chapShown = ci;
  const c = M.chaps[ci];
  let html = '';
  let firstP = true;
  for (let p = c.p0; p < c.p1; p++) {
    const [s0, n, k] = M.paras[p];
    let inner = '';
    for (let s = s0; s < s0 + n; s++) inner += `<span class="s" id="s${s}">${esc(M.sents[s])}</span> `;
    if (k === 'h') html += `<h2>${inner}</h2>`;
    else if (k === 's') html += `<h3>${inner}</h3>`;
    else { html += `<p class="${k === 'p' ? (firstP ? 'first' : '') : k}">${inner}</p>`; if (k === 'p') firstP = false; }
  }
  if (ci + 1 < M.chaps.length) html += `<button class="next-chap" id="nextChap"><span>Дальше</span><b>${esc(M.chaps[ci + 1].title)}</b></button>`;
  else html += `<div class="end-mark">Конец</div>`;
  const r = $('#reader');
  r.innerHTML = html;
  spans = [...r.querySelectorAll('.s')];
  $('#chapBtn').innerHTML = esc(c.title) + (M.chaps.length > 1 ? ` <span>· ${ci + 1}/${M.chaps.length}</span>` : '');
  const nb = $('#nextChap');
  if (nb) nb.onclick = () => { const s = M.paras[M.chaps[ci + 1].p0][0]; setPos(s, { jump: true }); renderChapter(ci + 1); markCur(s, true); window.scrollTo(0, 0); };
}

function markCur(i, force) {
  const old = document.querySelector('.s.cur');
  if (old && (force || old.id !== 's' + i)) old.classList.remove('cur');
  const el = document.getElementById('s' + i);
  if (el) el.classList.add('cur');
}

function scrollToSent(i, behavior = 'smooth') {
  const el = document.getElementById('s' + i);
  if (!el) return;
  const r = el.getBoundingClientRect();
  const y = window.scrollY + r.top - window.innerHeight * 0.32;
  window.scrollTo({ top: Math.max(0, y), behavior });
}

let lastSaved = 0;
function savePos(force) {
  if (!book) return;
  LS.set('pos:' + book.id, pos);
  const now = Date.now();
  if (force || now - lastSaved > 4000) {
    lastSaved = now;
    book.pos = pos;
    DB.put('books', book).catch(() => {});
  }
}

// единая точка изменения закладки
function setPos(i, opt = {}) {
  i = Math.max(0, Math.min(M.sents.length - 1, i));
  pos = i;
  if (sentChap[i] !== chapShown) renderChapter(sentChap[i]);
  markCur(i);
  savePos();
  updateTrackBar();
  if (opt.jump) Engine.onJump(i);
}

// тап по предложению — закладка (и прыжок голоса)
$('#reader').addEventListener('click', (e) => {
  const s = e.target.closest('.s');
  if (!s) return;
  const i = +s.id.slice(1);
  setPos(i, { jump: true });
  if (Player.playing || Player.waiting) Player.playFrom(i);
});

// прокрутка при паузе: если закладка ушла из вида — переезжает к первой видимой строке
let userScrollAt = 0, scrollRaf = 0;
function firstVisible() {
  const top = $('#topbar').getBoundingClientRect().bottom;
  let lo = 0, hi = spans.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = spans[mid].getBoundingClientRect();
    if (r.bottom > top + 8) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans < 0 ? null : +spans[ans].id.slice(1);
}
function onScroll() {
  scrollRaf = 0;
  if (!M || Player.playing || Player.waiting) return;
  const el = document.getElementById('s' + pos);
  const vh = window.innerHeight;
  if (el) { const r = el.getBoundingClientRect(); if (r.bottom > $('#topbar').getBoundingClientRect().bottom && r.top < vh - 170) return; }
  const f = firstVisible();
  if (f != null && f !== pos) setPos(f, { jump: true });
}
window.addEventListener('scroll', () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(onScroll); }, { passive: true });
['touchmove', 'wheel'].forEach((ev) => window.addEventListener(ev, () => { userScrollAt = Date.now(); }, { passive: true }));

/* ───────────── движок озвучки ───────────── */
const Engine = {
  worker: null, voiceReady: false, loadingVoice: null, active: false,
  ready: new Map(),   // k → {len, offs}
  busy: false, token: 0, pending: new Map(), seq: 0,
  dl: null, error: null,

  key(k, v = settings.voice) { return book.id + '|' + v + '|' + pad(k); },
  chunkOf(i) { return Math.floor(i / CH); },
  nChunks() { return Math.ceil(M.sents.length / CH); },

  async openBook() {
    this.token++;
    this.busy = false;
    this.ready = new Map();
    const rows = await DB.entries('meta', book.id + '|' + settings.voice + '|').catch(() => []);
    for (const [k, v] of rows) this.ready.set(+k.slice(k.lastIndexOf('|') + 1), v);
    this.active = !!book.listened;
    this.filling = false;
    this.prune();
    this.pump();
    UI.status();
  },

  async voiceCached(v = settings.voice) {
    try { const c = await caches.open(ASSET_CACHE); return !!(await c.match(new URL(v + '.onnx', location.href).href)); } catch (e) { return false; }
  },

  ensureWorker() {
    if (this.worker && this.voiceReady === settings.voice) return this.loadingVoice || Promise.resolve();
    if (this.loadingVoice && this.loadingVoiceName === settings.voice) return this.loadingVoice;
    if (!this.worker) {
      this.worker = new Worker('tts-worker.js', { type: 'module' });
      this.worker.onmessage = (e) => this.onMsg(e.data);
      this.worker.onerror = (e) => { this.error = 'Сбой движка озвучки'; UI.status(); };
    }
    this.error = null;
    this.voiceReady = false;
    this.loadingVoiceName = settings.voice;
    this.loadingVoice = new Promise((res, rej) => { this._vres = res; this._vrej = rej; });
    this.worker.postMessage({ type: 'init', voice: settings.voice });
    UI.status();
    return this.loadingVoice;
  },

  onMsg(m) {
    if (m.type === 'progress') { this.dl = m; UI.status(); }
    else if (m.type === 'status') { this.dl = { label: m.text }; UI.status(); }
    else if (m.type === 'ready') {
      this.dl = null; this.voiceReady = m.voice; this.loadingVoice = null;
      this._vres && this._vres(); this.pump(); UI.status(); UI.voices();
    } else if (m.type === 'audio') {
      const p = this.pending.get(m.id); this.pending.delete(m.id); p && p.res(m);
    } else if (m.type === 'error') {
      if (m.id != null && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); p.rej(new Error(m.message)); }
      else { this.dl = null; this.error = m.message; this.loadingVoice = null; this._vrej && this._vrej(new Error(m.message)); UI.status(); }
    }
  },

  synth(pieces) {
    const id = ++this.seq;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.worker.postMessage({ type: 'synth', id, pieces }); });
  },

  pauseAfter(i) {
    const p = sentPara[i];
    const [s0, n, k] = M.paras[p];
    if (k === 'h') return 0.85;
    if (k === 's') return 0.6;
    if (i === s0 + n - 1) return k === 'v' ? 0.35 : 0.6;
    return 0.28;
  },

  aheadSec(from = pos) {
    let k = this.chunkOf(from), t = 0;
    const meta = this.ready.get(k);
    if (!meta) return 0;
    t -= meta.offs[from - k * CH] || 0;
    for (; this.ready.has(k); k++) t += this.ready.get(k).len;
    return t / SR;
  },

  nextMissing() {
    const n = this.nChunks();
    let k = this.chunkOf(pos), t = 0;
    const start = k;
    for (; k < n; k++) {
      const m = this.ready.get(k);
      if (!m) return k;
      if (k > start) t += m.len / SR;
      if (t > settings.ahead) return -1;
    }
    return -1;
  },

  // какой кусок озвучивать следующим (или -1, если сейчас ничего не нужно)
  needWork() {
    const k = this.nextMissing();
    if (k < 0) return -1;
    if (this.filling || this.aheadSec() < AHEAD_LOW) return k;
    return -1;
  },

  // движок не нужен — через несколько секунд выгружаем его и освобождаем память
  scheduleSleep() {
    if (!this.worker || this._sleepT) return;
    this._sleepT = setTimeout(() => {
      this._sleepT = null;
      if (!this.worker || this.busy || this.pending.size || this.loadingVoice || this.needWork() >= 0) return;
      this.worker.terminate();
      this.worker = null; this.voiceReady = false; this.loadingVoice = null;
      UI.status();
    }, 8000);
  },

  async pump() {
    if (!this.active || this.busy || !book) { Wake.sync(); return; }
    const k = this.needWork();
    if (k < 0) { this.filling = false; this.scheduleSleep(); Wake.sync(); UI.status(); return; }
    this.filling = true;
    if (this._sleepT) { clearTimeout(this._sleepT); this._sleepT = null; }
    if (this.voiceReady !== settings.voice) { this.ensureWorker(); return; }   // проснётся — сообщение 'ready' снова вызовет pump
    this.busy = true; Wake.sync(); UI.status();
    const tok = this.token, bid = book.id, voice = settings.voice;
    try {
      const s0 = k * CH, s1 = Math.min(s0 + CH, M.sents.length);
      const parts = [], offs = [];
      let len = 0;
      for (let i = s0; i < s1; i++) {
        offs.push(len);
        const para = M.paras[sentPara[i]];
        const pieces = ttsPieces(M.sents[i], para[2]);
        const r = await this.synth(pieces);
        if (tok !== this.token) return;
        const pcm = r.pcm;
        // защита: текст есть, а звука нет — не сохраняем тишину, показываем причину
        if (pieces.length && (r.stats.peak < 0.01 || r.stats.nan > r.stats.samples * 0.01)) {
          throw new Error(`голос выдал тишину (фонем ${r.stats.ids}, отсчётов ${r.stats.samples}, NaN ${r.stats.nan}, пик ${r.stats.peak.toFixed(3)})`);
        }
        parts.push(pcm); len += pcm.length;
        const pz = Math.round(this.pauseAfter(i) * SR);
        parts.push(new Int16Array(pz)); len += pz;
      }
      const all = new Int16Array(len);
      let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
      const key = bid + '|' + voice + '|' + pad(k);
      // Blob живёт на диске, не в памяти; если браузер не умеет хранить Blob — сохраняем как есть
      try { await DB.put('pcm', new Blob([all], { type: 'application/octet-stream' }), key); }
      catch (e) { await DB.put('pcm', all.buffer, key); }
      await DB.put('meta', { len, offs }, key);
      if (tok !== this.token) return;
      this.ready.set(k, { len, offs });
      Player.onChunk(k);
      updateTrackBar();
    } catch (err) {
      if (tok !== this.token) return;
      console.error(err);
      this.error = 'Не получилось озвучить: ' + ((err && err.message) || String(err));
      this.active = false;   // не крутим генерацию вхолостую
      Player.onError();
    } finally {
      if (tok === this.token) { this.busy = false; setTimeout(() => this.pump(), 0); }
      UI.status();
    }
  },

  onJump() { if (this.active) this.pump(); },

  async prune() {
    // чистим озвучку далеко позади закладки (больше ~500 предложений)
    const lim = this.chunkOf(pos) - 80;
    if (lim <= 0) return;
    for (const k of [...this.ready.keys()]) {
      if (k < lim) { this.ready.delete(k); DB.del('pcm', this.key(k)).catch(() => {}); DB.del('meta', this.key(k)).catch(() => {}); }
    }
  },

  async start(i = pos) {
    if (!book.listened) { book.listened = true; DB.put('books', book).catch(() => {}); }
    this.active = true;
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
    this.pump();
    if (this.ready.has(this.chunkOf(i))) return;   // играть можно сразу, движок не нужен
    return this.ensureWorker();
  },

  async switchVoice(v) {
    if (v === settings.voice) return;
    Player.stop();
    settings.voice = v; saveSettings();
    this.token++; this.busy = false;
    for (const [, p] of this.pending) p.rej(new Error('cancel'));
    this.pending.clear();
    if (this.worker) { this.worker.terminate(); this.worker = null; this.voiceReady = false; this.loadingVoice = null; }
    if (book) await this.openBook();
    UI.voices();
  },
};

/* экран не гаснет, пока идёт подготовка озвучки */
const Wake = {
  lock: null,
  async sync() {
    const want = Engine.busy && !document.hidden;
    if (want && !this.lock && 'wakeLock' in navigator) {
      try { this.lock = await navigator.wakeLock.request('screen'); this.lock.addEventListener('release', () => { this.lock = null; }); } catch (e) {}
    } else if (!want && this.lock) { this.lock.release().catch(() => {}); this.lock = null; }
  },
};

/* ───────────── проигрыватель ───────────── */
function wavHeader(samples) {
  const b = new ArrayBuffer(44), v = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples * 2, true);
  return b;
}
const SILENCE = URL.createObjectURL(new Blob([wavHeader(2205), new Int16Array(2205)], { type: 'audio/wav' }));

const Player = {
  audio: null, track: null, playing: false, waiting: false, waitFor: null, lastSent: -1, unlocked: false,

  init() {
    const a = this.audio = new Audio();
    a.preload = 'auto';
    a.preservesPitch = true; a.webkitPreservesPitch = true;
    a.addEventListener('timeupdate', () => this.onTime());
    a.addEventListener('ended', () => this.onEnded());
    // если браузер не смог открыть звуковой файл — пересобираем его и продолжаем с того же места
    a.addEventListener('error', () => {
      const t = this.track;
      if (!t || a.src !== t.url || !this.want) return;
      this._errs = (this._errs || 0) + 1;
      if (this._errs > 3) { this.playing = false; this.waiting = false; UI.play(); toast('Не получилось воспроизвести — нажмите ▶'); return; }
      const i = pos;
      this.track = null;
      setTimeout(() => { URL.revokeObjectURL(t.url); if (this.want) this.playFrom(i); }, 300 * this._errs);
    });
    a.addEventListener('pause', () => {
      // Safari присылает 'pause' раньше 'ended' — конец трека не считаем остановкой
      const atEnd = a.ended || (a.duration > 0 && a.currentTime >= a.duration - 0.3);
      if (this.playing && !this._switching && !atEnd) { this.playing = false; UI.play(); savePos(true); }
    });
    a.addEventListener('play', () => { if (!this.playing && this.track && a.src === this.track.url) { this.playing = true; UI.play(); } });
    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      const h = (n, f) => { try { ms.setActionHandler(n, f); } catch (e) {} };
      h('play', () => this.toggle(true));
      h('pause', () => this.toggle(false));
      h('previoustrack', () => this.step(-1));
      h('nexttrack', () => this.step(1));
      h('seekbackward', () => this.step(-2));
      h('seekforward', () => this.step(2));
    }
  },

  // iOS разрешает звук только из жеста — «разблокируем» элемент тишиной
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    const a = this.audio;
    a.src = SILENCE;
    a.play().catch(() => {});
  },

  async toggle(want) {
    if (!book) return;
    const on = want === undefined ? !(this.playing || this.waiting) : want;
    if (!on) return this.pause();
    this.want = true;
    this.unlock();
    const t = this.track, a = this.audio;
    if (t && a.src === t.url && pos >= t.s0 && pos < t.k1 * CH && t.times[pos - t.s0] != null) {
      // быстрый путь: трек уже загружен — просто продолжаем
      if (this.sentAt(a.currentTime) !== pos) a.currentTime = t.times[pos - t.s0];
      a.playbackRate = settings.speed;
      a.play().then(() => { this.playing = true; UI.play(); UI.status(); }).catch(() => this.playFrom(pos));
      document.body.classList.add('playing');
      return;
    }
    this.playFrom(pos);
  },

  pause() {
    this.want = false;           // пользователь сам поставил паузу
    this.waiting = false; this.waitFor = null;
    this.playing = false;
    try { this.audio.pause(); } catch (e) {}
    document.body.classList.remove('playing');
    savePos(true); UI.play(); UI.status();
  },

  stop() {
    this.pause();
    if (this.track) { URL.revokeObjectURL(this.track.url); this.track = null; }
  },

  async playFrom(i, exactOffset) {
    this.want = true;
    const k = Engine.chunkOf(i);
    const t = this.track, a = this.audio;
    // прыжок внутри уже загруженного трека — мгновенно, без пересборки
    if (exactOffset == null && t && a.src === t.url && i >= t.s0 && i < t.k1 * CH && t.times[i - t.s0] != null) {
      this.waitFor = null; this.waiting = false;
      a.currentTime = t.times[i - t.s0];
      a.playbackRate = settings.speed;
      a.play().then(() => { this.playing = true; UI.play(); UI.status(); }).catch(() => {});
      this.playing = true; UI.play(); UI.status();
      return;
    }
    // иначе глушим старый звук сразу, чтобы текст и голос не разъезжались
    this._switching = true;
    try { a.pause(); } catch (e) {}
    this._switching = false;
    this.playing = false;
    this.waiting = true; this.waitFor = { k, i, exactOffset };
    document.body.classList.add('playing');
    UI.play(); UI.status();
    try { await Engine.start(i); } catch (e) { this.waiting = false; UI.play(); UI.status(); return; }
    if (Engine.ready.has(k)) this.startTrack(k, i, exactOffset);
    else Engine.pump();
  },

  onError() {
    if (this.waiting) { this.waiting = false; this.waitFor = null; UI.play(); }
  },

  onChunk(k) {
    if (this.waiting && this.waitFor && this.waitFor.k === k) {
      const w = this.waitFor; this.startTrack(w.k, w.i, w.exactOffset);
    } else if (this.stalledAt === k) {
      this.stalledAt = null; this.startTrack(k, k * CH, 0);
    }
  },

  async buildTrack(k0) {
    const ks = []; let tot = 0;
    for (let k = k0; Engine.ready.has(k) && tot < MAX_TRACK * SR; k++) { ks.push(k); tot += Engine.ready.get(k).len; }
    if (!ks.length) return null;
    // куски приходят как Blob-ссылки на файлы — трек собирается без копирования звука в память
    const bufs = await Promise.all(ks.map((k) => DB.get('pcm', Engine.key(k))));
    let n = bufs.findIndex((b) => !b);
    if (n === 0) { Engine.ready.delete(k0); return null; }
    if (n > 0) { for (let j = n; j < ks.length; j++) Engine.ready.delete(ks[j]); ks.length = n; bufs.length = n; }
    const s0 = k0 * CH;
    const times = [];
    let base = 0;
    ks.forEach((k) => { const m = Engine.ready.get(k); m.offs.forEach((o) => times.push((base + o) / SR)); base += m.len; });
    const blob = new Blob([wavHeader(base), ...bufs], { type: 'audio/wav' });
    return { k0, k1: k0 + ks.length, s0, times, dur: base / SR, url: URL.createObjectURL(blob) };
  },

  async startTrack(k, i, exactOffset) {
    const t = await this.buildTrack(k);
    if (!t) { Engine.pump(); return; }
    if (this.waitFor && this.waitFor.k !== k) return; // пользователь уже прыгнул
    const old = this.track;
    this.track = t;
    const a = this.audio;
    const at = exactOffset != null ? exactOffset : (t.times[i - t.s0] || 0);
    this._switching = true;
    a.src = t.url;
    a.playbackRate = settings.speed;
    a.defaultPlaybackRate = settings.speed;
    await new Promise((res) => { if (a.readyState >= 1) res(); else a.addEventListener('loadedmetadata', res, { once: true }); setTimeout(res, 1500); });
    try { a.currentTime = at; } catch (e) {}
    a.playbackRate = settings.speed;
    try {
      await a.play();
      this.playing = true;
    } catch (e) {
      this.playing = false;
      if (!a.error) toast('Нажмите ▶ ещё раз');   // ошибку файла обработает 'error' — там повтор
    }
    this._switching = false;
    this.waiting = false; this.waitFor = null;
    if (old) setTimeout(() => URL.revokeObjectURL(old.url), 3000);
    UI.play(); UI.status(); updateMediaMeta();
  },

  sentAt(time) {
    const T = this.track.times;
    let lo = 0, hi = T.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T[m] <= time + 0.02) lo = m; else hi = m - 1; }
    return this.track.s0 + lo;
  },

  onTime() {
    if (!this.track || !this.playing || this.audio.src !== this.track.url) return;
    const i = this.sentAt(this.audio.currentTime);
    if (i !== pos) {
      this._errs = 0;   // звук идёт — счётчик ошибок сбрасываем
      setPos(i);
      if (!document.hidden && Date.now() - userScrollAt > 4000) {
        const el = document.getElementById('s' + i);
        if (el) { const r = el.getBoundingClientRect(); if (r.top < 80 || r.bottom > window.innerHeight * 0.62) scrollToSent(i); }
      }
      if (Engine.active) Engine.pump();
    }
    UI.posBar();
  },

  onEnded() {
    // продолжаем, если слушатель не ставил паузу сам (флаг playing мог сброситься событием pause)
    if (!this.track || !this.want || this.audio.src !== this.track.url) return;
    this.playing = true;
    const k1 = this.track.k1;
    if (k1 * CH >= M.sents.length) { this.pause(); setPos(M.sents.length - 1); toast('Книга закончилась'); return; }
    if (Engine.ready.has(k1)) { this.waitFor = { k: k1 }; this.startTrack(k1, k1 * CH, 0); }
    else {
      // озвучка не успела — ждём следующий кусок
      this.stalledAt = k1; this.playing = false; this.waiting = true;
      this.waitFor = { k: k1, i: k1 * CH };
      setPos(k1 * CH);
      UI.play(); UI.status(); Engine.pump();
    }
  },

  // перед уходом в фон пересобираем трек так, чтобы в нём был весь готовый запас
  refillForBackground() {
    if (!this.playing || !this.track) return;
    if (!Engine.ready.has(this.track.k1)) return;
    const a = this.audio;
    // трогаем трек только если он скоро кончится — иначе продолжение подхватит 'ended'
    if ((this.track.dur - a.currentTime) / settings.speed > 300) return;
    const i = this.sentAt(a.currentTime);
    const k = Engine.chunkOf(i);
    const offInTrack = a.currentTime;
    const kStartTime = this.track.times[k * CH - this.track.s0] || 0;
    this.waitFor = { k, i };
    this.startTrack(k, i, Math.max(0, offInTrack - kStartTime));
  },

  step(d) {
    const i = Math.max(0, Math.min(M.sents.length - 1, pos + d));
    setPos(i, { jump: true });
    scrollToSent(i);
    if (this.playing || this.waiting) this.playFrom(i);
  },

  setSpeed(s) {
    settings.speed = s; saveSettings();
    if (this.audio) { this.audio.playbackRate = s; this.audio.defaultPlaybackRate = s; }
    UI.speed(); UI.status();
  },
};

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { savePos(true); Player.refillForBackground(); }
  Wake.sync();
  if (!document.hidden && Engine.active) Engine.pump();
});
window.addEventListener('pagehide', () => savePos(true));

function updateMediaMeta() {
  if (!('mediaSession' in navigator) || !book) return;
  try {
    const art = book.cover ? [{ src: book.cover, sizes: '512x512' }] : [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }];
    navigator.mediaSession.metadata = new MediaMetadata({ title: M.chaps[sentChap[pos]].title, artist: book.author || 'Вслух', album: book.title, artwork: art });
  } catch (e) {}
}

/* ───────────── интерфейс плеера ───────────── */
const UI = {
  play() {
    const busy = Player.waiting;
    const on = Player.playing || busy;
    $('#playBtn').classList.toggle('on', on);   // иконка ▶/❚❚ переключается анимацией в CSS
    $('#spin').hidden = !busy;
    $('#playBtn').setAttribute('aria-label', on ? 'Пауза' : 'Слушать');
    document.body.classList.toggle('playing', on);
    if ('mediaSession' in navigator) try { navigator.mediaSession.playbackState = Player.playing ? 'playing' : 'paused'; } catch (e) {}
  },
  speed() { $('#speedBtn').textContent = String(settings.speed).replace('.', ',') + '×'; },
  status() {
    const st = $('#status'), tx = $('#statusText');
    let cls = '', html = '';
    if (Engine.error) { cls = 'err'; html = esc(Engine.error) + ' <button id="retryBtn">Повторить</button>'; }
    else if (Engine.dl && Engine.dl.total) { cls = 'work'; html = `${esc(Engine.dl.label)}: ${fmtMB(Engine.dl.got)} из ${fmtMB(Engine.dl.total)} · один раз`; }
    else if (Engine.dl) { cls = 'work'; html = esc(Engine.dl.label || 'Готовлю голос…'); }
    else if (!Engine.active) { html = 'Нажмите ▶ — голос продолжит с подсвеченного места'; }
    else if (Engine.loadingVoice) { cls = 'work'; html = 'Запускаю голос…'; }
    else if (Player.waiting) { cls = 'work'; html = 'Озвучиваю первые фразы…'; }
    else {
      const a = Engine.aheadSec() / settings.speed;
      if (Engine.busy || Engine.filling) { cls = 'work'; html = `Озвучено впрок: ${fmtDur(a)} · готовлю дальше`; }
      else { cls = 'ok'; html = `Готово впрок: ${fmtDur(a)} — можно блокировать экран`; }
    }
    st.className = 'status ' + cls; tx.innerHTML = html;
    const rb = $('#retryBtn'); if (rb) rb.onclick = () => { Engine.error = null; Engine.active = true; if (Engine.worker) Engine.worker.postMessage({ type: 'reset' }); Engine.loadingVoice = null; Engine.voiceReady = false; Engine.ensureWorker(); Engine.pump(); };
  },
  posBar() {
    if (!M) return;
    const n = M.sents.length;
    let p = pos / n;
    $('#trkPos').style.width = (p * 100).toFixed(2) + '%';
  },
  voices() {
    const el = $('#voices');
    if (!el) return;
    el.innerHTML = VOICES.map((v) => `<button class="voice ${v.id === settings.voice ? 'on' : ''}" data-v="${v.id}"><b>${v.name}</b><small>${v.desc}</small><span class="tag" data-tag="${v.id}">${v.id === settings.voice ? 'выбран' : ''}</span></button>`).join('');
    VOICES.forEach(async (v) => { if (v.id !== settings.voice && await Engine.voiceCached(v.id)) { const t = el.querySelector(`[data-tag="${v.id}"]`); if (t) t.textContent = 'скачан'; } });
  },
};

function updateTrackBar() {
  if (!M) return;
  const n = M.sents.length;
  const a = Engine.aheadSec();
  // сколько предложений покрыто готовой озвучкой
  let k = Engine.chunkOf(pos); while (Engine.ready.has(k)) k++;
  const covered = Math.min(n, k * CH);
  $('#trkReady').style.width = ((covered / n) * 100).toFixed(2) + '%';
  UI.posBar();
  if (!Player.playing) UI.status();
  else if (a >= 0) UI.status();
}

$('#playBtn').onclick = () => Player.toggle();
$('#prevBtn').onclick = () => Player.step(-1);
$('#nextBtn').onclick = () => Player.step(1);
$('#speedBtn').onclick = () => { const i = SPEEDS.indexOf(settings.speed); Player.setSpeed(SPEEDS[(i + 1) % SPEEDS.length]); };

/* ───────────── листы: оглавление и настройки ───────────── */
function openSheet(id) {
  const sc = $('#scrim'); sc.hidden = false;
  requestAnimationFrame(() => { sc.classList.add('on'); $(id).classList.add('on'); });
}
function closeSheets() {
  const sc = $('#scrim'); sc.classList.remove('on');
  document.querySelectorAll('.sheet.on').forEach((s) => s.classList.remove('on'));
  setTimeout(() => { sc.hidden = true; }, 220);
}
$('#scrim').onclick = closeSheets;
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeSheets; });

$('#chapBtn').onclick = () => {
  const cur = sentChap[pos];
  $('#toc').innerHTML = M.chaps.map((c, i) => `<li><button class="${i === cur ? 'on' : ''}" data-c="${i}"><span class="n">${i + 1}</span><span>${esc(c.title)}</span></button></li>`).join('');
  openSheet('#tocSheet');
  const on = $('#toc .on'); if (on) on.scrollIntoView({ block: 'center' });
};
$('#toc').onclick = (e) => {
  const b = e.target.closest('[data-c]'); if (!b) return;
  const ci = +b.dataset.c;
  const s = M.paras[M.chaps[ci].p0][0];
  closeSheets();
  setPos(s, { jump: true });
  window.scrollTo(0, 0);
  markCur(s, true);
  if (Player.playing || Player.waiting) Player.playFrom(s);
};

$('#setBtn').onclick = async () => {
  UI.voices();
  $('#fontIn').value = settings.font;
  document.querySelectorAll('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.theme));
  openSheet('#setSheet');
  try {
    const e = await navigator.storage.estimate();
    $('#storeInfo').textContent = 'Занято на устройстве: ' + fmtMB(e.usage || 0);
  } catch (err) { $('#storeInfo').textContent = ''; }
};
$('#voices').onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) Engine.switchVoice(b.dataset.v); };
$('#fontIn').oninput = (e) => {
  const anchor = pos;
  settings.font = +e.target.value; saveSettings(); applyLook();
  scrollToSent(anchor, 'auto');
};
$('#themeSeg').onclick = (e) => {
  const b = e.target.closest('[data-v]'); if (!b) return;
  settings.theme = b.dataset.v; saveSettings(); applyLook();
  document.querySelectorAll('#themeSeg button').forEach((x) => x.classList.toggle('on', x === b));
};
// «Проверить голос»: синтез тестовой фразы, цифры и звук — чтобы сразу видеть, работает ли озвучка на этом устройстве
if ($('#testVoice')) $('#testVoice').onclick = async () => {
  const out = $('#testOut');
  out.textContent = 'Готовлю голос…';
  Player.unlock();
  try {
    Engine.active = true;
    await Engine.ensureWorker();
    const t0 = performance.now();
    const r = await Engine.synth(['Проверка связи. Раз, два, три.']);
    const s = r.stats, dur = r.pcm.length / SR;
    const ok = s.peak >= 0.01 && s.nan === 0;
    out.textContent = (ok ? '✓ Звук есть. ' : '✗ Голос выдал тишину. ') +
      `${dur.toFixed(1)} с за ${((performance.now() - t0) / 1000).toFixed(1)} с · пик ${s.peak.toFixed(2)} · NaN ${s.nan}`;
    const url = URL.createObjectURL(new Blob([wavHeader(r.pcm.length), r.pcm], { type: 'audio/wav' }));
    const a = Player.audio; Player.pause();
    a.src = url; a.playbackRate = 1; a.currentTime = 0;
    await a.play();
  } catch (err) { out.textContent = '✗ ' + (err.message || err); }
};
$('#clearAudio').onclick = async () => {
  const btn = $('#clearAudio');
  if (!btn.dataset.sure) { btn.dataset.sure = '1'; btn.textContent = 'Точно удалить?'; setTimeout(() => { btn.dataset.sure = ''; btn.textContent = 'Удалить озвучку'; }, 3000); return; }
  Player.stop();
  for (const b of books) { await DB.delPrefix('pcm', b.id + '|'); await DB.delPrefix('meta', b.id + '|'); }
  btn.dataset.sure = ''; btn.textContent = 'Удалить озвучку';
  if (book) await Engine.openBook();
  updateTrackBar();
  toast('Озвучка удалена, книги на месте');
  try { const e = await navigator.storage.estimate(); $('#storeInfo').textContent = 'Занято на устройстве: ' + fmtMB(e.usage || 0); } catch (err) {}
};

function applyLook() {
  const r = document.documentElement;
  if (settings.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', settings.theme);
  r.style.setProperty('--fs', settings.font + 'px');
  const bg = getComputedStyle(r).getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name=theme-color]').forEach((m) => { if (settings.theme !== 'auto') m.setAttribute('content', bg); });
}

/* ───────────── запуск ───────────── */
applyLook();
UI.speed();
// iOS: звук как у плеера — играет при беззвучном режиме и в фоне
try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
// выбрасываем озвучку старых версий (могла быть сохранена тишина)
if (LS.get('audioVer', 1) !== AUDIO_VER) {
  Promise.all([DB.delPrefix('pcm', ''), DB.delPrefix('meta', '')]).catch(() => {}).then(() => LS.set('audioVer', AUDIO_VER));
}
Player.init();
loadLibrary().then(() => {
  const last = LS.get('lastBook', null);
  if (last && books.some((b) => b.id === last)) openBook(last);
});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
