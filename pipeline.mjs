import ExcelJS from 'exceljs';

const branchExceptions = new Set(['고려대학교(세종)_분교','건국대학교(글로컬)_분교','동국대학교(WISE)_분교','연세대학교(미래)_분교','한양대학교(ERICA)_분교']);
const ratioPattern = /비율|비중|평균|율|1인당|평점|지수/;
const canonicalSchool = (name) => {
  const text = String(name || '').trim();
  if (branchExceptions.has(text)) return text;
  return text.replace(/\s*_제[234]캠퍼스$/,'').replace(/\((고령|김해|양산|해운대)\)$/,'').trim();
};
const valueOf = (cell) => cell?.result ?? cell;
const graduationYear = (value) => {
  const digits = String(value ?? '').replace(/[^0-9]/g,'');
  return /^20\d{4}$/.test(digits) ? `${digits.slice(0,4)}.${digits.slice(4)}` : value;
};

async function loadXlsx(bytes, fileName) {
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes); }
  catch { throw new Error(`${fileName}: 파일 내용이 손상되었거나 다운로드가 완료되지 않았습니다. 1단계에서 해당 파일을 다시 다운로드해 주세요.`); }
  if (!workbook.worksheets.length) throw new Error(`${fileName}: 처리할 워크시트가 없습니다.`);
  return workbook;
}

export async function cleanWorkbook(bytes, fileName) {
  const workbook = await loadXlsx(bytes, fileName);
  for (const sheet of workbook.worksheets) {
    let headerRow = 1;
    for (let row = 1; row <= Math.min(10, sheet.rowCount); row++) {
      if (sheet.getRow(row).values.some((v) => /^(학교|학교명)$/.test(String(valueOf(v) || '').replace(/\s/g,'')))) { headerRow = row; break; }
    }
    if (headerRow > 1) sheet.spliceRows(1, headerRow - 1);
    const headers = sheet.getRow(1).values.map((v) => String(valueOf(v) || '').trim());
    const schoolColumn = headers.findIndex((v) => /^(학교|학교명)$/.test(String(v || '').replace(/\s/g,'')));
    const graduationColumn = headers.findIndex((v) => String(v || '').replace(/\s/g,'').includes('졸업연도'));
    if (graduationColumn > 0) for (let row = 2; row <= sheet.rowCount; row++) sheet.getCell(row, graduationColumn).value = graduationYear(sheet.getCell(row, graduationColumn).value);
    if (schoolColumn <= 0) continue;
    const groups = new Map();
    for (let row = 2; row <= sheet.rowCount; row++) {
      const values = sheet.getRow(row).values.slice(1).map(valueOf);
      const school = canonicalSchool(values[schoolColumn - 1]);
      if (!school) continue;
      if (!groups.has(school)) groups.set(school, []);
      groups.get(school).push(values);
    }
    if (![...groups.values()].some((rows) => rows.length > 1)) continue;
    const output = [];
    for (const [school, rows] of groups) {
      const merged = [...rows[0]]; merged[schoolColumn - 1] = school;
      for (let col = 0; col < merged.length; col++) {
        if (col === schoolColumn - 1) continue;
        const nums = rows.map((r) => Number(r[col])).filter(Number.isFinite);
        if (!nums.length) continue;
        merged[col] = ratioPattern.test(headers[col + 1] || '') ? nums.reduce((a,b)=>a+b,0) / nums.length : nums.reduce((a,b)=>a+b,0);
      }
      output.push(merged);
    }
    if (sheet.rowCount > 1) sheet.spliceRows(2, sheet.rowCount - 1);
    output.forEach((row) => sheet.addRow(row));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, headers.length - 1) } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }
  const outputName = fileName.replace(/\.(xlsx|xls)$/i,'') + '_정제.xlsx';
  return { name: outputName, bytes: Buffer.from(await workbook.xlsx.writeBuffer()) };
}

export async function dashboardFromWorkbook(bytes, fileName) {
  const workbook = await loadXlsx(bytes, fileName);
  const sheet = workbook.worksheets[0];
  const rows = [];
  sheet.eachRow((row) => rows.push(row.values.slice(1).map(valueOf)));
  const title = fileName.replace(/_정제\.xlsx$/i,'');
  const data = JSON.stringify(rows).replace(/</g,'\\u003c');
  const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font-family:system-ui;margin:0;background:#f3f1eb;color:#181b1f}main{max-width:1280px;margin:auto;padding:60px 24px}h1{font-size:42px}input{padding:12px;width:320px}table{width:100%;border-collapse:collapse;background:white;margin-top:24px}th,td{padding:11px;border-bottom:1px solid #ddd;text-align:left}th{position:sticky;top:0;background:#222;color:white}.wrap{max-height:70vh;overflow:auto}</style><main><h1>${title}</h1><input id="q" placeholder="학교 또는 항목 검색"><div class="wrap"><table id="t"></table></div></main><script>const rows=${data},t=document.querySelector('#t');function draw(q=''){const list=rows.filter(r=>r.join(' ').toLowerCase().includes(q.toLowerCase()));t.innerHTML='<thead><tr>'+rows[0].map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+list.slice(1).map(r=>'<tr>'+r.map(x=>'<td>'+String(x??'')+'</td>').join('')+'</tr>').join('')+'</tbody>'}draw();document.querySelector('#q').oninput=e=>draw(e.target.value)</script></html>`;
  return { name: title + '.html', bytes: Buffer.from(html) };
}
