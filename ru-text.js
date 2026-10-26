// Вслух — подготовка русского текста к озвучке (до eSpeak):
// буква ё по словарю, сокращения, годы/века/даты с правильным падежом, «все → всё»
// в устойчивых оборотах и личный словарь ударений (долгое нажатие на слово).
// Ударение помечается знаком U+0301 после ударной гласной — его понимает воркер озвучки.
(function () {
  'use strict';
  const ACUTE = '\u0301';
  const VOW = 'аеёиоуыэюя';
  const L = '\\p{L}';
  const NOT_BEFORE = `(?<![${L}\\p{N}])`, NOT_AFTER = `(?![${L}\\p{N}])`;

  /* ───────────── числа ───────────── */
  const UNITS = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const UNITS_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
  const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
  const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
  // основы порядковых: [основа, тип окончания] (ой — ударное окончание в им. п. м. р.)
  const O_UNITS = [null, ['перв', 'ый'], ['втор', 'ой'], ['трет', 'ий'], ['четвёрт', 'ый'], ['пят', 'ый'], ['шест', 'ой'], ['седьм', 'ой'], ['восьм', 'ой'], ['девят', 'ый']];
  const O_TEENS = ['десят', 'одиннадцат', 'двенадцат', 'тринадцат', 'четырнадцат', 'пятнадцат', 'шестнадцат', 'семнадцат', 'восемнадцат', 'девятнадцат'].map((s) => [s, 'ый']);
  const O_TENS = [null, null, ['двадцат', 'ый'], ['тридцат', 'ый'], ['сороков', 'ой'], ['пятидесят', 'ый'], ['шестидесят', 'ый'], ['семидесят', 'ый'], ['восьмидесят', 'ый'], ['девяност', 'ый']];
  const O_HUNDREDS = [null, 'сот', 'двухсот', 'трёхсот', 'четырёхсот', 'пятисот', 'шестисот', 'семисот', 'восьмисот', 'девятисот'].map((s) => s && [s, 'ый']);
  const GEN_PREFIX = ['', '', 'двух', 'трёх', 'четырёх', 'пяти', 'шести', 'семи', 'восьми', 'девяти'];
  const END = {
    m_nom: 'ый', m_gen: 'ого', m_dat: 'ому', m_prep: 'ом', m_ins: 'ым',
    f_nom: 'ая', f_gen: 'ой', f_acc: 'ую', f_ins: 'ой',
    n_nom: 'ое', n_gen: 'ого', n_dat: 'ому',
    pl_nom: 'ые', pl_gen: 'ых', pl_dat: 'ым', pl_ins: 'ыми', pl_prep: 'ых',
  };
  const END_TRET = {
    m_nom: 'ий', m_gen: 'ьего', m_dat: 'ьему', m_prep: 'ьем', m_ins: 'ьим',
    f_nom: 'ья', f_gen: 'ьей', f_acc: 'ью', f_ins: 'ьей',
    n_nom: 'ье', n_gen: 'ьего', n_dat: 'ьему',
    pl_nom: 'ьи', pl_gen: 'ьих', pl_dat: 'ьим', pl_ins: 'ьими', pl_prep: 'ьих',
  };
  function ordWord([stem, type], form) {
    if (type === 'ий') return stem + END_TRET[form];
    if (form === 'm_nom') return stem + type;
    return stem + END[form];
  }
  function cardinal999(n, fem) {
    const out = [];
    const h = Math.floor(n / 100), r = n % 100, t = Math.floor(r / 10), u = r % 10;
    if (h) out.push(HUNDREDS[h]);
    if (r >= 10 && r < 20) out.push(TEENS[r - 10]);
    else { if (t) out.push(TENS[t]); if (u) out.push((fem ? UNITS_F : UNITS)[u]); }
    return out;
  }
  function thousandsWord(k) {
    const r = k % 100, u = k % 10;
    if (r >= 11 && r <= 14) return 'тысяч';
    if (u === 1) return 'тысяча';
    if (u >= 2 && u <= 4) return 'тысячи';
    return 'тысяч';
  }
  // порядковое число (1…999 999) в нужной форме: 1984 → «тысяча девятьсот восемьдесят четвёртый»
  function ordinal(n, form) {
    if (!(n >= 1 && n < 1e6)) return null;
    const k = Math.floor(n / 1000), rest = n % 1000;
    const words = [];
    if (!rest) {   // ровные тысячи: двухтысячный
      const pre = k === 1 ? '' : k < 10 ? GEN_PREFIX[k] : null;
      if (pre == null) return null;
      return ordWord([pre + 'тысячн', 'ый'], form);
    }
    if (k) { if (k === 1) words.push('тысяча'); else words.push(...cardinal999(k, true), thousandsWord(k)); }
    const h = Math.floor(rest / 100), r = rest % 100, t = Math.floor(r / 10), u = r % 10;
    if (!r) { words.push(ordWord(O_HUNDREDS[h], form)); return words.join(' '); }
    if (h) words.push(HUNDREDS[h]);
    if (r >= 10 && r < 20) words.push(ordWord(O_TEENS[r - 10], form));
    else if (!u) words.push(ordWord(O_TENS[t], form));
    else { if (t) words.push(TENS[t]); words.push(ordWord(O_UNITS[u], form)); }
    return words.join(' ');
  }
  const ROM = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  function roman(s) { let n = 0; for (let i = 0; i < s.length; i++) { const a = ROM[s[i]], b = ROM[s[i + 1]] || 0; if (!a) return 0; n += a < b ? -a : a; } return n; }

  // падеж по предлогу перед числом
  const PREP_PREP = new Set(['в', 'во', 'о', 'об', 'обо', 'при']);
  const PREP_GEN = new Set(['до', 'с', 'со', 'от', 'после', 'около', 'из', 'без', 'для', 'у', 'кроме', 'вокруг', 'против', 'среди', 'начиная', 'посреди', 'накануне', 'вплоть']);
  const PREP_DAT = new Set(['к', 'ко', 'благодаря', 'навстречу']);
  const PREP_INS = new Set(['с', 'со', 'за', 'под', 'над', 'перед', 'между']);
  const caseByPrep = (pre) => { const p = (pre || '').toLowerCase(); return PREP_PREP.has(p) ? 'prep' : PREP_GEN.has(p) ? 'gen' : PREP_DAT.has(p) ? 'dat' : 'nom'; };
  const YEAR_NOUN = { prep: 'году', gen: 'года', dat: 'году', nom: 'год' };
  const CENT_NOUN = { prep: 'веке', gen: 'века', dat: 'веку', nom: 'век' };
  const NOUN_CASE = { году: null, года: 'gen', годом: 'ins', год: 'nom', веке: 'prep', века: 'gen', веку: 'dat', веком: 'ins', век: 'nom' };
  const FORM = { nom: 'm_nom', gen: 'm_gen', dat: 'm_dat', prep: 'm_prep', ins: 'm_ins' };
  const pre = (p) => (p ? p + ' ' : '');

  const RE_YEAR = new RegExp(`${NOT_BEFORE}(?:([${L}]+)\\s+)?(\\d{3,4})(?:\\s*-?(?:м|й|го|му|ом))?\\s+(году|года|годом|год|г\\.)(?![${L}])`, 'gu');
  const RE_CENT = new RegExp(`${NOT_BEFORE}(?:([${L}]+)\\s+)?([IVXLC]{1,6})\\s+(веке|века|веку|веком|век|в\\.)(?![${L}])`, 'gu');
  const MONTHS = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';
  const RE_DATE = new RegExp(`${NOT_BEFORE}(?:([${L}]+)\\s+)?([1-9]|[12]\\d|3[01])\\s+(${MONTHS})(?![${L}])`, 'gu');
  const RE_ORD = new RegExp(`${NOT_BEFORE}(?:([${L}]+)\\s+)?(\\d{1,5})-(ого|ому|ыми|ые|ых|ым|ом|ая|ое|ую|ый|ий|ой|го|му|ми|й|я|е|м|х|ю)(?![${L}])(\\s+год(?:ы|ов|ах|ам)?)?`, 'gu');
  const DATE_NOM = new Set(['сегодня', 'завтра', 'вчера', 'было', 'наступило', 'наступает', 'настало', 'будет']);

  function numbers(t) {
    t = t.replace(RE_YEAR, (m, p, num, noun) => {
      const n = +num;
      let c = NOUN_CASE[noun];
      if (noun === 'году') c = PREP_DAT.has((p || '').toLowerCase()) ? 'dat' : 'prep';
      if (noun === 'г.') { c = caseByPrep(p); noun = YEAR_NOUN[c]; }
      const w = ordinal(n, FORM[c]);
      return w ? pre(p) + w + ' ' + noun : m;
    });
    t = t.replace(RE_CENT, (m, p, rom, noun) => {
      const n = roman(rom);
      if (!n || n > 39) return m;
      let c = NOUN_CASE[noun];
      if (noun === 'в.') { c = caseByPrep(p); noun = CENT_NOUN[c]; }
      const w = ordinal(n, FORM[c]);
      return w ? pre(p) + w + ' ' + noun : m;
    });
    t = t.replace(RE_DATE, (m, p, d, mon) => {
      const lp = (p || '').toLowerCase();
      const form = PREP_DAT.has(lp) ? 'n_dat' : DATE_NOM.has(lp) ? 'n_nom' : 'n_gen';
      return pre(p) + ordinal(+d, form) + ' ' + mon;
    });
    t = t.replace(RE_ORD, (m, p, num, suf, years) => {
      const lp = (p || '').toLowerCase();
      let form;
      if (/^(ый|ий|ой|й)$/.test(suf)) form = 'm_nom';
      else if (/^(ая|я)$/.test(suf)) form = 'f_nom';
      else if (/^(ое|е)$/.test(suf)) form = years ? 'pl_nom' : 'n_nom';
      else if (suf === 'ые') form = 'pl_nom';
      else if (/^(ого|го)$/.test(suf)) form = 'm_gen';
      else if (/^(ому|му)$/.test(suf)) form = 'm_dat';
      else if (/^(ом|ым|м)$/.test(suf)) form = PREP_INS.has(lp) ? 'm_ins' : 'm_prep';
      else if (/^(ых|х)$/.test(suf)) form = 'pl_gen';
      else if (/^(ыми|ми)$/.test(suf)) form = 'pl_ins';
      else if (/^(ую|ю)$/.test(suf)) form = 'f_acc';
      const w = form && ordinal(+num, form);
      return w ? pre(p) + w + (years || '') : m;
    });
    return t;
  }

  /* ───────────── сокращения ───────────── */
  const NB = `(?<![${L}])`;
  const ABBR = [
    [new RegExp(`${NB}([Тт])\\.\\s?е\\.`, 'gu'), (m, a) => (a === 'Т' ? 'То' : 'то') + ' есть'],
    [new RegExp(`${NB}([Ии])\\s+т\\.\\s?д\\.`, 'gu'), (m, a) => a + ' так далее'],
    [new RegExp(`${NB}([Ии])\\s+т\\.\\s?п\\.`, 'gu'), (m, a) => a + ' тому подобное'],
    [new RegExp(`${NB}([Тт])\\.\\s?к\\.`, 'gu'), (m, a) => (a === 'Т' ? 'Так' : 'так') + ' как'],
    [new RegExp(`${NB}([Тт])\\.\\s?н\\.`, 'gu'), (m, a) => (a === 'Т' ? 'Так' : 'так') + ' называемый'],
    [new RegExp(`${NB}([Вв])\\s+т\\.\\s?ч\\.`, 'gu'), (m, a) => a + ' том числе'],
    [new RegExp(`${NB}([Ии])\\s+др\\.`, 'gu'), (m, a) => a + ' другие'],
    [new RegExp(`${NB}([Ии])\\s+пр\\.`, 'gu'), (m, a) => a + ' прочее'],
    [new RegExp(`${NB}([Сс])м\\.(?=\\s)`, 'gu'), (m, a) => (a === 'С' ? 'С' : 'с') + 'мотри'],
    [new RegExp(`${NB}([Нн])апр\\.`, 'gu'), (m, a) => (a === 'Н' ? 'Н' : 'н') + 'апример'],
    [new RegExp(`${NB}([Гг])-н(?![${L}])`, 'gu'), (m, a) => (a === 'Г' ? 'Г' : 'г') + 'осподин'],
    [new RegExp(`${NB}([Гг])-на(?![${L}])`, 'gu'), (m, a) => (a === 'Г' ? 'Г' : 'г') + 'осподина'],
    [new RegExp(`${NB}([Гг])-ну(?![${L}])`, 'gu'), (m, a) => (a === 'Г' ? 'Г' : 'г') + 'осподину'],
    [new RegExp(`${NB}([Гг])-жа(?![${L}])`, 'gu'), (m, a) => (a === 'Г' ? 'Г' : 'г') + 'оспожа'],
    [/(\d+)\s?руб\./gu, (m, n) => n + ' ' + plural(n, 'рубль', 'рубля', 'рублей')],
    [/(\d+)\s?коп\./gu, (m, n) => n + ' ' + plural(n, 'копейка', 'копейки', 'копеек')],
    [/(\d+)\s?тыс\./gu, (m, n) => n + ' ' + plural(n, 'тысяча', 'тысячи', 'тысяч')],
    [/(\d+)\s?млн\.?(?![\p{L}])/gu, (m, n) => n + ' ' + plural(n, 'миллион', 'миллиона', 'миллионов')],
    [/(\d+)\s?млрд\.?(?![\p{L}])/gu, (m, n) => n + ' ' + plural(n, 'миллиард', 'миллиарда', 'миллиардов')],
  ];
  function plural(n, one, few, many) {
    const r = +n % 100, u = +n % 10;
    if (r >= 11 && r <= 14) return many;
    return u === 1 ? one : u >= 2 && u <= 4 ? few : many;
  }
  function abbreviations(t) { for (const [re, to] of ABBR) t = t.replace(re, to); return t; }

  /* ───────────── буква ё ─────────────
     Словарь — «безопасный» список проекта eyo (MIT): формы, где е → ё без вариантов. */
  let YO = null;           // «еще» → «ещё»
  function loadYo(text) {
    const map = new Map();
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s || s[0] === '#') continue;
      const m = s.match(/^([^(]+)(?:\(([^)]*)\))?(.*)$/);
      if (!m) continue;
      const sufs = m[2] != null ? m[2].split('|') : [''];
      for (const suf of sufs) {
        const w = (m[1] + suf + (m[3] || '')).toLowerCase();
        if (w.includes('ё')) map.set(w.replace(/ё/g, 'е'), w);
      }
    }
    YO = map;
    return map.size;
  }
  function keepCase(src, form) {
    if (src.length > 1 && src === src.toUpperCase() && src !== src.toLowerCase()) return form.toUpperCase();
    if (src[0] !== src[0].toLowerCase()) return form[0].toUpperCase() + form.slice(1);
    return form;
  }
  // буквы ё из словаря подставляем в исходное слово, не трогая регистр
  function withYo(word, form) {
    let out = '';
    for (let i = 0; i < word.length; i++) {
      const c = word[i];
      if (form[i] === 'ё' && (c === 'е' || c === 'Е')) out += c === 'Е' ? 'Ё' : 'ё';
      else out += c;
    }
    return out;
  }
  // устойчивые обороты, где «все» — это «всё»
  const VSE_AFTER = 'равно|ещё|еще|же|время|так|то|это|больше|меньше|лучше|хуже|сильнее|чаще|реже|дальше|ближе|выше|ниже|громче|тише|быстрее|медленнее|хорошо|плохо|нормально|понятно|ясно|кончено|готово|правильно|сразу|позади|впереди|прошло|было|будет|в\\s+порядке';
  const RE_VSE = new RegExp(`${NB}([Вв])се(?=,?\\s+(?:${VSE_AFTER}|что)(?![${L}]))`, 'gu');
  const RE_VSE_TAKI = new RegExp(`${NB}([Вв])се-таки`, 'gu');
  // «все понял», «все было», «все знает» — глагол в единственном числе: значит «всё»
  // (на -ла не смотрим: «все дела», «все тела» — это «все»)
  const RE_VSE_VERB = new RegExp(`${NB}([Вв])се(?=\\s+[а-яё]{2,}(?:л|ло|ет|ёт|ит)(?![${L}]))`, 'gu');
  const RE_EE = new RegExp(`${NB}([Ее])е(?![${L}])`, 'gu');
  function yo(t) {
    t = t.replace(RE_VSE, '$1сё').replace(RE_VSE_TAKI, '$1сё-таки').replace(RE_VSE_VERB, '$1сё').replace(RE_EE, (m, a) => a + 'ё');
    if (!YO) return t;
    return t.replace(/[А-Яа-яЁё]+/g, (w) => {
      const lw = w.toLowerCase();
      if (!lw.includes('е')) return w;
      const f = YO.get(lw);
      return f ? withYo(w, f) : w;
    });
  }

  /* ───────────── личный словарь ударений ─────────────
     ключ — слово строчными, «ё» → «е»; значение — форма со знаком ударения или с «ё» */
  let USER = new Map();
  const keyOf = (w) => w.toLowerCase().replace(/ё/g, 'е').replace(/\u0301/g, '');
  function loadUser(obj) { USER = new Map(Object.entries(obj || {})); }
  function userObj() { return Object.fromEntries(USER); }
  // форма слова с ударением на гласную номер s (0…); yo — превратить ударную «е» в «ё»
  function stressForm(word, s, yoFlag) {
    const w = word.toLowerCase().replace(/\u0301/g, '');
    let n = -1;
    for (let i = 0; i < w.length; i++) {
      if (!VOW.includes(w[i])) continue;
      n++;
      if (n !== s) continue;
      if (yoFlag && (w[i] === 'е' || w[i] === 'ё')) return w.slice(0, i) + 'ё' + w.slice(i + 1).replace(/ё/g, 'е');
      const base = w.replace(/ё/g, 'е');
      return base.slice(0, i + 1) + ACUTE + base.slice(i + 1);
    }
    return null;
  }
  function setStress(word, s, yoFlag) { const f = stressForm(word, s, yoFlag); if (f) USER.set(keyOf(word), f); return f; }
  function clearStress(word) { return USER.delete(keyOf(word)); }
  function userForm(word) { return USER.get(keyOf(word)) || null; }
  // номер ударной гласной в форме из словаря (для показа в листе)
  function stressIndexOf(form) {
    let n = -1;
    for (let i = 0; i < form.length; i++) {
      if (VOW.includes(form[i])) n++;
      if (form[i] === 'ё' || form[i + 1] === ACUTE) return n;
    }
    return -1;
  }
  function applyUser(t) {
    if (!USER.size) return t;
    return t.replace(/[А-Яа-яЁё\u0301]+(?:-[А-Яа-яЁё\u0301]+)*/g, (w) => {
      const f = USER.get(keyOf(w));
      return f ? keepCase(w.replace(/\u0301/g, ''), f) : w;
    });
  }

  /* ───────────── всё вместе ───────────── */
  function prep(text) {
    if (!/[А-Яа-яЁё]/.test(text)) return text;   // английский — как есть
    let t = abbreviations(text);
    t = numbers(t);
    t = yo(t);
    return applyUser(t);
  }

  const api = { prep, loadYo, loadUser, userObj, setStress, clearStress, userForm, stressForm, stressIndexOf, keyOf, ordinal, VOW, ACUTE, get yoSize() { return YO ? YO.size : 0; } };
  (typeof self !== 'undefined' ? self : globalThis).RuText = api;
})();
