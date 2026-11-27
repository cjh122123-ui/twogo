// 화면과 PDF 처리. 모든 처리는 브라우저 안에서만 하고 파일을 밖으로 보내지 않음.
// PDF 도구는 CDN에서 불러옴 (도구 코드만 받아 오고, 고른 파일은 밖으로 보내지 않음)
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.min.mjs';
import {
  parsePickingList, parseCertName, matchCert, storageOf, sortRows, outputName,
  duplicateKeys, findQuantity,
} from './logic.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'legacy/build/pdf.worker.min.mjs';
const CMAP_URL = PDFJS + 'cmaps/';
const { PDFDocument, StandardFonts, rgb } = window.PDFLib;

const $ = (id) => document.getElementById(id);
const pickInput = $('picking'), folderInput = $('folder'), runBtn = $('run');

function refresh() {
  $('pickingName').textContent = pickInput.files[0] ? pickInput.files[0].name : '선택 안 함';
  const n = [...folderInput.files].filter((f) => /\.pdf$/i.test(f.name)).length;
  $('folderName').textContent = folderInput.files.length
    ? `${folderInput.files[0].webkitRelativePath.split('/')[0]} (PDF ${n}개)` : '선택 안 함';
  runBtn.disabled = !(pickInput.files[0] && folderInput.files.length);
}
pickInput.addEventListener('change', refresh);
folderInput.addEventListener('change', refresh);
runBtn.addEventListener('click', () => run().catch((e) => {
  console.error(e);
  stop(['처리 중 오류가 났습니다.', String(e && e.message || e)]);
}).finally(() => { runBtn.disabled = false; setBusy(''); }));
$('dlgClose').addEventListener('click', () => $('dlg').close());

function setBusy(msg) { $('busy').textContent = msg; }

async function textItems(bytes, withFonts = false) {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(0), cMapUrl: CMAP_URL, cMapPacked: true }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    // 글꼴 id → PDF 안의 글꼴 이름 (예: ABCDEF+MalgunGothic). 글꼴 정보는 그리기 명령을 읽어야 들어옴
    const names = {};
    if (withFonts) {
      try {
        await page.getOperatorList();
        for (const it of tc.items) {
          if (it.fontName && !(it.fontName in names)) {
            names[it.fontName] = page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName).name : null;
          }
        }
      } catch { /* 글꼴 이름을 못 읽으면 비슷한 글꼴로 씀 */ }
    }
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const [, , c, d, e, f] = it.transform;
      out.push({
        str: it.str, page: p, x: e, w: it.width, size: Math.hypot(c, d) || it.height,
        baseline: f, y: vp.height - f, fontName: it.fontName, baseFont: names[it.fontName] || null,
      });
    }
  }
  const numPages = doc.numPages;
  await doc.destroy();
  return { items: out, numPages };
}

async function run() {
  runBtn.disabled = true;
  $('results').innerHTML = '';
  $('download').innerHTML = '';
  const pdfFiles = [...folderInput.files].filter((f) => /\.pdf$/i.test(f.name));

  // 보완 결정 3: 하위 폴더가 있으면 중지
  const sub = [...folderInput.files].filter((f) => f.webkitRelativePath.split('/').length > 2);
  if (sub.length) {
    const dirs = [...new Set(sub.map((f) => f.webkitRelativePath.split('/').slice(1, -1).join('/')))];
    return stop(['성적서 폴더 안에 하위 폴더가 있습니다.', ...dirs.map((d) => '· ' + d), '하위 폴더를 빼고 다시 선택해 주세요.']);
  }

  setBusy('피킹리스트 읽는 중…');
  const pickBytes = new Uint8Array(await pickInput.files[0].arrayBuffer());
  const { items } = await textItems(pickBytes);
  const pl = parsePickingList(items);
  if (pl.errors.length) return stop(['피킹리스트를 읽지 못했습니다.', ...pl.errors]);
  // 보완 결정 5: BOX가 비었거나 0이면 중지
  const badBox = pl.rows.filter((r) => !r.box);
  if (badBox.length) {
    return stop(['피킹리스트 BOX 칸이 비었거나 0인 줄이 있습니다.',
      ...badBox.map((r) => `· ${r.code} ${r.name} (${r.exp}) – BOX: ${r.boxText || '빈칸'}`)]);
  }

  // 성적서 이름 읽기
  const certs = [];
  const badNames = [];
  for (const f of pdfFiles) {
    const c = parseCertName(f.name);
    if (c) certs.push({ ...c, fileName: f.name, file: f }); else badNames.push(f.name);
  }

  // 짝짓기
  const kind = pl.rows.some((r) => storageOf(r.name) === '냉장') ? '냉장' : '상온';
  const dups = duplicateKeys(pl.rows);
  const results = pl.rows.map((row) => {
    const m = matchCert(row, certs);
    const notes = [...m.notes];
    if (dups.has(row.code + '|' + row.exp)) notes.push('같은 품목·소비기한 중복 줄');
    return { row, cert: m.cert, notes };
  });
  const order = sortRows(pl.rows, kind);
  order.forEach((o) => { if (!o.listed) results[pl.rows.indexOf(o.row)].notes.push('순서 목록에 없는 품목'); });

  // 고른 성적서 미리 읽기 (수량 칸 확인)
  setBusy('성적서 확인 중…');
  const used = [...new Set(results.filter((r) => r.cert).map((r) => r.cert))];
  const info = new Map();
  const stops = [];
  for (const c of used) {
    const bytes = new Uint8Array(await c.file.arrayBuffer());
    const t = await textItems(bytes, true);
    const q = findQuantity(t.items);
    if (q.status === 'stop') stops.push(`· ${c.fileName}: ${q.reason}`);
    if (q.status === 'ok') {
      const it = q.target.item;
      // 같은 글꼴로 쓸 수 있는 숫자 = 그 페이지에서 같은 글꼴로 이미 찍힌 글자
      const chars = new Set();
      t.items.filter((o) => o.page === it.page && o.fontName === it.fontName).forEach((o) => [...o.str].forEach((ch) => chars.add(ch)));
      q.target.font = { baseName: it.baseFont, chars };
    }
    info.set(c, { bytes, numPages: t.numPages, q });
  }
  // 보완 결정 6: 수량 칸이 애매하면 중지
  if (stops.length) return stop(['성적서 수량 칸을 확실히 정할 수 없어 작업을 멈췄습니다.', ...stops]);

  for (const r of results) {
    if (!r.cert) continue;
    const inf = info.get(r.cert);
    if (inf.q.status === 'none') r.notes.push('수량 칸 없음 – 수정 안 함');
    if (inf.numPages > 1) r.notes.push(`성적서 ${inf.numPages}페이지 – 모두 넣음`);
  }

  // 보완 결정 9: 넣을 성적서가 없으면 PDF 없이 팝업만
  const fileName = outputName(pl.shipDate, kind);
  const toPut = order.map((o) => results[pl.rows.indexOf(o.row)]).filter((r) => r.cert);
  let fontNote = false;
  if (toPut.length) {
    setBusy('PDF 만드는 중…');
    const out = await PDFDocument.create();
    const font = await out.embedFont(StandardFonts.Helvetica);
    const srcCache = new Map();
    for (const r of toPut) {
      const inf = info.get(r.cert);
      if (!srcCache.has(r.cert)) srcCache.set(r.cert, await PDFDocument.load(inf.bytes, { ignoreEncryption: true }));
      const src = srcCache.get(r.cert);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((pg) => out.addPage(pg));
      if (inf.q.status === 'ok') {
        const same = writeQuantity(pages[inf.q.target.item.page - 1], inf.q.target, r.row.box, font);
        if (!same) { fontNote = true; r.notes.push('비슷한 글꼴로 씀'); }
      }
    }
    const bytes = await out.save();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.textContent = `${fileName} 다시 내려받기`;
    $('download').appendChild(a);
    a.click();
  }

  renderTable(results, order, pl);
  showSummary({ results, toPut, fileName, kind, badNames, fontNote, pl });
}

// 원래 숫자 위에 흰 칸을 덮고 새 숫자를 씀 (기획서 6-4)
// 성적서에 들어 있는 글꼴에 필요한 숫자가 모두 있으면 그 글꼴로, 아니면 비슷한 글꼴(Helvetica)로 씀
// 결과: true = 같은 글꼴, false = 비슷한 글꼴
function writeQuantity(page, target, box, fallback) {
  const { item, start, end } = target;
  const text = String(box);
  const own = findOwnFont(page, target.font);
  const canOwn = own && [...text].every((ch) => target.font.chars.has(ch) && own.width(ch) > 0);
  // 글자 폭: 원래 글꼴 폭표가 있으면 그것으로, 없으면 Helvetica 비율로 나눔
  const W = own ? (s) => [...s].reduce((a, ch) => a + own.width(ch), 0) : (s) => fallback.widthOfTextAtSize(s, 1000);
  const total = W(item.str) || 1;
  const x0 = item.x + item.w * W(item.str.slice(0, start)) / total;
  const x1 = item.x + item.w * W(item.str.slice(0, end)) / total;
  const size = item.size;
  page.drawRectangle({
    x: x0 - size * 0.05, y: item.baseline - size * 0.2,
    width: (x1 - x0) + size * 0.1, height: size * 0.95,
    color: rgb(1, 1, 1), borderWidth: 0,
  });
  if (canOwn) {
    const tw = W(text) * size / 1000;
    const hex = [...text].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    page.pushOperators(
      PDFLib.pushGraphicsState(), PDFLib.setFillingRgbColor(0, 0, 0), PDFLib.beginText(),
      PDFLib.setFontAndSize(own.key, size), PDFLib.moveText(x1 - tw, item.baseline),
      PDFLib.showText(PDFLib.PDFHexString.of(hex)), PDFLib.endText(), PDFLib.popGraphicsState(),
    );
    return true;
  }
  const tw = fallback.widthOfTextAtSize(text, size);
  // 오른쪽 끝을 원래 숫자와 맞춰서 "Box"와의 간격을 그대로 둠
  page.drawText(text, { x: x1 - tw, y: item.baseline, size, font: fallback, color: rgb(0, 0, 0) });
  return false;
}

// 페이지 글꼴 중 이름이 같은 단순 TrueType(WinAnsi) 글꼴 찾기
function findOwnFont(page, font) {
  if (!font || !font.baseName) return null;
  const { PDFName, PDFDict, PDFArray, PDFNumber } = PDFLib;
  const res = page.node.Resources();
  const fonts = res && res.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fonts) return null;
  for (const [key, ref] of fonts.entries()) {
    const f = page.doc.context.lookup(ref);
    if (!(f instanceof PDFDict)) continue;
    const base = f.get(PDFName.of('BaseFont'));
    if (!base || base.decodeText() !== font.baseName) continue;
    if (String(f.get(PDFName.of('Subtype'))) !== '/TrueType') continue;
    const widths = f.lookupMaybe(PDFName.of('Widths'), PDFArray);
    const first = f.lookupMaybe(PDFName.of('FirstChar'), PDFNumber);
    if (!widths || !first) continue;
    const fc = first.asNumber();
    return {
      key: key.decodeText(),
      width: (ch) => {
        const i = ch.charCodeAt(0) - fc;
        const v = i >= 0 && i < widths.size() ? widths.lookup(i) : null;
        return v ? v.asNumber() : 0;
      },
    };
  }
  return null;
}

function renderTable(results, order, pl) {
  const rowsHtml = order.map((o) => {
    const r = results[pl.rows.indexOf(o.row)];
    const status = r.notes.length ? r.notes.join(' / ') : '정상';
    return `<tr class="${r.cert ? '' : 'miss'}">
      <td>${esc(r.row.code)} ${esc(r.row.name)}</td>
      <td class="num">${esc(r.row.exp)}</td>
      <td>${r.cert ? esc(r.cert.fileName) : '없음'}</td>
      <td class="num">${r.row.box} Box</td>
      <td class="${r.notes.length ? 'warn' : 'ok'}">${esc(status)}</td></tr>`;
  }).join('');
  $('results').innerHTML = `
    <p class="meta">출하일자 ${esc(pl.shipDate)} · 품목 ${pl.rows.length}줄 (페이지 순서대로)</p>
    <div class="tablewrap"><table>
      <thead><tr><th>피킹리스트 품목</th><th>소비기한</th><th>고른 성적서 파일 이름</th><th>수량</th><th>상태</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table></div>`;
}

function showSummary({ results, toPut, fileName, kind, badNames, fontNote }) {
  const lines = [];
  if (toPut.length) lines.push(`<b>${esc(fileName)}</b> 을(를) 만들었습니다. (${kind}제품, 성적서 ${toPut.length}개)`);
  else lines.push('<b>넣을 성적서가 하나도 없어 PDF를 만들지 않았습니다.</b>');
  const count = {};
  results.forEach((r) => r.notes.forEach((n) => { if (n === '비슷한 글꼴로 씀') return; const k = n.replace(/ \(.*\)$/, ''); count[k] = (count[k] || 0) + 1; }));
  const list = Object.entries(count).map(([k, v]) => `<li>${esc(k)}: ${v}개</li>`);
  if (fontNote) list.push('<li>수량 숫자는 성적서와 같은 글꼴을 쓸 수 없어 비슷한 글꼴(Helvetica)로 썼습니다.</li>');
  if (badNames.length) list.push(`<li>파일 이름에 (제조일자 - 소비기한)이 없어 건너뛴 파일: ${badNames.length}개</li>`);
  $('dlgBody').innerHTML = `<p>${lines.join('<br>')}</p>` +
    (list.length ? `<p>특이사항</p><ul>${list.join('')}</ul>` : '<p>특이사항 없음</p>');
  $('dlgTitle').textContent = '작업 결과';
  $('dlg').showModal();
}

function stop(lines) {
  $('dlgTitle').textContent = '작업을 멈췄습니다';
  $('dlgBody').innerHTML = `<p><b>${esc(lines[0])}</b></p>` + lines.slice(1).map((l) => `<p>${esc(l)}</p>`).join('');
  $('dlg').showModal();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

