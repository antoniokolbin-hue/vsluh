// Вслух — фоновый синтез речи. Работает полностью офлайн:
// espeak-ng (фонемы) + Piper VITS (нейросеть) через onnxruntime-web.
import * as ort from './ort.wasm.bundle.min.mjs';
import createPiperPhonemize from './piper_phonemize.mjs';
import { ACUTE, trickSpelling, stressed, idsOf, wordTokens, findWord, replaceAt } from './ru-stress.mjs';
import { KOKORO_SR, enNormalize, enFixPhonemes, kokoroIds, resample, enVoiceFor } from './kokoro-en.mjs';

const ASSET_CACHE = 'vsluh-assets-v1';
const base = new URL('./', import.meta.url).href;
const SAMPLE_RATE = 22050;

ort.env.wasm.wasmPaths = base;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

let phon = null;          // модуль espeak
let phonOut = null;       // куда пишет print()
let session = null;       // ONNX-сессия голоса
let voiceName = null;
let ready = null;

// Скачать файл(ы) один раз и навсегда положить в Cache Storage (с прогрессом).
// Большие голоса лежат на сервере кусками по 20 МБ и склеиваются здесь.
// Тяжёлые файлы берём с публичных CDN (jsDelivr, Hugging Face) один раз и кэшируем.
// Если рядом с приложением лежат куски *.partN — они подойдут как запасной вариант.
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/';
const SOURCES = {
  'ort-wasm-simd-threaded.wasm': { size: 14239897, urls: [['https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.wasm'], 2] },
  'piper_phonemize.data': { size: 18077249, urls: [['https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data'], 2] },
};
for (const v of ['denis', 'dmitri', 'irina', 'ruslan']) SOURCES[v + '.onnx'] = { size: 63201294, urls: [[HF + v + '/medium/ru_RU-' + v + '-medium.onnx'], 7] };
// английский голос Kokoro v1.0 (Apache-2.0): модель q8 и голоса
const HF_KOKORO = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/';
SOURCES['kokoro-en.onnx'] = { size: 92361116, urls: [[HF_KOKORO + 'onnx/model_quantized.onnx'], 1] };
for (const v of ['af_heart', 'af_bella', 'am_michael', 'bf_emma', 'bm_george']) SOURCES['kokoro-' + v + '.bin'] = { size: 522240, urls: [[HF_KOKORO + 'voices/' + v + '.bin'], 1] };

async function openCache() { try { return await caches.open(ASSET_CACHE); } catch (e) { return null; } }

async function download(urls, label, totalHint) {
  const parts = [];
  let got = 0, lastPost = 0, total = totalHint || 0;
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Не удалось скачать ' + url.split('/').pop() + ' (' + res.status + ')');
    if (!totalHint) total += +res.headers.get('content-length') || 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      const now = Date.now();
      if (now - lastPost > 150) { lastPost = now; postMessage({ type: 'progress', label, got, total: Math.max(total, got) }); }
    }
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  postMessage({ type: 'progress', label, got, total: got });
  return buf;
}

async function getAsset(path, label) {
  const url = base + path;
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return await hit.arrayBuffer();
  }
  const src = SOURCES[path];
  const variants = src
    ? [src.urls[0], Array.from({ length: src.urls[1] }, (_, i) => url + '.part' + i)]
    : [[url]];
  let buf = null, lastErr = null;
  for (const urls of variants) {
    try { buf = await download(urls, label, src ? src.size : 0); break; }
    catch (e) { lastErr = e; }
  }
  if (!buf) throw new Error('Нет интернета или файл недоступен — ' + (lastErr && lastErr.message));
  if (cache) {
    try { await cache.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })); }
    catch (e) { /* нет места — просто не кэшируем */ }
  }
  return buf.buffer;
}

// Движок произношения (eSpeak) — маленький wasm-модуль. Две его особенности:
// 1) у него фиксированная память, и через несколько десятков фраз он «переполняется»;
// 2) в Safari (JavaScriptCore) долгоживущий экземпляр eSpeak доводит оптимизирующий
//    компилятор wasm до падения, и iOS перезагружает страницу.
// Поэтому движок живёт коротко: каждые PHON_LIFE фраз он собирается заново из байтов
// (новая компиляция обнуляет «горячесть» кода), а при любой ошибке — сразу.
const PHON_LIFE = 20;
let phonBytes = null, phonData = null, phonDirty = false, phonUses = 0;
async function loadPhonemizer() {
  if (phonBytes) { if (!phon) phon = await makePhon(); return; }
  const [wasm, data] = await Promise.all([
    getAsset('piper_phonemize.wasm', 'Движок произношения'),
    getAsset('piper_phonemize.data', 'Словарь произношения'),
  ]);
  phonBytes = wasm;
  phonData = data;
  phon = await makePhon();
}
async function makePhon() {
  phonDirty = false;
  phonUses = 0;
  phon = null;   // отпускаем старый экземпляр, чтобы память освободилась
  const mod = await WebAssembly.compile(phonBytes);   // свежая компиляция, а не повторный экземпляр
  return createPiperPhonemize({
    noInitialRun: true,
    instantiateWasm: (imports, done) => { WebAssembly.instantiate(mod, imports).then((inst) => done(inst)); return {}; },
    getPreloadedPackage: () => phonData,
    print: (line) => { phonOut = line; },
    printErr: () => {},
    locateFile: (u) => base + u,
  });
}

async function loadVoice(name) {
  if (session && voiceName === name) return;
  if (!ort.env.wasm.wasmBinary) ort.env.wasm.wasmBinary = await getAsset('ort-wasm-simd-threaded.wasm', 'Нейродвижок');
  const model = await getAsset(name + '.onnx', 'Голос');
  postMessage({ type: 'status', text: 'Запускаю голос…' });
  if (session) { try { await session.release(); } catch (e) {} }
  // без «арены» ORT не держит пиковую память навсегда — важно для iPhone
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false });
  voiceName = name;
}

function phonemizeOnce(text, lang) {
  phonOut = null;
  try {
    phon.callMain(['-l', lang, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
  } catch (e) { phonDirty = true; }
  if (!phonOut) { phonDirty = true; return null; }
  try { return JSON.parse(phonOut); } catch (e) { return null; }
}
// полный ответ eSpeak: { phonemes, phoneme_ids }
async function phonemizeJSON(text, lang = 'ru') {
  if (phonDirty || phonUses >= PHON_LIFE) phon = await makePhon();
  phonUses++;
  let r = phonemizeOnce(text, lang);
  if (!r) {                         // перезапуск и вторая попытка
    phon = await makePhon();
    r = phonemizeOnce(text, lang);
  }
  if (!r && lang === 'ru') {        // третья: только кириллица и цифры
    phon = await makePhon();
    r = phonemizeOnce(text.replace(/[^\u0400-\u04FF0-9\s.,!?;:\-]/g, ' ').replace(/\s+/g, ' ').trim() || '.', lang);
  }
  return r;
}
async function phonemize(text) { const r = await phonemizeJSON(text, 'ru'); return r && r.phoneme_ids; }

/* ───────────── ударения: «за́мок» → нужный слог ─────────────
   Слово со знаком U+0301 озвучиваем «с подменой» (см. ru-stress.mjs) и вставляем
   получившиеся фонемы на место этого слова во фразе. Правила кэшируем на всё время жизни воркера. */
const stressRules = new Map();   // 'замок' → { from, to: {0: [...], 1: [...]} }
async function stressRule(w, ss) {
  let r = stressRules.get(w);
  const need = ss.filter((s) => !r || !(s in r.to));
  if (r && !need.length) return r;
  const tricks = need.map((s) => trickSpelling(w, s));
  const res = await phonemizeJSON([w, ...tricks.map((t) => (t ? t.spell : w))].join(', '), 'ru');
  const parts = res ? res.phonemes.join('').split(',').map((x) => x.trim()) : [];
  if (parts.length !== need.length + 1) return r || null;
  if (!r) r = { from: idsOf(parts[0]), to: {} };
  need.forEach((s, i) => { const t = tricks[i]; const f = t ? stressed(parts[0], parts[i + 1], t) : null; r.to[s] = f ? idsOf(f) : null; });
  stressRules.set(w, r);
  return r;
}
async function ruIds(text) {
  if (!text.includes(ACUTE)) return phonemize(text);
  let ids = await phonemize(text.replace(/\u0301/g, ''));
  if (!ids) return ids;
  const toks = wordTokens(text);
  for (const w of new Set(toks.filter((t) => t.s >= 0).map((t) => t.w))) {
    const occ = toks.filter((t) => t.w === w);
    const ss = [...new Set(occ.map((t) => t.s).filter((s) => s >= 0))];
    const rule = await stressRule(w, ss);
    if (!rule) continue;
    const pos = findWord(ids, rule.from);
    let places = [];
    if (pos.length === occ.length) places = pos.map((at, i) => ({ at, to: (occ[i].s >= 0 && rule.to[occ[i].s]) || rule.from }));
    else if (ss.length === 1 && occ.every((t) => t.s === ss[0]) && rule.to[ss[0]]) places = pos.map((at) => ({ at, to: rule.to[ss[0]] }));
    ids = replaceAt(ids, places, rule.from.length);
  }
  return ids;
}

/* ───────────── английский: Kokoro v1.0 ─────────────
   Грузится только когда в книге встретился английский. Если не загрузился (нет сети) —
   английский читает русский голос, как раньше, и книга не останавливается. */
const kk = { session: null, voice: null, voiceName: null, want: null, failed: false, loading: null };
async function kokoroReady() {
  const name = kk.want && kk.want !== 'auto' ? kk.want : enVoiceFor(voiceName);
  if (kk.session && kk.voiceName === name) return true;
  if (kk.failed) return false;
  if (!kk.loading) kk.loading = (async () => {
    try {
      if (!kk.session) {
        const model = await getAsset('kokoro-en.onnx', 'Английский голос');
        postMessage({ type: 'status', text: 'Запускаю английский голос…' });
        kk.session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false });
      }
      kk.voice = new Float32Array(await getAsset('kokoro-' + name + '.bin', 'Английский голос'));
      kk.voiceName = name;
      return true;
    } catch (e) {
      kk.failed = true;
      postMessage({ type: 'status', text: 'Английский голос не загрузился — английский читает русский голос' });
      return false;
    } finally { kk.loading = null; }
  })();
  return kk.loading;
}
async function kokoroSay(text) {
  const american = (kk.voiceName || '')[0] === 'a';
  const r = await phonemizeJSON(enNormalize(text), american ? 'en-us' : 'en');
  if (!r) throw new Error('движок произношения не ответил');
  const ids = kokoroIds(enFixPhonemes(r.phonemes.join(''), american));
  if (ids.length < 3) return new Float32Array(0);
  const n = Math.min(ids.length - 2, 509);
  const out = await kk.session.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    style: new ort.Tensor('float32', kk.voice.slice(n * 256, n * 256 + 256), [1, 256]),
    speed: new ort.Tensor('float32', Float32Array.of(1), [1]),
  });
  return resample(Float32Array.from(out.waveform.data), KOKORO_SR, SAMPLE_RATE);
}

// какие куски фразы читать по-английски. Kokoro не умеет кириллицу, Piper плохо читает английский,
// поэтому делим по алфавиту: английская фраза целиком — Kokoro; в русской фразе Kokoro достаются
// вставки от двух английских слов подряд, а одиночные слова (MacBook, Telegram) остаются Piper.
function splitLang(text) {
  const cyr = (text.match(/[А-Яа-яЁё]/g) || []).length;
  const lat = (text.match(/[A-Za-z]/g) || []).length;
  if (!lat) return [{ lang: 'ru', text }];
  if (!cyr) return [{ lang: 'en', text }];
  const enMain = lat >= cyr;
  const out = [];
  const pushRu = (t) => {
    t = t.replace(/^[\s,;:]+/, '');
    if (/[\p{L}\p{N}]/u.test(t)) out.push({ lang: 'ru', text: t.trim() });
    else if (out.length && t.trim()) out[out.length - 1].text += t.trim();
  };
  const re = /[A-Za-z][A-Za-z'’\-]*(?:[ \t]+[A-Za-z][A-Za-z'’\-]*)*/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (!enMain && m[0].trim().split(/\s+/).length < 2) continue;
    pushRu(text.slice(last, m.index));
    out.push({ lang: 'en', text: m[0] });
    last = m.index + m[0].length;
  }
  pushRu(text.slice(last));
  // середина фразы — с запятой, чтобы голос не «ставил точку»
  out.forEach((p, i) => { if (i < out.length - 1 && !/[.,!?;:…]$/.test(p.text)) p.text += ','; });
  return out.filter((p) => /[\p{L}\p{N}]/u.test(p.text));
}
const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, a.length)); };
let piperRms = 0.1;   // средняя громкость русского голоса — под неё подгоняем английский

let stats = null;  // диагностика последнего предложения
async function synthPiece(text) {
  const segs = splitLang(text);
  if (segs.length === 1 && segs[0].lang === 'ru') return piperSay(text);
  const parts = [];
  for (const sg of segs) {
    let a = null, en = false;
    if (sg.lang === 'en' && await kokoroReady()) {
      try { a = await kokoroSay(sg.text); en = true; } catch (e) { a = null; }
    }
    if (!a) a = await piperSay(sg.text);
    parts.push({ a, en });
  }
  // английский подгоняем по громкости под русский голос
  const ruParts = parts.filter((p) => !p.en && p.a.length);
  let sq = 0, nsq = 0;
  for (const p of ruParts) { for (let i = 0; i < p.a.length; i++) sq += p.a[i] * p.a[i]; nsq += p.a.length; }
  const target = nsq ? Math.sqrt(sq / nsq) : piperRms;
  const gap = Math.round(SAMPLE_RATE * 0.06);
  let len = 0;
  for (const p of parts) {
    if (p.en && p.a.length) {
      const r = rms(p.a);
      let g = r > 1e-4 ? Math.min(4, Math.max(0.3, target / r)) : 1;
      let peak = 0; for (let i = 0; i < p.a.length; i++) { const v = Math.abs(p.a[i] * g); if (v > peak) peak = v; }
      if (peak > 0.98) g *= 0.98 / peak;
      for (let i = 0; i < p.a.length; i++) p.a[i] *= g;
      let pk = 0; for (let i = 0; i < p.a.length; i++) { const v = Math.abs(p.a[i]); if (v > pk) pk = v; }
      stats.samples += p.a.length; if (pk > stats.peak) stats.peak = pk; stats.ids += 1;
    }
    len += p.a.length;
  }
  len += gap * (parts.length - 1);
  const all = new Float32Array(len);
  let o = 0;
  parts.forEach((p, i) => { all.set(p.a, o); o += p.a.length + (i < parts.length - 1 ? gap : 0); });
  return all;
}
async function piperSay(text) {
  const ids = await ruIds(text);
  if (!ids) throw new Error('движок произношения не ответил');
  if (ids.length < 3) return new Float32Array(0);
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([0.667, 1.0, 0.8]), [3]),
  };
  const out = await session.run(feeds);
  const a = out.output.data;
  // считаем «битые» значения и громкость — чтобы тишина не маскировалась под речь
  let nan = 0, peak = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v !== v || v === Infinity || v === -Infinity) { a[i] = 0; nan++; }
    else { const x = v < 0 ? -v : v; if (x > peak) peak = x; }
  }
  stats.ids += ids.length; stats.samples += a.length; stats.nan += nan; if (peak > stats.peak) stats.peak = peak;
  if (a.length > SAMPLE_RATE * 0.3) piperRms = piperRms * 0.8 + rms(a) * 0.2;
  return a;
}

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    let s = f32[i];
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Генерирует одно «предложение» (может состоять из нескольких кусков)
async function synthSentence(pieces) {
  stats = { ids: 0, samples: 0, nan: 0, peak: 0 };
  const gap = Math.round(SAMPLE_RATE * 0.12);
  const parts = [];
  let len = 0;
  for (let i = 0; i < pieces.length; i++) {
    const a = await synthPiece(pieces[i]);
    parts.push(a); len += a.length;
    if (i < pieces.length - 1) { parts.push(new Float32Array(gap)); len += gap; }
  }
  const all = new Float32Array(len);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return toInt16(all);
}

// Все задачи выполняем строго по очереди: ORT не любит параллельные run()
let chain = Promise.resolve();
onmessage = (e) => { chain = chain.then(() => handle(e.data)); };

async function handle(m) {
  try {
    if (m.type === 'init') {
      if (m.en) kk.want = m.en;
      ready = (async () => {
        await loadPhonemizer();
        await loadVoice(m.voice);
      })();
      await ready;
      postMessage({ type: 'ready', voice: m.voice });
    } else if (m.type === 'en') {
      kk.want = m.voice; kk.failed = false;
    } else if (m.type === 'reset') {
      kk.failed = false;
      if (phonBytes) phon = await makePhon();
    } else if (m.type === 'synth') {
      await ready;
      const t0 = performance.now();
      const pcm = await synthSentence(m.pieces);
      postMessage({ type: 'audio', id: m.id, pcm, ms: performance.now() - t0, stats }, [pcm.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
}
