// Вслух — фоновый синтез речи. Работает полностью офлайн:
// espeak-ng (фонемы) + Piper VITS (нейросеть) через onnxruntime-web.
import * as ort from './ort.wasm.bundle.min.mjs';
import createPiperPhonemize from './piper_phonemize.mjs';

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

// Движок произношения (eSpeak) живёт в маленькой фиксированной памяти и после некоторых
// фраз (латиница, эмодзи, редкие символы) может «сломаться». Поэтому держим его готовым
// к мгновенному перезапуску: скомпилированный модуль и словарь уже в памяти.
let phonModule = null, phonData = null, phonDirty = false;
async function loadPhonemizer() {
  if (phonModule) { if (!phon) phon = await makePhon(); return; }
  const [wasm, data] = await Promise.all([
    getAsset('piper_phonemize.wasm', 'Движок произношения'),
    getAsset('piper_phonemize.data', 'Словарь произношения'),
  ]);
  phonModule = await WebAssembly.compile(wasm);
  phonData = data;
  phon = await makePhon();
}
function makePhon() {
  phonDirty = false;
  return createPiperPhonemize({
    noInitialRun: true,
    instantiateWasm: (imports, done) => { WebAssembly.instantiate(phonModule, imports).then((inst) => done(inst)); return {}; },
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
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  voiceName = name;
}

function phonemizeOnce(text) {
  phonOut = null;
  try {
    phon.callMain(['-l', 'ru', '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
  } catch (e) { phonDirty = true; }
  if (!phonOut) { phonDirty = true; return null; }
  try { return JSON.parse(phonOut).phoneme_ids; } catch (e) { return null; }
}
const RISKY = /[^\u0400-\u04FF0-9\s.,!?;:()'\-]/;
async function phonemize(text) {
  if (phonDirty) phon = await makePhon();
  let ids = phonemizeOnce(text);
  if (!ids) {                       // перезапуск и вторая попытка
    phon = await makePhon();
    ids = phonemizeOnce(text);
  }
  if (!ids) {                       // третья: только кириллица и цифры
    phon = await makePhon();
    ids = phonemizeOnce(text.replace(/[^\u0400-\u04FF0-9\s.,!?;:\-]/g, ' ').replace(/\s+/g, ' ').trim() || '.');
  }
  if (RISKY.test(text)) phonDirty = true;   // латиница и т.п. — на всякий случай освежим движок
  return ids;
}

let stats = null;  // диагностика последнего предложения
async function synthPiece(text) {
  const ids = await phonemize(text);
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
      ready = (async () => {
        await loadPhonemizer();
        await loadVoice(m.voice);
      })();
      await ready;
      postMessage({ type: 'ready', voice: m.voice });
    } else if (m.type === 'reset') {
      if (phonModule) phon = await makePhon();
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
