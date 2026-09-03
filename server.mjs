import http from 'node:http';
import { readFile, readdir, mkdir, writeFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { bucketEnabled, putObject } from './storage.mjs';
import { cleanWorkbook, dashboardFromWorkbook, analysisInputFromWorkbook } from './pipeline.mjs';

const PORT = Number(process.env.PORT || 4173);
const TARGET_ITEM_COUNT = 112;
const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const ORIGIN = 'https://www.academyinfo.go.kr';
const SCHOOL_TYPES = { '01': '전문대학', '02': '대학', '03': '대학원', '04': '대학원대학' };
const CATEGORIES = [
  ['01', '학생'], ['04', '교육여건'], ['02', '교육연구성과'],
  ['03', '대학재정/교육비'], ['05', '대학운영']
];
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const execFileAsync = promisify(execFile);
const selectedFolders = new Map();
const runningOperations = new Map();
const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || '';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 }) : null;
const databaseState = { enabled: Boolean(pool), connected: false, error: '' };

async function createAiAnalysis(bytes,fileName,apiKey){
  if(!apiKey)return '';
  if(!/^sk-[A-Za-z0-9_-]{20,}$/.test(apiKey))throw new Error('OpenAI API 키 형식이 올바르지 않습니다. 설정을 확인해 주세요.');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60_000);
  try{
    const summary=analysisInputFromWorkbook(bytes,fileName);
    const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:controller.signal,headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-5-mini',store:false,max_output_tokens:1200,instructions:'당신은 한국 대학 공시 데이터 분석가입니다. 제공된 집계값만 근거로 사용하고 추측하지 마세요. 한국어로 핵심 요약, 주요 관찰 3개, 해석 시 주의점 1개를 간결하게 작성하세요. 숫자는 읽기 쉽게 표시하세요.',input:JSON.stringify(summary)})});
    const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload?.error?.message||`OpenAI API 요청 실패 (HTTP ${response.status})`);
    return payload.output_text||payload.output?.flatMap(item=>item.content||[]).filter(part=>part.type==='output_text').map(part=>part.text).join('\n')||'AI 분석 결과가 비어 있습니다.';
  }catch(error){if(error.name==='AbortError')throw new Error('OpenAI 분석 시간이 초과되었습니다.');throw error;}finally{clearTimeout(timer);}
}

async function initializeDatabase() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS catalog_cache (
        cache_key text PRIMARY KEY,
        payload jsonb NOT NULL,
        fetched_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS download_events (
        id bigserial PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        item_count integer NOT NULL,
        school_code text,
        user_code text,
        purpose_code text,
        status text NOT NULL,
        error_message text
      );
      CREATE TABLE IF NOT EXISTS stored_files (
        id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        stage text NOT NULL,
        original_name text NOT NULL,
        object_key text NOT NULL,
        size_bytes bigint NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_blobs (
        object_key text PRIMARY KEY,
        content_type text NOT NULL,
        payload bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    databaseState.connected = true;
    databaseState.error = '';
    console.log('PostgreSQL 연결 및 테이블 준비 완료');
  } catch (error) {
    databaseState.connected = false;
    databaseState.error = error.message;
    console.error('PostgreSQL 초기화 실패:', error.message);
  }
}

const databaseReady = initializeDatabase();

async function cachedCatalog(schoolCodes) {
  const cacheKey = `filename-v1:${[...schoolCodes].sort().join(',')}`;
  if (pool) {
    await databaseReady;
    if (databaseState.connected) {
      try {
        const cached = await pool.query('SELECT payload FROM catalog_cache WHERE cache_key = $1 AND fetched_at > now() - interval \'30 minutes\'', [cacheKey]);
        if (cached.rowCount) return cached.rows[0].payload;
      } catch (error) {
        databaseState.connected = false;
        databaseState.error = error.message;
        console.error('PostgreSQL 캐시 조회 실패:', error.message);
      }
    }
  }
  const items = await fetchCatalog(schoolCodes);
  if (pool) {
    try {
      await pool.query(`INSERT INTO catalog_cache (cache_key, payload, fetched_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`, [cacheKey, JSON.stringify(items)]);
      databaseState.connected = true;
      databaseState.error = '';
    } catch (error) {
      databaseState.error = error.message;
      console.error('PostgreSQL 캐시 저장 실패:', error.message);
    }
  }
  return items;
}

async function recordDownload(items, meta, status, errorMessage = null) {
  if (!pool) return;
  try {
    await databaseReady;
    await pool.query('INSERT INTO download_events (item_count, school_code, user_code, purpose_code, status, error_message) VALUES ($1, $2, $3, $4, $5, $6)', [items.length, items[0]?.schoolCode || null, meta.userCode || null, meta.purposeCode || null, status, errorMessage]);
    databaseState.connected = true;
  } catch (error) {
    databaseState.error = error.message;
    console.error('PostgreSQL 다운로드 이력 저장 실패:', error.message);
  }
}

async function recordStoredFile(id, stage, name, key, size) {
  if (!pool) return;
  try { await databaseReady; await pool.query('INSERT INTO stored_files (id, stage, original_name, object_key, size_bytes) VALUES ($1,$2,$3,$4,$5)', [id, stage, name, key, size]); }
  catch (error) { databaseState.error = error.message; console.error('PostgreSQL 파일 메타데이터 저장 실패:', error.message); }
}

async function persistStoredFile(id, stage, name, key, bytes, contentType) {
  let storage = 'response-only';
  if (bucketEnabled) {
    try {
      await putObject(key, bytes, contentType);
      storage = 'bucket';
    } catch (error) {
      console.error('Bucket 저장 실패, PostgreSQL로 대체:', error.message);
    }
  }
  if (storage !== 'bucket' && pool) {
    await databaseReady;
    if (databaseState.connected) {
      await pool.query(
        `INSERT INTO file_blobs (object_key, content_type, payload)
         VALUES ($1, $2, $3)
         ON CONFLICT (object_key) DO UPDATE
         SET content_type = EXCLUDED.content_type, payload = EXCLUDED.payload, created_at = now()`,
        [key, contentType, bytes]
      );
      storage = 'postgres';
    }
  }
  await recordStoredFile(id, stage, name, key, bytes.length);
  return storage;
}

function runPowerShell(command, operationId) {
  return new Promise((resolvePromise, rejectPromise) => {
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
    const child = execFile('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encodedCommand], {
      windowsHide: true, encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 30 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (operationId) runningOperations.delete(operationId);
      if (error) { error.stdout = stdout; error.stderr = stderr; rejectPromise(error); }
      else resolvePromise({ stdout, stderr });
    });
    if (operationId) runningOperations.set(operationId, child);
  });
}

async function dashboardInputFolder(sourcePath) {
  const source = resolve(sourcePath);
  if (basename(source) === '정제') return source;
  const child = join(source, '정제');
  if (await access(child).then(() => true).catch(() => false)) return child;
  return source;
}

class AcademySession {
  cookie = '';

  async request(path, options = {}) {
    const headers = {
      'user-agent': 'Mozilla/5.0 AcademyDataBatchDownloader/1.0',
      'accept-language': 'ko-KR,ko;q=0.9,en;q=0.5',
      referer: `${ORIGIN}/popup/main0810/list.do`,
      ...options.headers
    };
    if (this.cookie) headers.cookie = this.cookie;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(`${ORIGIN}${path}`, { ...options, headers });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) this.cookie = setCookie.split(';')[0];
        if (!response.ok) throw new Error(`대학알리미 요청 실패 (${response.status})`);
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 700));
      }
    }
    throw lastError;
  }

  async start() {
    await this.request('/popup/main0810/list.do');
  }

  async postForm(path, values) {
    return this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
      body: values instanceof URLSearchParams ? values : new URLSearchParams(values)
    });
  }
}

function leafItems(data, categoryCode, categoryName, schoolCode) {
  const nodes = [...(data.ajaxList2 || []), ...(data.ajaxList3 || []), ...(data.ajaxList4 || [])];
  const kinds = data.ajaxList6 || [];
  const years = data.ajaxList5 || [];
  const seen = new Set();
  const items = [];
  for (const node of nodes) {
    if (node.pgm_clft_cd !== 'P' || !node.item_id || seen.has(String(node.item_id))) continue;
    const availableYears = years.filter((x) => String(x.item_id) === String(node.item_id)).map((x) => String(x.svy_yr));
    const chosenYear = availableYears.includes('2026') ? '2026' : availableYears.includes('2025') ? '2025' : null;
    const kind = kinds.find((x) => String(x.item_id) === String(node.item_id) && String(x.acif_dta_rqst_knd_cd) === '10')
      || kinds.find((x) => String(x.item_id) === String(node.item_id));
    if (!chosenYear || !kind) continue;
    seen.add(String(node.item_id));
    const itemName = node.pgm_kor_shrt_nm || node.pgm_estn_nm || `항목 ${node.item_id}`;
    const fileName = `${chosenYear}년__${SCHOOL_TYPES[schoolCode]}_${itemName}_학교별자료.xlsx`.replace(/[<>:"/\\|?*]/g, '_');
    items.push({
      id: String(node.item_id),
      name: itemName, fileName,
      categoryCode, categoryName, schoolCode,
      schoolName: SCHOOL_TYPES[schoolCode], year: chosenYear,
      fallback: chosenYear === '2025', kindCode: String(kind.acif_dta_rqst_knd_cd)
    });
  }
  return items;
}

async function fetchCatalog(schoolCodes) {
  const session = new AcademySession();
  await session.start();
  const all = [];
  for (const schoolCode of schoolCodes) {
    for (const [categoryCode, categoryName] of CATEGORIES) {
      const response = await session.postForm('/popup/main0810/selectDataList.do', {
        schlDivCd: schoolCode, itemDivCd: categoryCode, svyYr: '', all: '', fp: '', fn: '', sn: '', searchValue: ''
      });
      const data = await response.json();
      if (Number(data.M_CODE) < 0) throw new Error(data.M_RTME || '항목 목록을 불러오지 못했습니다.');
      all.push(...leafItems(data, categoryCode, categoryName, schoolCode));
    }
  }
  const schoolPriority = { '02': 0, '01': 1, '03': 2, '04': 3 };
  const ordered = [...all].sort((a, b) =>
    (schoolPriority[a.schoolCode] ?? 9) - (schoolPriority[b.schoolCode] ?? 9)
    || Number(a.id) - Number(b.id)
  );
  const selected = [];
  const selectedIds = new Set();
  const selectedSchoolItems = new Set();

  // 먼저 항목 ID당 하나만 선택한다. 동일 항목은 대학 자료를 우선한다.
  for (const item of ordered) {
    if (selectedIds.has(item.id)) continue;
    selected.push(item);
    selectedIds.add(item.id);
    selectedSchoolItems.add(`${item.schoolCode}:${item.id}`);
  }

  // 현재 2026/2025 고유 ID가 112개 미만이면 학교 종류가 다른 별도 공시 자료로 보충한다.
  for (const item of ordered) {
    if (selected.length >= TARGET_ITEM_COUNT) break;
    const key = `${item.schoolCode}:${item.id}`;
    if (selectedSchoolItems.has(key)) continue;
    selected.push({ ...item, schoolVariant: true });
    selectedSchoolItems.add(key);
  }

  return selected.slice(0, TARGET_ITEM_COUNT);
}

async function createDownload(items, meta) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 10) throw new Error('한 묶음은 1~10개 항목이어야 합니다.');
  if (items.some((item) => item.schoolCode !== items[0].schoolCode)) throw new Error('한 묶음에는 같은 학교 종류의 항목만 포함할 수 있습니다.');
  const session = new AcademySession();
  await session.start();
  const requestParams = new URLSearchParams({ itemDivCd: '01', svyYr: '', fp: '', fn: '', sn: '' });
  for (const item of items) {
    requestParams.append('all', `${item.id}^^${item.kindCode}`);
    requestParams.append('all', `${item.id}^^${item.year}`);
    requestParams.append('all', `${item.id}^^${item.schoolCode}^^${item.year}`);
  }
  const listResponse = await session.postForm('/popup/main0810/selectReqList.do', requestParams);
  const listData = await listResponse.json();
  if (Number(listData.M_CODE) < 0) throw new Error(listData.M_RTME || '다운로드 목록 생성 실패');
  const resultParams = new URLSearchParams({
    schlDivCd: items[0].schoolCode, itemDivCd: '01', svyYr: '',
    all: items[0].schoolCode, fp: '', fn: '', sn: '', searchValue: ''
  });
  for (const row of listData.resultList1 || []) {
    if (row.colvalue12 && row.colvalue13) resultParams.append('sel', `${row.colvalue2}^^${row.colvalue12}^^${row.colvalue13}`);
  }
  const resultResponse = await session.postForm('/popup/main0810/selectReqRst.do', resultParams);
  const resultData = await resultResponse.json();
  if (Number(resultData.M_CODE) < 0) throw new Error(resultData.M_RTME || '파일 생성 실패');
  if (!Number(resultData.resultList?.exist)) throw new Error('대학알리미에 생성된 파일이 없습니다.');
  const downloadParams = new URLSearchParams({
    itemDivCd: '01', svyYr: '', fp: resultData.resultList.fp,
    fn: resultData.resultList.fn, sn: resultData.resultList.sn
  });
  let file;
  let lastDownloadError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const fileResponse = await session.postForm('/popup/main0810/download.do', downloadParams);
      file = {
        bytes: Buffer.from(await fileResponse.arrayBuffer()),
        contentType: fileResponse.headers.get('content-type') || 'application/zip',
        disposition: fileResponse.headers.get('content-disposition') || 'attachment; filename="academy-data.zip"'
      };
      break;
    } catch (error) {
      lastDownloadError = error;
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 900));
    }
  }
  if (!file) throw lastDownloadError || new Error('대학알리미 파일 다운로드에 실패했습니다.');
  const logParams = new URLSearchParams();
  items.forEach((item, index) => {
    logParams.set(`svyYr${index}`, item.year);
    logParams.set(`itemId${index}`, item.id);
    logParams.set(`schlDivCd${index}`, item.schoolCode);
    logParams.set(`dwldUsrDivCd${index}`, meta.userCode || '004');
    logParams.set(`dwldEtcUsrNm${index}`, '');
    logParams.set(`dwldPrpsCd${index}`, meta.purposeCode || '003');
    logParams.set(`dwldEtcPrpsCtnt${index}`, '');
    logParams.set(`dwldDtlCtnt${index}`, meta.detail || '공시 데이터 일괄 활용');
  });
  session.postForm('/popup/main0810/fileInsert.do', logParams).catch(() => {});
  return file;
}

async function chooseWindowsFolder(description = '대학알리미 데이터를 저장할 폴더를 선택하세요.') {
  if (process.platform !== 'win32') throw new Error('Windows에서만 기본 폴더 선택 창을 사용할 수 있습니다.');
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = '${description.replaceAll("'", "''")}'`,
    '$dialog.ShowNewFolderButton = $true',
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $dialog.SelectedPath }"
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: false, encoding: 'utf8' });
  return stdout.trim();
}

function readZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('ZIP 파일 구조를 읽을 수 없습니다.');
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('ZIP 항목 정보가 손상되었습니다.');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'euc-kr').decode(nameBytes);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : null;
    if (!data) throw new Error(`지원하지 않는 ZIP 압축 방식입니다. (${method})`);
    entries.push({ name, data });
  }
  return entries;
}

async function uniqueFilePath(folderState, parts) {
  const parent = resolve(folderState.path, ...parts.slice(0, -1));
  const root = resolve(folderState.path);
  if (parent !== root && !parent.startsWith(`${root}${sep}`)) throw new Error('허용되지 않은 ZIP 내부 경로입니다.');
  await mkdir(parent, { recursive: true });
  const original = parts.at(-1);
  const extension = extname(original);
  const stem = extension ? original.slice(0, -extension.length) : original;
  let candidate = join(parent, original);
  let suffix = 2;
  while (folderState.used.has(candidate.toLowerCase()) || await access(candidate).then(() => true).catch(() => false)) {
    candidate = join(parent, `${stem}_${suffix}${extension}`);
    suffix++;
  }
  folderState.used.add(candidate.toLowerCase());
  return candidate;
}

async function saveZipToFolder(fileBytes, folderState) {
  const bytes = new Uint8Array(fileBytes);
  const entries = readZipEntries(bytes);
  const saved = [];
  for (const entry of entries) {
    const parts = entry.name.replaceAll('\\', '/').split('/').filter((part) => part && part !== '.' && part !== '..').map((part) => part.replace(/[<>:"|?*]/g, '_'));
    if (!parts.length) continue;
    const outputPath = await uniqueFilePath(folderState, parts);
    await writeFile(outputPath, entry.data);
    saved.push(outputPath);
  }
  return saved;
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function readBytes(req, limit = 80 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('파일은 80MB 이하여야 합니다.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

function validateXlsx(bytes, fileName) {
  if (!bytes.length) throw new Error(`${fileName}: 파일 크기가 0바이트입니다. 1단계에서 다시 다운로드해 주세요.`);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(`${fileName}: 정상적인 XLSX 파일이 아닙니다. 확장자만 XLSX이거나 다운로드가 완료되지 않은 파일입니다.`);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, x-openapi-key, x-openai-api-key, x-file-name');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/health') {
      await databaseReady;
      const storageMode = bucketEnabled ? 'bucket' : databaseState.connected ? 'postgres' : 'response-only';
      return json(res, 200, { ok: true, database: { enabled: databaseState.enabled, connected: databaseState.connected, error: databaseState.error || null }, bucket: { enabled: bucketEnabled }, storage: { mode: storageMode } });
    }
    if (req.method === 'POST' && url.pathname === '/api/web/clean') {
      const fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'source.xlsx'));
      const source = await readBytes(req);
      validateXlsx(source, fileName);
      const id = randomUUID();
      const originalKey = `original/${id}/${fileName}`;
      const result = await cleanWorkbook(source, fileName);
      await persistStoredFile(id, 'original', fileName, originalKey, source, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const cleanKey = `clean/${id}/${result.name}`;
      await persistStoredFile(randomUUID(), 'clean', result.name, cleanKey, result.bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.writeHead(200, { 'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-output-name':encodeURIComponent(result.name), 'content-length':result.bytes.length });
      return res.end(result.bytes);
    }
    if (req.method === 'POST' && url.pathname === '/api/web/dashboard') {
      const fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'clean.xlsx'));
      const source = await readBytes(req); validateXlsx(source, fileName); const id = randomUUID();
      const aiAnalysis=await createAiAnalysis(source,fileName,String(req.headers['x-openai-api-key']||'').trim());
      const result = await dashboardFromWorkbook(source, fileName, aiAnalysis);
      const dashboardKey = `dashboard/${id}/${result.name}`;
      await persistStoredFile(id, 'dashboard', result.name, dashboardKey, result.bytes, 'text/html; charset=utf-8');
      res.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'x-output-name':encodeURIComponent(result.name), 'content-length':result.bytes.length });
      return res.end(result.bytes);
    }
    if (req.method === 'GET' && url.pathname === '/api/catalog') {
      const requested = (url.searchParams.get('schools') || '01,02,03,04').split(',').filter((x) => SCHOOL_TYPES[x]);
      const items = await cachedCatalog(requested);
      return json(res, 200, { items, fetchedAt: new Date().toISOString() });
    }
    if (req.method === 'POST' && url.pathname === '/api/download') {
      const body = await readJson(req);
      let file;
      try {
        file = await createDownload(body.items, body.meta || {});
        await recordDownload(body.items || [], body.meta || {}, 'success');
      } catch (error) {
        await recordDownload(body.items || [], body.meta || {}, 'failed', error.message);
        throw error;
      }
      res.writeHead(200, { 'content-type': file.contentType, 'content-disposition': file.disposition, 'content-length': file.bytes.length });
      return res.end(file.bytes);
    }
    if (req.method === 'POST' && url.pathname === '/api/cancel-operation') {
      const body = await readJson(req);
      const operationId = String(body.operationId || '');
      const child = runningOperations.get(operationId);
      if (!child) return json(res, 200, { cancelled: false, finished: true });
      runningOperations.delete(operationId);
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      return json(res, 200, { cancelled: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/select-folder') {
      const folderPath = await chooseWindowsFolder();
      if (!folderPath) return json(res, 200, { cancelled: true });
      const token = randomUUID();
      selectedFolders.set(token, { path: resolve(folderPath), used: new Set(), completed: new Map(), selectedAt: Date.now() });
      return json(res, 200, { token, path: folderPath });
    }
    if (req.method === 'POST' && url.pathname === '/api/select-clean-folder') {
      const folderPath = await chooseWindowsFolder('정제할 XLSX 원본 파일이 있는 폴더를 선택하세요.');
      if (!folderPath) return json(res, 200, { cancelled: true });
      const token = randomUUID();
      selectedFolders.set(token, { path: resolve(folderPath), used: new Set(), completed: new Map(), selectedAt: Date.now() });
      return json(res, 200, { token, path: folderPath });
    }
    if (req.method === 'POST' && url.pathname === '/api/select-dashboard-folder') {
      const folderPath = await chooseWindowsFolder('정제 폴더가 있는 원본 폴더를 선택하세요.');
      if (!folderPath) return json(res, 200, { cancelled: true });
      const token = randomUUID();
      selectedFolders.set(token, { path: resolve(folderPath), used: new Set(), completed: new Map(), selectedAt: Date.now() });
      return json(res, 200, { token, path: folderPath });
    }
    if (req.method === 'POST' && url.pathname === '/api/list-dashboard-files') {
      const body = await readJson(req);
      const folderState = selectedFolders.get(body.folderToken);
      if (!folderState) return json(res, 400, { error: '대시보드 폴더를 다시 선택해 주세요.' });
      const inputFolder = await dashboardInputFolder(folderState.path);
      const files = (await readdir(inputFolder, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && ['.xlsx', '.xls'].includes(extname(entry.name).toLowerCase()) && !entry.name.startsWith('~$'))
        .map((entry) => entry.name);
      if (!files.length) return json(res, 400, { error: '선택한 폴더 또는 하위 정제 폴더에 Excel 파일이 없습니다.' });
      return json(res, 200, { files, input: inputFolder, output: join(basename(inputFolder) === '정제' ? dirname(inputFolder) : dirname(inputFolder), '대시보드') });
    }
    if (req.method === 'POST' && url.pathname === '/api/clean-folder') {
      const body = await readJson(req);
      const folderState = selectedFolders.get(body.folderToken);
      if (!folderState) return json(res, 400, { error: '원본 폴더를 다시 선택해 주세요.' });
      const scriptPath = fileURLToPath(new URL('./scripts/clean-excel-folder.ps1', import.meta.url));
      const quotePs = (value) => `'${String(value).replaceAll("'", "''")}'`;
      const command = `$cleaner=[scriptblock]::Create([IO.File]::ReadAllText(${quotePs(scriptPath)},[Text.Encoding]::UTF8)); & $cleaner -SourceFolder ${quotePs(folderState.path)}`;
      const { stdout } = await runPowerShell(command, String(body.operationId || ''));
      const resultLine = stdout.trim().split(/\r?\n/).findLast((line) => line.trim().startsWith('{'));
      if (!resultLine) throw new Error('정제 결과를 확인할 수 없습니다.');
      return json(res, 200, JSON.parse(resultLine));
    }
    if (req.method === 'POST' && url.pathname === '/api/create-dashboards') {
      const body = await readJson(req);
      const folderState = selectedFolders.get(body.folderToken);
      if (!folderState) return json(res, 400, { error: '원본 폴더를 다시 선택해 주세요.' });
      const mode = body.mode === 'combined' ? 'combined' : 'individual';
      const fileName = String(body.fileName || '');
      if (fileName && basename(fileName) !== fileName) return json(res, 400, { error: '허용되지 않은 파일명입니다.' });
      const scriptPath = fileURLToPath(new URL('./scripts/create-dashboards.ps1', import.meta.url));
      const templatePath = fileURLToPath(new URL('./scripts/dashboard-template.html', import.meta.url));
      const quotePs = (value) => `'${String(value).replaceAll("'", "''")}'`;
      const fileArgument = fileName ? ` -FileName ${quotePs(fileName)}` : '';
      const command = `$maker=[scriptblock]::Create([IO.File]::ReadAllText(${quotePs(scriptPath)},[Text.Encoding]::UTF8)); & $maker -SourceFolder ${quotePs(folderState.path)} -Mode ${quotePs(mode)} -TemplatePath ${quotePs(templatePath)}${fileArgument}`;
      const { stdout } = await runPowerShell(command, String(body.operationId || ''));
      const resultLine = stdout.trim().split(/\r?\n/).findLast((line) => line.trim().startsWith('{'));
      if (!resultLine) throw new Error('대시보드 생성 결과를 확인할 수 없습니다.');
      return json(res, 200, JSON.parse(resultLine));
    }
    if (req.method === 'POST' && url.pathname === '/api/save-files') {
      const body = await readJson(req);
      const folderState = selectedFolders.get(body.folderToken);
      if (!folderState) return json(res, 400, { error: '저장 폴더를 다시 선택해 주세요.' });
      const batchKey = String(body.batchKey || '');
      if (batchKey && folderState.completed.has(batchKey)) return json(res, 200, { ...folderState.completed.get(batchKey), repeated: true });
      let file;
      try {
        file = await createDownload(body.items, body.meta || {});
        await recordDownload(body.items || [], body.meta || {}, 'success');
      } catch (error) {
        await recordDownload(body.items || [], body.meta || {}, 'failed', error.message);
        throw error;
      }
      const saved = await saveZipToFolder(file.bytes, folderState);
      const result = { count: saved.length, files: saved.map((path) => path.slice(folderState.path.length + 1)) };
      if (batchKey) folderState.completed.set(batchKey, result);
      return json(res, 200, result);
    }
    if (req.method !== 'GET') return json(res, 404, { error: '찾을 수 없습니다.' });
    let pathname;
    try { pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
    catch { return json(res, 400, { error: '올바르지 않은 파일 경로입니다.' }); }
    const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(ROOT, safePath);
    if (!filePath.startsWith(ROOT)) return json(res, 403, { error: '허용되지 않은 경로입니다.' });
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store, max-age=0' });
    res.end(data);
  } catch (error) {
    if (error.code === 'ENOENT') return json(res, 404, { error: '찾을 수 없습니다.' });
    console.error(error);
    json(res, 500, { error: error.message || '처리 중 오류가 발생했습니다.' });
  }
});

server.listen(PORT, () => console.log(`대학알리미 일괄 다운로드: http://localhost:${PORT}`));
