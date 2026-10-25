// Вслух — стенд голосов. Движки Supertonic 3 и Kokoro (рус/англ), всё на устройстве.
// Приложение этот файл не использует; общие с ним только кэш тяжёлых файлов и eSpeak.
import createPiperPhonemize from './piper_phonemize.mjs';

const base = new URL('./', import.meta.url).href;
const SHARED_CACHE = 'vsluh-assets-v1';   // тот же, что у приложения: движок ORT и eSpeak
const LAB_CACHE = 'vsluh-lab-v1';         // модели стенда
const ORT_VER = '1.30.0';

let cfg = null;          // адреса моделей (присылает страница)
let ort = null;          // модуль onnxruntime-web
let backend = 'wasm';    // фактический: wasm | webgpu
let fallback = '';       // почему не WebGPU, если просили
let netBytes = 0, cacheBytes = 0;

const say = (text) => postMessage({ type: 'status', text });

/* ───────────── загрузка и кэш ───────────── */
async function openCache(name) { try { return await caches.open(name); } catch (e) { return null; } }

async function download(urls, label, sizeHint) {
  const parts = [];
  let got = 0, last = 0, total = sizeHint || 0;
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(url.split('/').pop() + ' (' + res.status + ')');
    if (!sizeHint) total += +res.headers.get('content-length') || 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      const now = Date.now();
      if (now - last > 200) { last = now; postMessage({ type: 'progress', label, got, total: Math.max(total, got) }); }
    }
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  postMessage({ type: 'progress', label, got, total: got });
  return buf;
}

// key — адрес, под которым файл лежит в кэше; variants — откуда качать (по очереди)
async function getAsset(key, label, variants, cacheName, sizeHint) {
  const cache = await openCache(cacheName || LAB_CACHE);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) { const b = await hit.arrayBuffer(); cacheBytes += b.byteLength; return b; }
  }
  let buf = null, err = null;
  for (const urls of variants || [[key]]) {
    try { buf = await download(urls, label, sizeHint); break; } catch (e) { err = e; }
  }
  if (!buf) throw new Error(label + ': не скачалось — ' + (err && err.message));
  netBytes += buf.byteLength;
  if (cache) { try { await cache.put(key, new Response(buf)); } catch (e) { /* нет места — живём без кэша */ } }
  return buf.buffer;
}

// Общие с приложением файлы: те же ключи кэша, тот же запасной вариант кусками *.partN
function shared(path, label, cdnUrl, parts, size) {
  const key = base + path;
  const variants = [];
  if (cdnUrl) variants.push([cdnUrl]);
  variants.push(parts ? Array.from({ length: parts }, (_, i) => key + '.part' + i) : [key]);
  return getAsset(key, label, variants, SHARED_CACHE, size);
}
const asJSON = (buf) => JSON.parse(new TextDecoder().decode(buf));

/* ───────────── onnxruntime: WASM или WebGPU ───────────── */
async function loadOrt(wantGpu) {
  const cdn = cfg.ortCdn;
  if (wantGpu) {
    try {
      if (!self.navigator || !navigator.gpu) throw new Error('в этом браузере нет WebGPU');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('WebGPU не выдал видеочип');
      say('Загружаю движок для видеочипа…');
      ort = await import(cdn + 'ort.webgpu.bundle.min.mjs');
      ort.env.wasm.wasmBinary = await shared('ort-wasm-simd-threaded.asyncify.wasm', 'Нейродвижок (WebGPU)',
        cdn + 'ort-wasm-simd-threaded.asyncify.wasm', 2, 26781914);
      backend = 'webgpu';
    } catch (e) {
      fallback = String(e && e.message || e);
      ort = null;
    }
  }
  if (!ort) {
    ort = await import('./ort.wasm.bundle.min.mjs');
    ort.env.wasm.wasmBinary = await shared('ort-wasm-simd-threaded.wasm', 'Нейродвижок',
      cdn + 'ort-wasm-simd-threaded.wasm', 2, 14239897);
    backend = 'wasm';
  }
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = base;
}

async function makeSession(bytes, label) {
  say('Запускаю: ' + label + '…');
  const wasmOpts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false };
  if (backend === 'webgpu') {
    try {
      return await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['webgpu', 'wasm'], graphOptimizationLevel: 'all' });
    } catch (e) {
      fallback = (fallback ? fallback + '; ' : '') + label + ' на WebGPU не запустился: ' + (e && e.message || e);
      backend = 'wasm';
    }
  }
  return ort.InferenceSession.create(new Uint8Array(bytes), wasmOpts);
}

/* ───────────── eSpeak: фонемы для Kokoro ─────────────
   Как в приложении: модуль живёт коротко и собирается заново каждые PHON_LIFE фраз,
   иначе JavaScriptCore на iPhone со временем роняет страницу. */
const PHON_LIFE = 20;
let phon = null, phonOut = null, phonBytes = null, phonData = null, phonDirty = false, phonUses = 0;
async function loadPhonemizer() {
  if (!phonBytes) {
    const [w, d] = await Promise.all([
      shared('piper_phonemize.wasm', 'Движок произношения'),
      shared('piper_phonemize.data', 'Словарь произношения',
        'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data', 2, 18077249),
    ]);
    phonBytes = w; phonData = d;
  }
  phon = await makePhon();
}
async function makePhon() {
  phonDirty = false; phonUses = 0; phon = null;
  const mod = await WebAssembly.compile(phonBytes);
  return createPiperPhonemize({
    noInitialRun: true,
    instantiateWasm: (imports, done) => { WebAssembly.instantiate(mod, imports).then((inst) => done(inst)); return {}; },
    getPreloadedPackage: () => phonData,
    print: (line) => { phonOut = line; },
    printErr: () => {},
    locateFile: (u) => base + u,
  });
}
function phonemesOnce(text, lang) {
  phonOut = null;
  try { phon.callMain(['-l', lang, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']); }
  catch (e) { phonDirty = true; }
  if (!phonOut) { phonDirty = true; return null; }
  try { return JSON.parse(phonOut).phonemes.join(''); } catch (e) { return null; }
}
async function phonemize(text, lang) {
  if (phonDirty || phonUses >= PHON_LIFE) phon = await makePhon();
  phonUses++;
  let p = phonemesOnce(text, lang);
  if (p == null) { phon = await makePhon(); p = phonemesOnce(text, lang); }
  if (p == null) throw new Error('движок произношения не ответил');
  return p.replace(/([.,!?;:—…])(?=[^\s.,!?;:—…])/g, '$1 ');   // eSpeak склеивает «слово?слово»
}

/* ───────────── общее ───────────── */
function gaussian(n) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u1 = Math.max(1e-4, Math.random()), u2 = Math.random();
    const r = Math.sqrt(-2 * Math.log(u1));
    a[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < n) a[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  return a;
}
function concat(chunks, sr, gapSec) {
  const gap = Math.round(sr * gapSec);
  let len = 0;
  chunks.forEach((c, i) => { len += c.length + (i ? gap : 0); });
  const out = new Float32Array(len);
  let o = 0;
  chunks.forEach((c, i) => { if (i) o += gap; out.set(c, o); o += c.length; });
  return out;
}
// длинный текст режем по предложениям (короткие фразы стенда идут целиком)
function splitLong(text, max) {
  if (text.length <= max) return [text];
  const sents = text.match(/[^.!?…]+(?:[.!?…]+["»”)]*|$)\s*/g) || [text];
  const out = [];
  let cur = '';
  for (const s of sents) {
    if (cur && cur.length + s.length > max) { out.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
// латиница внутри русского текста — отдельные куски
function scriptRuns(text) {
  const re = /[A-Za-z][A-Za-z0-9'’&\-]*(?:[ \t]+[A-Za-z][A-Za-z0-9'’&\-]*)*/g;
  const runs = [];
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ t: text.slice(last, m.index), lang: 'ru' });
    runs.push({ t: m[0], lang: 'en' });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ t: text.slice(last), lang: 'ru' });
  // хвосты без букв (запятые, точки) приклеиваем к предыдущему куску
  const merged = [];
  for (const r of runs) {
    if (merged.length && !/[\p{L}\p{N}]/u.test(r.t)) merged[merged.length - 1].t += r.t;
    else merged.push({ ...r });
  }
  return merged;
}

/* ───────────── Supertonic 3 ─────────────
   Повторяет официальный браузерный пример Supertone (MIT), только на типизированных массивах. */
const ST = {};
async function stInit(o) {
  const b = cfg.supertonic;
  ST.cfg = asJSON(await getAsset(b + 'onnx/tts.json', 'Настройки модели'));
  ST.indexer = asJSON(await getAsset(b + 'onnx/unicode_indexer.json', 'Алфавит модели'));
  ST.sr = ST.cfg.ae.sample_rate;
  const files = [
    ['dp', 'duration_predictor', 'длительности', 3.7e6],
    ['te', 'text_encoder', 'текст', 9.73e6],
    ['ve', 'vector_estimator', 'голос', 65.8e6],
    ['voc', 'vocoder', 'вокодер', 25.8e6],
  ];
  for (const [k, f, label, size] of files) {
    const bytes = await getAsset(b + 'onnx/' + f + '.onnx', 'Supertonic: ' + label, null, null, size);
    ST[k] = await makeSession(bytes, label);
  }
  const st = asJSON(await getAsset(b + 'voice_styles/' + o.voice + '.json', 'Голос ' + o.voice));
  const t = (x) => new ort.Tensor('float32', Float32Array.from(x.data.flat(Infinity)), x.dims);
  ST.ttl = t(st.style_ttl);
  ST.dpStyle = t(st.style_dp);
}
function stClean(text) {
  text = text.normalize('NFKD');
  text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '');
  const rep = { '–': '-', '‑': '-', '—': '-', '_': ' ', '\u201C': '"', '\u201D': '"', '\u2018': "'", '\u2019': "'", '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ' };
  for (const [k, v] of Object.entries(rep)) text = text.replaceAll(k, v);
  text = text.replace(/[♥☆♡©\\]/g, '');
  for (const [k, v] of Object.entries({ '@': ' at ', 'e.g.,': 'for example, ', 'i.e.,': 'that is, ' })) text = text.replaceAll(k, v);
  text = text.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!').replace(/ \?/g, '?').replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'");
  while (text.includes('""')) text = text.replace('""', '"');
  while (text.includes("''")) text = text.replace("''", "'");
  return text.replace(/\s+/g, ' ').trim();
}
const ST_END = /[.!?;:,'"')\]}…。」』】〉》›»]$/;
const stTag = (t, lang, end) => `<${lang}>${ST_END.test(t.trim()) ? t : t.replace(/\s*$/, end)}</${lang}>`;

async function stInfer(s, steps, speed) {
  const L = s.length;
  const ids = new BigInt64Array(L);
  let unk = 0;
  for (let j = 0; j < L; j++) {
    const cp = s.codePointAt(j);
    const v = cp < ST.indexer.length ? ST.indexer[cp] : -1;
    if (v < 0) unk++;
    ids[j] = BigInt(v);
  }
  const tIds = new ort.Tensor('int64', ids, [1, L]);
  const tMask = new ort.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);
  const dp = await ST.dp.run({ text_ids: tIds, style_dp: ST.dpStyle, text_mask: tMask });
  const dur = dp.duration.data[0] / speed;
  const te = await ST.te.run({ text_ids: tIds, style_ttl: ST.ttl, text_mask: tMask });
  const c = ST.cfg;
  const chunk = c.ae.base_chunk_size * c.ttl.chunk_compress_factor;
  const D = c.ttl.latent_dim * c.ttl.chunk_compress_factor;
  const wavLen = Math.max(0, Math.floor(dur * ST.sr));
  const T = Math.max(1, Math.floor((wavLen + chunk - 1) / chunk));
  let xt = gaussian(D * T);
  const lMask = new ort.Tensor('float32', new Float32Array(T).fill(1), [1, 1, T]);
  const total = new ort.Tensor('float32', Float32Array.of(steps), [1]);
  for (let k = 0; k < steps; k++) {
    const out = await ST.ve.run({
      noisy_latent: new ort.Tensor('float32', xt, [1, D, T]),
      text_emb: te.text_emb, style_ttl: ST.ttl, latent_mask: lMask, text_mask: tMask,
      current_step: new ort.Tensor('float32', Float32Array.of(k), [1]), total_step: total,
    });
    xt = Float32Array.from(out.denoised_latent.data);
  }
  const v = await ST.voc.run({ latent: new ort.Tensor('float32', xt, [1, D, T]) });
  const wav = v.wav_tts.data;
  return { wav: Float32Array.from(wav.subarray(0, Math.min(wav.length, wavLen || wav.length))), unk };
}

async function stSynth(text, lang, o) {
  const steps = o.steps || 8, speed = o.speed || 1.05;
  const chunks = [];
  let unk = 0, mode = lang === 'en' ? 'en' : 'ru';
  for (const piece of splitLong(stClean(text), 300)) {
    let parts;
    const runs = lang === 'en' ? [{ t: piece, lang: 'en' }] : scriptRuns(piece);
    if (runs.length < 2) parts = [stTag(piece, runs[0] ? runs[0].lang : 'ru', '.')];
    else if (o.mixed === 'split') {
      mode = 'склейка';
      parts = runs.map((r, i) => stTag(r.t.trim().replace(/^[,;:.\s—-]+/, ''), r.lang, i === runs.length - 1 ? '.' : ',')).filter((s) => /[\p{L}\p{N}]/u.test(s));
    } else {
      mode = 'теги';
      parts = [runs.map((r, i) => (i === runs.length - 1 ? stTag(r.t, r.lang, '.') : `<${r.lang}>${r.t}</${r.lang}>`)).join('')];
    }
    const sub = [];
    for (const s of parts) { const r = await stInfer(s, steps, speed); sub.push(r.wav); unk += r.unk; }
    chunks.push(concat(sub, ST.sr, 0.06));
  }
  return { pcm: concat(chunks, ST.sr, 0.3), sr: ST.sr, info: { unk, mode } };
}

/* ───────────── Kokoro ─────────────
   Модель понимает фонемы (МФА). Фонемы даёт тот же eSpeak, что у приложения.
   Русская модель — порт kokoro-ru (OpenRAIL), английская — Kokoro v1.0 (Apache-2.0). */
const KOKORO_VOCAB = {";":1,":":2,",":3,".":4,"!":5,"?":6,"—":9,"…":10,"\"":11,"(":12,")":13,"“":14,"”":15," ":16,"̃":17,"ʣ":18,"ʥ":19,"ʦ":20,"ʨ":21,"ᵝ":22,"ꭧ":23,"A":24,"I":25,"O":31,"Q":33,"S":35,"T":36,"W":39,"Y":41,"ᵊ":42,"a":43,"b":44,"c":45,"d":46,"e":47,"f":48,"h":50,"i":51,"j":52,"k":53,"l":54,"m":55,"n":56,"o":57,"p":58,"q":59,"r":60,"s":61,"t":62,"u":63,"v":64,"w":65,"x":66,"y":67,"z":68,"ɑ":69,"ɐ":70,"ɒ":71,"æ":72,"β":75,"ɔ":76,"ɕ":77,"ç":78,"ɖ":80,"ð":81,"ʤ":82,"ə":83,"ɚ":85,"ɛ":86,"ɜ":87,"ɟ":90,"ɡ":92,"ɥ":99,"ɨ":101,"ɪ":102,"ʝ":103,"ɯ":110,"ɰ":111,"ŋ":112,"ɳ":113,"ɲ":114,"ɴ":115,"ø":116,"ɸ":118,"θ":119,"œ":120,"ɹ":123,"ɾ":125,"ɻ":126,"ʁ":128,"ɽ":129,"ʂ":130,"ʃ":131,"ʈ":132,"ʧ":133,"ʊ":135,"ʋ":136,"ʌ":138,"ɣ":139,"ɤ":140,"χ":142,"ʎ":143,"ʒ":147,"ʔ":148,"ˈ":156,"ˌ":157,"ː":158,"ʰ":162,"ʲ":164,"↓":169,"→":171,"↗":172,"↘":173,"ᵻ":177};
const KK = {};
async function kkInit(o) {
  const ru = o.model === 'ru';
  const b = ru ? cfg.kokoroRu : cfg.kokoroEn;
  const gpu = backend === 'webgpu';
  const stem = ru && o.voice === 'dima' ? 'onnx/model_dima' : 'onnx/model';
  const file = stem + (gpu ? '_fp16' : '_quantized') + '.onnx';
  KK.lang = ru ? 'ru' : (o.voice[0] === 'b' ? 'en' : 'en-us');
  KK.american = !ru && o.voice[0] === 'a';
  KK.vocab = KOKORO_VOCAB;
  KK.vocabSrc = 'базовый Kokoro';
  if (ru) {
    try {
      const c = asJSON(await getAsset(b + 'config.json', 'Словарь фонем'));
      if (c && c.vocab && Object.keys(c.vocab).length) { KK.vocab = c.vocab; KK.vocabSrc = 'kokoro-ru'; }
    } catch (e) { /* остаёмся на базовом словаре */ }
  }
  await loadPhonemizer();
  const size = ru ? (gpu ? 164e6 : 138e6) : (gpu ? 163e6 : 92.4e6);
  const bytes = await getAsset(b + file, (ru ? 'Kokoro RU' : 'Kokoro EN') + ': модель', null, null, size);
  if (gpu) {
    // fp16-модель живёт только на видеочипе: без WebGPU сразу говорим об этом понятно
    say('Запускаю: Kokoro…');
    try { KK.sess = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' }); }
    catch (e) { throw new Error('Kokoro на видеочипе не запустился (' + (e && e.message || e) + ') — выберите «процессор»'); }
  } else KK.sess = await makeSession(bytes, 'Kokoro');
  KK.voice = new Float32Array(await getAsset(b + 'voices/' + o.voice + '.bin', 'Голос ' + o.voice));
}

// Английская нормализация и правка фонем — из kokoro-js (Apache-2.0)
function enSplitNum(e) {
  if (e.includes('.')) return e;
  if (e.includes(':')) { const [a, t] = e.split(':').map(Number); return t === 0 ? `${a} o'clock` : t < 10 ? `${a} oh ${t}` : `${a} ${t}`; }
  const a = parseInt(e.slice(0, 4), 10);
  if (a < 1100 || a % 1000 < 10) return e;
  const t = e.slice(0, 2), r = parseInt(e.slice(2, 4), 10), n = e.endsWith('s') ? 's' : '';
  if (a % 1000 >= 100 && a % 1000 <= 999) { if (r === 0) return `${t} hundred${n}`; if (r < 10) return `${t} oh ${r}${n}`; }
  return `${t} ${r}${n}`;
}
function enMoney(e) {
  const a = e[0] === '$' ? 'dollar' : 'pound';
  if (isNaN(Number(e.slice(1)))) return `${e.slice(1)} ${a}s`;
  if (!e.includes('.')) return `${e.slice(1)} ${a}${e.slice(1) === '1' ? '' : 's'}`;
  const [t, r] = e.slice(1).split('.'), n = parseInt(r.padEnd(2, '0'), 10);
  return `${t} ${a}${t === '1' ? '' : 's'} and ${n} ${e[0] === '$' ? (n === 1 ? 'cent' : 'cents') : (n === 1 ? 'penny' : 'pence')}`;
}
function enNormalize(e) {
  return e.replace(/[‘’]/g, "'").replace(/«/g, '“').replace(/»/g, '”').replace(/[“”]/g, '"')
    .replace(/[^\S \n]/g, ' ').replace(/  +/, ' ')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor').replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss').replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc').replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, enSplitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, enMoney)
    .replace(/\d*\.\d+/g, (m) => { const [a, t] = m.split('.'); return `${a} point ${t.split('').join(' ')}`; })
    .replace(/(?<=\d)-(?=\d)/g, ' to ').replace(/(?<=\d)S/g, ' S').replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's').replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-').trim();
}
function enFixPhonemes(s, american) {
  s = s.replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ').replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ').replace(/ʲ/g, 'j').replace(/r/g, 'ɹ')
    .replace(/x/g, 'k').replace(/ɬ/g, 'l').replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  return american ? s.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di') : s;
}
// символы eSpeak, которых может не быть в словаре модели
const KK_SUBST = { 'ɭ': 'l', 'ɫ': 'l', 'ʐ': 'ʒ', '͡': '', '‍': '' };

async function kkInfer(text, speed, dropped) {
  let ph = await phonemize(KK.lang === 'ru' ? text : enNormalize(text), KK.lang);
  if (KK.lang !== 'ru') ph = enFixPhonemes(ph, KK.american);
  const ids = [0];
  for (const ch of ph.trim()) {
    let id = KK.vocab[ch];
    if (id == null && KK_SUBST[ch] != null) {
      const sub = KK_SUBST[ch];
      id = sub ? KK.vocab[sub] : undefined;
      dropped[ch + '→' + (sub || '∅')] = (dropped[ch + '→' + (sub || '∅')] || 0) + 1;
      if (id == null) continue;
    } else if (id == null) { dropped[ch] = (dropped[ch] || 0) + 1; continue; }
    if (ids.length < 511) ids.push(id);
  }
  ids.push(0);
  const n = Math.min(Math.max(ids.length - 2, 0), 509);
  const style = KK.voice.slice(n * 256, n * 256 + 256);
  const out = await KK.sess.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    style: new ort.Tensor('float32', style, [1, 256]),
    speed: new ort.Tensor('float32', Float32Array.of(speed), [1]),
  });
  return { wav: Float32Array.from(out.waveform.data), ph };
}
async function kkSynth(text, lang, o) {
  const dropped = {};
  const chunks = [];
  let phs = [];
  for (const piece of splitLong(text, 250)) {
    const r = await kkInfer(piece, o.speed || 1, dropped);
    chunks.push(r.wav); phs.push(r.ph);
  }
  return { pcm: concat(chunks, 24000, 0.25), sr: 24000, info: { dropped, phonemes: phs.join(' | ').slice(0, 400), vocab: KK.vocabSrc } };
}

/* ───────────── сообщения ───────────── */
let engine = null, opts = null, ready = null;
let chain = Promise.resolve();
onmessage = (e) => { chain = chain.then(() => handle(e.data)); };

async function handle(m) {
  try {
    if (m.type === 'init') {
      cfg = m.cfg; engine = m.engine; opts = m.opts || {};
      const t0 = performance.now();
      ready = (async () => {
        await loadOrt(opts.backend === 'webgpu');
        if (engine === 'supertonic') await stInit(opts);
        else await kkInit(opts);
      })();
      await ready;
      postMessage({ type: 'ready', info: { backend, fallback, netBytes, cacheBytes, loadMs: performance.now() - t0, ort: ORT_VER } });
    } else if (m.type === 'synth') {
      await ready;
      const t0 = performance.now();
      const r = engine === 'supertonic' ? await stSynth(m.text, m.lang, { ...opts, ...m.opts }) : await kkSynth(m.text, m.lang, { ...opts, ...m.opts });
      postMessage({ type: 'audio', id: m.id, pcm: r.pcm, sr: r.sr, ms: performance.now() - t0, info: r.info }, [r.pcm.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
}
