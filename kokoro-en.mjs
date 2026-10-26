// Вслух — английский голос Kokoro v1.0 (Apache-2.0): текст → фонемы eSpeak → номера модели.
// Нормализация текста и правка фонем — из kokoro-js (Apache-2.0).
export const KOKORO_SR = 24000;
export const KOKORO_VOCAB = {";":1,":":2,",":3,".":4,"!":5,"?":6,"—":9,"…":10,"\"":11,"(":12,")":13,"“":14,"”":15," ":16,"̃":17,"ʣ":18,"ʥ":19,"ʦ":20,"ʨ":21,"ᵝ":22,"ꭧ":23,"A":24,"I":25,"O":31,"Q":33,"S":35,"T":36,"W":39,"Y":41,"ᵊ":42,"a":43,"b":44,"c":45,"d":46,"e":47,"f":48,"h":50,"i":51,"j":52,"k":53,"l":54,"m":55,"n":56,"o":57,"p":58,"q":59,"r":60,"s":61,"t":62,"u":63,"v":64,"w":65,"x":66,"y":67,"z":68,"ɑ":69,"ɐ":70,"ɒ":71,"æ":72,"β":75,"ɔ":76,"ɕ":77,"ç":78,"ɖ":80,"ð":81,"ʤ":82,"ə":83,"ɚ":85,"ɛ":86,"ɜ":87,"ɟ":90,"ɡ":92,"ɥ":99,"ɨ":101,"ɪ":102,"ʝ":103,"ɯ":110,"ɰ":111,"ŋ":112,"ɳ":113,"ɲ":114,"ɴ":115,"ø":116,"ɸ":118,"θ":119,"œ":120,"ɹ":123,"ɾ":125,"ɻ":126,"ʁ":128,"ɽ":129,"ʂ":130,"ʃ":131,"ʈ":132,"ʧ":133,"ʊ":135,"ʋ":136,"ʌ":138,"ɣ":139,"ɤ":140,"χ":142,"ʎ":143,"ʒ":147,"ʔ":148,"ˈ":156,"ˌ":157,"ː":158,"ʰ":162,"ʲ":164,"↓":169,"→":171,"↗":172,"↘":173,"ᵻ":177};
export const EN_VOICES = [
  ['af_heart', 'Heart', 'американский, женский'],
  ['am_michael', 'Michael', 'американский, мужской'],
  ['bf_emma', 'Emma', 'британский, женский'],
  ['bm_george', 'George', 'британский, мужской'],
  ['af_bella', 'Bella', 'американский, женский'],
];
// голос по умолчанию — того же пола, что русский
export const enVoiceFor = (ruVoice) => (ruVoice === 'irina' ? 'af_heart' : 'am_michael');

function splitNum(e) {
  if (e.includes('.')) return e;
  if (e.includes(':')) { const [a, t] = e.split(':').map(Number); return t === 0 ? `${a} o'clock` : t < 10 ? `${a} oh ${t}` : `${a} ${t}`; }
  const a = parseInt(e.slice(0, 4), 10);
  if (a < 1100 || a % 1000 < 10) return e;
  const t = e.slice(0, 2), r = parseInt(e.slice(2, 4), 10), n = e.endsWith('s') ? 's' : '';
  if (a % 1000 >= 100 && a % 1000 <= 999) { if (r === 0) return `${t} hundred${n}`; if (r < 10) return `${t} oh ${r}${n}`; }
  return `${t} ${r}${n}`;
}
function money(e) {
  const a = e[0] === '$' ? 'dollar' : 'pound';
  if (isNaN(Number(e.slice(1)))) return `${e.slice(1)} ${a}s`;
  if (!e.includes('.')) return `${e.slice(1)} ${a}${e.slice(1) === '1' ? '' : 's'}`;
  const [t, r] = e.slice(1).split('.'), n = parseInt(r.padEnd(2, '0'), 10);
  return `${t} ${a}${t === '1' ? '' : 's'} and ${n} ${e[0] === '$' ? (n === 1 ? 'cent' : 'cents') : (n === 1 ? 'penny' : 'pence')}`;
}
export function enNormalize(e) {
  return e.replace(/[‘’]/g, "'").replace(/«/g, '“').replace(/»/g, '”').replace(/[“”]/g, '"')
    .replace(/[^\S \n]/g, ' ').replace(/  +/, ' ')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor').replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss').replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc').replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, money)
    .replace(/\d*\.\d+/g, (m) => { const [a, t] = m.split('.'); return `${a} point ${t.split('').join(' ')}`; })
    .replace(/(?<=\d)-(?=\d)/g, ' to ').replace(/(?<=\d)S/g, ' S').replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's').replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-').trim();
}
export function enFixPhonemes(s, american) {
  s = s.replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ').replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ').replace(/ʲ/g, 'j').replace(/r/g, 'ɹ')
    .replace(/x/g, 'k').replace(/ɬ/g, 'l').replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z')
    .replace(/([.,!?;:—…])(?=[^\s.,!?;:—…])/g, '$1 ');
  return american ? s.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di') : s;
}
// фонемы → номера модели (с паузами по краям), не длиннее 510
export function kokoroIds(ph) {
  const ids = [0];
  for (const ch of ph.trim()) { const id = KOKORO_VOCAB[ch]; if (id != null && ids.length < 511) ids.push(id); }
  ids.push(0);
  return ids;
}
// 24 кГц → 22,05 кГц (как у Piper): окно Ланцоша, без заметных призвуков на речи
export function resample(x, from, to) {
  if (from === to) return x;
  const ratio = from / to, n = Math.floor(x.length / ratio), out = new Float32Array(n);
  const A = 6, cut = Math.min(1, to / from);
  for (let i = 0; i < n; i++) {
    const c = i * ratio, c0 = Math.floor(c);
    let s = 0, w = 0;
    for (let k = c0 - A + 1; k <= c0 + A; k++) {
      if (k < 0 || k >= x.length) continue;
      const d = (c - k) * cut;
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const win = Math.abs(c - k) < A ? Math.sin(Math.PI * (c - k) / A) / (Math.PI * (c - k) / A || 1) : 0;
      const g = sinc * (c === k ? 1 : win);
      s += x[k] * g; w += g;
    }
    out[i] = w ? s / w : 0;
  }
  return out;
}
