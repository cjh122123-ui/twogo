// 순수 로직 (PDF·화면과 상관없는 부분). 기획서 6장·7장, 보완 결정 1·2번 기준.

// 품명 비교 전 정리: 띄어쓰기, △, [액상], _, 괄호 무시 (기획서 6-3)
export function normalize(s) {
  return String(s)
    .replace(/\[액상\]/g, '')
    .replace(/[\s△▲_()\[\]{}（）]/g, '')
    .toLowerCase();
}

// 짝짓기 핵심어 (기획서 6-3)
export const KEYWORDS = ['핸드드립', '스틱커피', '보틀', '500ml', '라떼', '블랙그라운드',
  '아로마노트', '초콜릿', '바닐라', '콜드브루', '원액'];
// 반드시 같아야 하는 구분어
export const MUST_MATCH = ['디카페인', '에이리스트'];

export function keywordsOf(name) {
  const n = normalize(name);
  return KEYWORDS.filter((k) => n.includes(k));
}

// 성적서 파일 이름 끝의 (제조일자 - 소비기한)
export function parseCertName(fileName) {
  const base = fileName.replace(/\.pdf$/i, '');
  const m = base.match(/\((\d{6})\s*[-~]\s*(\d{6})\)\s*$/);
  if (!m) return null;
  return { mfg: m[1], exp: m[2], product: base.slice(0, m.index).trim() };
}

// 2027-05-24 → 270524
export function dateToYYMMDD(d) {
  const m = String(d).match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (!m) return null;
  return m[1].slice(2) + m[2].padStart(2, '0') + m[3].padStart(2, '0');
}

// 한 줄에 맞는 성적서 고르기
// certs: [{fileName, mfg, exp, product}]
// 결과: {cert|null, notes:[]}
export function matchCert(row, certs) {
  const exp = dateToYYMMDD(row.exp);
  const rowN = normalize(row.name);
  const rowKw = keywordsOf(row.name);
  // 1단계: 소비기한 정확히 일치
  const sameExp = certs.filter((c) => c.exp === exp);
  if (!sameExp.length) return { cert: null, notes: ['성적서 없음 – 빠짐'] };
  // 구분어(디카페인, 에이리스트) 일치
  const guarded = sameExp.filter((c) => {
    const cN = normalize(c.product);
    return MUST_MATCH.every((w) => rowN.includes(w) === cN.includes(w));
  });
  // 2단계: 핵심어 겹침
  const scored = guarded.map((c) => {
    const cKw = keywordsOf(c.product);
    const common = cKw.filter((k) => rowKw.includes(k)).length;
    const extra = cKw.filter((k) => !rowKw.includes(k));
    return { c, common, extra };
  }).filter((s) => s.common > 0); // 보완 결정 1: 겹치는 핵심어 없으면 없음
  if (!scored.length) return { cert: null, notes: ['성적서 없음 – 빠짐'] };
  scored.sort((a, b) => b.common - a.common || a.extra.length - b.extra.length || a.c.mfg.localeCompare(b.c.mfg));
  const best = scored[0];
  const notes = [];
  const ties = scored.filter((s) => s.common === best.common && s.extra.length === best.extra.length);
  // 같은 품목 성적서 여러 개는 제조일자 빠른 것 (보완 결정 2). 다른 품목끼리 동점이면 애매함
  const distinct = new Set(ties.map((s) => normalize(s.c.product)));
  if (distinct.size > 1) notes.push('후보 여러 개 – 확인 필요');
  // 성적서에만 있는 핵심어가 있으면 다른 품목일 수 있음
  else if (best.extra.length) notes.push(`후보 확인 필요 (성적서에만 있는 말: ${best.extra.join(', ')})`);
  return { cert: best.c, notes };
}

// 상온/냉장 (기획서 6-6)
export function storageOf(name) {
  const n = normalize(name);
  if (n.includes('보틀') || n.includes('500')) return '상온';
  if (n.includes('콜드브루')) return '냉장';
  return '상온';
}

// 페이지 순서 (기획서 6-7). 필요한 말이 모두 들어 있는 항목 중 가장 구체적인 것
export const ORDER = {
  상온: [
    ['핸드드립', '아로마노트'],
    ['에이리스트', '스틱커피', '디카페인'],
    ['에이리스트', '초콜릿', '라떼'],
    ['보틀', '500'],
    ['핸드드립', '블랙그라운드'],
    ['핸드드립', '디카페인'],
    ['스틱커피'],
    ['바닐라', '라떼'],
  ],
  냉장: [
    ['콜드브루'],
    ['디카페인', '콜드브루'],
  ],
};

export function orderIndex(name, kind) {
  const n = normalize(name);
  let best = -1, bestLen = 0;
  ORDER[kind].forEach((words, i) => {
    if (words.every((w) => n.includes(w)) && words.length > bestLen) { best = i; bestLen = words.length; }
  });
  return best;
}

// 줄 목록 → 페이지 순서대로 정렬. rows는 피킹리스트 순서, row.idx 보존
export function sortRows(rows, kind) {
  const withIdx = rows.map((r, i) => ({ r, i, o: orderIndex(r.name, kind) }));
  withIdx.sort((a, b) => {
    const ao = a.o < 0 ? Infinity : a.o, bo = b.o < 0 ? Infinity : b.o;
    if (ao !== bo) return ao - bo;
    if (a.o >= 0) { const d = String(a.r.exp).localeCompare(String(b.r.exp)); if (d) return d; }
    return a.i - b.i;
  });
  return withIdx.map((x) => ({ row: x.r, listed: x.o >= 0 }));
}

// 결과 파일 이름 (기획서 6-8)
export function outputName(shipDate, kind) {
  return `${dateToYYMMDD(shipDate)} 투썸 (${kind}제품).pdf`;
}

// 같은 품목·소비기한 중복 줄 찾기
export function duplicateKeys(rows) {
  const count = {};
  rows.forEach((r) => { const k = r.code + '|' + r.exp; count[k] = (count[k] || 0) + 1; });
  return new Set(Object.keys(count).filter((k) => count[k] > 1));
}

// ---- 피킹리스트 읽기 ----
// items: [{str, x, y, w, page}] (y는 위에서 아래로 커지는 값)
// 머리글(품번·품명·BOX·소비기한)의 x 위치로 칸을 나눔
export function parsePickingList(items) {
  const errors = [];
  let shipDate = null;
  const all = items.filter((it) => it.str.trim() !== '');
  // 출하일자: "출하일자" 글자 뒤 또는 같은 줄의 첫 날짜
  const shipIdx = all.findIndex((it) => it.str.replace(/\s/g, '').includes('출하일자'));
  if (shipIdx >= 0) {
    const label = all[shipIdx];
    const inline = label.str.match(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/);
    if (inline) shipDate = inline[0];
    else {
      const sameLine = all.filter((it) => it.page === label.page && Math.abs(it.y - label.y) < 12 && it.x > label.x)
        .sort((a, b) => a.x - b.x);
      const d = sameLine.find((it) => /\d{4}[-./]\d{1,2}[-./]\d{1,2}/.test(it.str));
      if (d) shipDate = d.str.match(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/)[0];
    }
  }
  if (!shipDate) errors.push('출하일자를 찾지 못했습니다.');

  const rows = [];
  const pages = [...new Set(all.map((it) => it.page))];
  let cols = null;
  for (const p of pages) {
    const lines = groupLines(all.filter((it) => it.page === p));
    for (const line of lines) {
      const head = findHeader(line);
      if (head) { cols = head; continue; }
      if (!cols) continue;
      const cell = {};
      for (const it of line) {
        const k = nearestCol(it, cols);
        if (k) cell[k] = (cell[k] ? cell[k] + ' ' : '') + it.str.trim();
      }
      const code = (cell.code || '').match(/\d{6,}/);
      const exp = (cell.exp || '').match(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/);
      if (!code || !exp) continue; // 품목 줄이 아님 (합계 등)
      const boxText = (cell.box || '').replace(/[,\s]/g, '');
      rows.push({
        code: code[0], name: (cell.name || '').trim(), boxText,
        box: /^\d+$/.test(boxText) ? parseInt(boxText, 10) : null,
        exp: exp[0].replace(/[./]/g, '-'),
      });
    }
  }
  if (!cols) errors.push('품번·품명·BOX·소비기한 머리글을 찾지 못했습니다.');
  else if (!rows.length) errors.push('품목 줄을 하나도 읽지 못했습니다.');
  return { shipDate, rows, errors };
}

function groupLines(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    // 같은 줄 안에서도 글자 크기가 달라 기준선이 몇 pt씩 어긋남 (견본: BOX 숫자가 3pt 낮음)
    if (last && Math.abs(last.y - it.y) < 6) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  return lines.map((l) => l.items.sort((a, b) => a.x - b.x));
}

function findHeader(line) {
  const find = (re) => line.find((it) => re.test(it.str.replace(/\s/g, '')));
  const code = find(/^품번$/), name = find(/^품명$/), box = find(/^box$/i), exp = find(/^소비기한$/);
  if (!(code && name && box && exp)) return null;
  const others = line.filter((it) => ![code, name, box, exp].includes(it));
  const center = (it) => it.x + it.w / 2;
  const cols = [
    { key: 'code', c: center(code) }, { key: 'name', c: center(name) },
    { key: 'box', c: center(box) }, { key: 'exp', c: center(exp) },
    ...others.map((it) => ({ key: null, c: center(it) })),
  ].sort((a, b) => a.c - b.c);
  // 칸 경계 = 이웃 머리글 가운데 지점
  return cols.map((col, i) => ({
    key: col.key,
    lo: i === 0 ? -Infinity : (cols[i - 1].c + col.c) / 2,
    hi: i === cols.length - 1 ? Infinity : (col.c + cols[i + 1].c) / 2,
    nameLo: col.key === 'name',
  }));
}

function nearestCol(it, cols) {
  // 품명은 길어서 왼쪽 끝이 칸 안에 있으면 품명 칸으로 봄
  const start = it.x + 1, center = it.x + it.w / 2;
  const byStart = cols.find((c) => start >= c.lo && start < c.hi);
  if (byStart && byStart.key === 'name') return 'name';
  const byCenter = cols.find((c) => center >= c.lo && center < c.hi);
  return byCenter ? byCenter.key : null;
}

// ---- 성적서 수량 칸 찾기 ----
// items: [{str, x, y, w, h, page}] 원본 PDF 좌표 (y는 글자 기준선, 아래에서 위로)
// 결과: {status: 'none'|'ok'|'stop', reason, target}
export function findQuantity(items) {
  const boxHits = [];
  items.forEach((it, i) => {
    const re = /box/gi;
    let m;
    while ((m = re.exec(it.str))) boxHits.push({ i, at: m.index });
  });
  if (!boxHits.length) return { status: 'none' };
  if (boxHits.length > 1) return { status: 'stop', reason: `"Box" 글자가 ${boxHits.length}번 나와 수량 칸을 정할 수 없습니다.` };
  const { i, at } = boxHits[0];
  const it = items[i];
  const before = it.str.slice(0, at);
  let num = before.match(/(\d+)\s*$/);
  if (num) {
    return check(num[1], { item: it, start: num.index, end: num.index + num[1].length });
  }
  // 숫자가 바로 앞 조각에 따로 있는 경우
  if (before.trim() === '') {
    const prev = items
      .filter((o) => o !== it && o.page === it.page && Math.abs(o.y - it.y) < 3 && o.x + o.w <= it.x + 2)
      .sort((a, b) => b.x - a.x)[0];
    const pm = prev && prev.str.match(/(\d+)\s*$/);
    if (pm) return check(pm[1], { item: prev, start: pm.index, end: pm.index + pm[1].length });
  }
  return { status: 'stop', reason: '"Box" 앞에서 수량 숫자를 찾지 못했습니다.' };

  function check(n, target) {
    if (n !== '10') return { status: 'stop', reason: `수량 칸 숫자가 10이 아니라 ${n}입니다.` };
    return { status: 'ok', target };
  }
}
