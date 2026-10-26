// Вслух — ударение на нужный слог для Piper.
// eSpeak не принимает ударения из текста, поэтому: ударную гласную подменяем на «ё»
// (после твёрдой согласной — на «ъё»), eSpeak сам ставит ударение и редуцирует
// остальные гласные, а мы возвращаем на место нужную гласную. Проверено на 20 000
// частых словах: 99% совпадают с собственным выводом eSpeak, ненадёжные — пропускаются.
export const ACUTE = '\u0301';
const VOW = 'аеёиоуыэюя';
const HARD = { 'а': 'ɑ', 'о': 'o', 'у': 'u', 'ы': 'y', 'э': 'ɛ' };
const PV = new Set([...'aɑʌəeɛiɪyɨoɵɔuʊæɐ']);

// фонема → номер у голосов Piper (DEFAULT_PHONEME_ID_MAP из piper-phonemize, MIT)
export const PIPER_IDS = {"_":0,"^":1,"$":2," ":3,"!":4,"'":5,"(":6,")":7,",":8,"-":9,".":10,":":11,";":12,"?":13,"a":14,"b":15,"c":16,"d":17,"e":18,"f":19,"h":20,"i":21,"j":22,"k":23,"l":24,"m":25,"n":26,"o":27,"p":28,"q":29,"r":30,"s":31,"t":32,"u":33,"v":34,"w":35,"x":36,"y":37,"z":38,"æ":39,"ç":40,"ð":41,"ø":42,"ħ":43,"ŋ":44,"œ":45,"ǀ":46,"ǁ":47,"ǂ":48,"ǃ":49,"ɐ":50,"ɑ":51,"ɒ":52,"ɓ":53,"ɔ":54,"ɕ":55,"ɖ":56,"ɗ":57,"ɘ":58,"ə":59,"ɚ":60,"ɛ":61,"ɜ":62,"ɞ":63,"ɟ":64,"ɠ":65,"ɡ":66,"ɢ":67,"ɣ":68,"ɤ":69,"ɥ":70,"ɦ":71,"ɧ":72,"ɨ":73,"ɪ":74,"ɫ":75,"ɬ":76,"ɭ":77,"ɮ":78,"ɯ":79,"ɰ":80,"ɱ":81,"ɲ":82,"ɳ":83,"ɴ":84,"ɵ":85,"ɶ":86,"ɸ":87,"ɹ":88,"ɺ":89,"ɻ":90,"ɽ":91,"ɾ":92,"ʀ":93,"ʁ":94,"ʂ":95,"ʃ":96,"ʄ":97,"ʈ":98,"ʉ":99,"ʊ":100,"ʋ":101,"ʌ":102,"ʍ":103,"ʎ":104,"ʏ":105,"ʐ":106,"ʑ":107,"ʒ":108,"ʔ":109,"ʕ":110,"ʘ":111,"ʙ":112,"ʛ":113,"ʜ":114,"ʝ":115,"ʟ":116,"ʡ":117,"ʢ":118,"ʲ":119,"ˈ":120,"ˌ":121,"ː":122,"ˑ":123,"˞":124,"β":125,"θ":126,"χ":127,"ᵻ":128,"ⱱ":129,"0":130,"1":131,"2":132,"3":133,"4":134,"5":135,"6":136,"7":137,"8":138,"9":139,"ʰ":145,"ˤ":146,"ε":147,"↓":148,"#":149,"\"":150,"↑":151,"g":154,"ʦ":155,"X":156};

export function trickSpelling(w, s) {
  const vp = [];
  for (let i = 0; i < w.length; i++) if (VOW.includes(w[i])) vp.push(i);
  if (s < 0 || s >= vp.length) return null;
  const pos = vp[s], L = w[pos], prev = pos ? w[pos - 1] : '';
  const ctx = !prev ? 'START' : VOW.includes(prev) ? 'VOW' : 'ьъ'.includes(prev) ? 'SIGN' : 'шжц'.includes(prev) ? 'SIBH' : 'чщй'.includes(prev) ? 'SOFTC' : 'C';
  if (L === 'ё') return { spell: w, L, ctx };
  const spell = w.slice(0, pos) + (HARD[L] && ctx === 'C' ? 'ъё' : 'ё') + w.slice(pos + 1);
  return { spell, L, ctx, final: pos === w.length - 1 };
}

function fixPhon(p1, t) {
  if (t.L === 'ё') return p1;
  const a = [...p1];
  const k = a.indexOf('ˈ');
  if (k < 0) return null;
  let v = -1;
  for (let i = k + 1; i < a.length && i < k + 4; i++) if (a[i] === 'o' || a[i] === 'ɵ') { v = i; break; }
  if (v < 0) return null;
  const { L, ctx } = t;
  const jAfter = a[k + 1] === 'j', jBefore = a[k - 1] === 'j';
  const dropJ = () => { if (jAfter) { a.splice(k + 1, 1); v--; } else if (jBefore && (ctx === 'C' || ctx === 'START')) { a.splice(k - 1, 1); v--; } };
  let vow;
  if (HARD[L]) { dropJ(); vow = HARD[L]; }
  else if (L === 'и') { dropJ(); vow = ctx === 'SIBH' ? 'y' : ctx === 'START' || t.final ? 'ɪ' : 'i'; }
  else if (L === 'е') {
    vow = ctx === 'SIBH' ? 'ɛ' : 'e';
    if (ctx === 'VOW' || ctx === 'SIGN') { a.splice(k, 0, 'j'); v++; }
  } else {
    vow = L === 'я' ? (ctx === 'C' || ctx === 'SOFTC' ? 'ɑ' : 'a') : (ctx === 'C' || ctx === 'SOFTC' ? 'u"' : 'u');
    if (ctx === 'START') { if (jBefore) { a.splice(k - 1, 1); v--; } a.splice(a.indexOf('ˈ') + 1, 0, 'j'); v++; }
    else if (ctx === 'VOW' || ctx === 'SIGN') { a.splice(k + 1, 0, 'j'); v++; }
  }
  a.splice(v, 1, vow);
  return a.join('');
}
const skeleton = (p) => [...p].filter((c) => !PV.has(c) && !'jʲˈˌ"^ '.includes(c)).join('');

// p0 — фонемы слова как есть, p1 — фонемы подменённого; null, если подмена ненадёжна
export function stressed(p0, p1, t) {
  const f = p1 ? fixPhon(p1, t) : null;
  if (!f || skeleton(f) !== skeleton(p0)) return null;
  return f;
}

// фонемы → номера Piper с паузами-разделителями (как делает piper-phonemize)
export function idsOf(ph) {
  const out = [];
  for (const ch of ph) { const id = PIPER_IDS[ch]; if (id != null) out.push(id, 0); }
  return out;
}

// слова фразы по порядку: { w: 'замок', s: 0 } (s = -1 — ударение не задано)
export function wordTokens(text) {
  const out = [];
  for (const m of text.matchAll(/[А-Яа-яЁё\u0301]+/g)) {
    const lw = m[0].toLowerCase();
    let s = -1, n = -1;
    for (let i = 0; i < lw.length; i++) {
      if (VOW.includes(lw[i])) n++;
      if (lw[i] === ACUTE) { s = n; break; }
    }
    out.push({ w: lw.replace(/\u0301/g, ''), s });
  }
  return out;
}

// где в номерах фразы стоит слово целиком (вокруг пробел, знак или край)
const EDGE = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
export function findWord(ids, from) {
  const pos = [];
  if (!from.length) return pos;
  for (let i = 2; i + from.length < ids.length + 1; i++) {
    if (!(EDGE.has(ids[i - 2]) && ids[i - 1] === 0)) continue;
    let ok = true;
    for (let j = 0; j < from.length; j++) if (ids[i + j] !== from[j]) { ok = false; break; }
    if (ok && EDGE.has(ids[i + from.length])) { pos.push(i); i += from.length - 1; }
  }
  return pos;
}
// заменить слово в указанных местах (места — по возрастанию)
export function replaceAt(ids, places, len) {
  if (!places.length) return ids;
  const out = [];
  let i = 0;
  for (const { at, to } of places) { out.push(...ids.slice(i, at), ...to); i = at + len; }
  out.push(...ids.slice(i));
  return out;
}
