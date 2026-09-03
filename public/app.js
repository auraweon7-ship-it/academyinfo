const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const SETTINGS_KEY = 'academy-data-settings-v1';
const CHECKPOINT_KEY = 'academy-data-checkpoint-v1';
const HISTORY_KEY = 'academy-data-history-v1';
const savedSettings = (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; } })();
const state = { items: [], filtered: [], downloading: false, downloadCancelled: false, downloadController: null, scanController: null, directoryHandle: null, browserDownloadFallback: false, folderToken: null, folderPath: '', resumeRequested: false, cleanFolderToken: null, cleanFolderPath: '', cleanDirectoryHandle: null, cleanFolderExplicit: false, cleaning: false, cleanOperationId: null, cleanController: null, cleanRetryFiles: new Map(), cleanResult: null, dashboardFolderToken: null, dashboardFolderPath: '', dashboardDirectoryHandle: null, dashboardFolderExplicit: false, dashboarding: false, dashboardOperationId: null, dashboardController: null, dashboardRetryFiles: new Map(), dashboardResult: null, settings: { openApiKey: savedSettings.openApiKey || '', openAiApiKey: savedSettings.openAiApiKey || '', apiServerUrl: savedSettings.apiServerUrl || '' } };

function readLocal(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || '') || fallback; } catch { return fallback; } }
function writeLocal(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
function addHistory(stage, status, detail) {
  const history = readLocal(HISTORY_KEY, []);
  history.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), stage, status, detail });
  writeLocal(HISTORY_KEY, history.slice(0, 30)); renderHistory();
}
function renderHistory() {
  const node = $('#operationHistory'); if (!node) return;
  const history = readLocal(HISTORY_KEY, []);
  node.innerHTML = history.length ? history.map(item => `<div class="history-row ${item.status === '실패' ? 'error' : ''}"><time>${new Date(item.at).toLocaleString('ko-KR')}</time><strong>${escapeHtml(item.stage)}</strong><span>${escapeHtml(item.status)}</span><p>${escapeHtml(item.detail)}</p></div>`).join('') : '<p class="empty-history">아직 실행한 작업이 없습니다.</p>';
}
function checkpointSignature() { return `${state.folderPath || state.directoryHandle?.name || 'default'}:` + selectedSchools().sort().join(',') + ':' + state.items.map(item => `${item.schoolCode}-${item.id || item.itemId || item.name}`).join('|'); }
function updateResumeUi() {
  const checkpoint = readLocal(CHECKPOINT_KEY, null), button = $('#resumeButton'), summary = $('#resumeSummary'); if (!button || !summary) return;
  if (!checkpoint || checkpoint.done) { summary.textContent = '저장된 체크포인트가 없습니다.'; button.disabled = true; return; }
  summary.textContent = `${checkpoint.completed.length}/${checkpoint.total}개 묶음 완료 · ${checkpoint.failed.length}개 재시도 대기`;
  button.disabled = false;
}
function initializeExampleLinks(){
  const base=location.protocol==='file:'||location.hostname.endsWith('github.io')?'./public/examples/':'./examples/';
  $$('[data-example-file]').forEach(link=>{link.href=new URL(base+encodeURIComponent(link.dataset.exampleFile),location.href).href;});
}
const LOCAL_FOLDER_APIS = new Set(['/api/select-folder', '/api/save-files', '/api/select-clean-folder', '/api/clean-folder', '/api/select-dashboard-folder', '/api/list-dashboard-files', '/api/create-dashboards', '/api/cancel-operation']);
const apiUrl = (path) => {
  const pathname = path.split('?')[0];
  if (location.protocol === 'file:' && LOCAL_FOLDER_APIS.has(pathname)) return `http://localhost:4173${path}`;
  const customServer = state.settings.apiServerUrl.trim().replace(/\/$/, '');
  if (customServer) return `${customServer}${path}`;
  return location.protocol === 'file:' ? `http://localhost:4173${path}` : path;
};
const apiHeaders = (path, headers = {}) => ({ ...headers, ...(state.settings.openApiKey ? {'x-openapi-key':state.settings.openApiKey}:{}), ...(path==='/api/web/dashboard'&&state.settings.openAiApiKey ? {'x-openai-api-key':state.settings.openAiApiKey}:{}) });
async function requestApi(path, options = {}) {
  try {
    return await fetch(apiUrl(path), { ...options, headers: apiHeaders(path, options.headers) });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('로컬 앱 서버에 연결할 수 없습니다. start.cmd를 실행한 뒤 다시 시도해 주세요.');
  }
}

async function readApiJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch {
    if (/^\s*</.test(text)) throw new Error('API 대신 웹페이지가 응답했습니다. 설정의 API 서버 주소를 확인하거나 start.cmd를 실행해 주세요.');
    throw new Error(`서버 응답을 읽을 수 없습니다. (HTTP ${response.status})`);
  }
}

function selectedSchools() { return $$('.school-grid input:checked').map((input) => input.value); }
function batches(items, size = 10) {
  const bySchool = new Map();
  for (const item of items) {
    if (!bySchool.has(item.schoolCode)) bySchool.set(item.schoolCode, []);
    bySchool.get(item.schoolCode).push(item);
  }
  return [...bySchool.values()].flatMap((schoolItems) =>
    Array.from({ length: Math.ceil(schoolItems.length / size) }, (_, index) => schoolItems.slice(index * size, index * size + size))
  );
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function itemFileName(item){return item.fileName||`${item.year}년__${item.schoolName}_${item.name}_학교별자료.xlsx`.replace(/[<>:"/\\|?*]/g,'_');}
function itemKey(item){return `${item.schoolCode}:${item.id}`;}
function normalizedFileLabel(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/학교별자료|\.xlsx?$|[^0-9a-z가-힣]/g,'');}
function updateDownloadCounts(){
  const total=state.items.length,success=state.items.filter(item=>item.downloadStatus==='success').length,failed=state.items.filter(item=>item.downloadStatus==='failed').length;
  $('#dockTotalCount').textContent=total.toLocaleString('ko-KR');$('#dockSuccessCount').textContent=success.toLocaleString('ko-KR');$('#dockFailedCount').textContent=failed.toLocaleString('ko-KR');
}
function updateItemDownloadStatus(item,status,message=''){
  item.downloadStatus=status;item.downloadMessage=message;
  updateDownloadCounts();
  const row=$(`#tableWrap tr[data-item-key="${CSS.escape(itemKey(item))}"]`);if(!row)return;
  const badge=row.querySelector('.item-download-status');badge.className=`item-download-status ${status}`;badge.textContent={pending:'대기',running:'진행 중',success:'성공',failed:'실패'}[status]||'대기';badge.title=message;
  const button=row.querySelector('.item-download-button');button.disabled=status==='running'||state.downloading;button.textContent=status==='success'?'다시 받기':status==='failed'?'재시도':'다운로드';
}
function markGroupDownloadResult(group,fileNames){
  const labels=(fileNames||[]).map(normalizedFileLabel).filter(Boolean);
  for(const item of group){const tokens=[item.name,itemFileName(item)].map(normalizedFileLabel).filter(Boolean);const matched=labels.some(label=>tokens.some(token=>token.length>3&&(label.includes(token)||token.includes(label))));updateItemDownloadStatus(item,matched?'success':'failed',matched?'파일 저장 완료':'ZIP에 해당 항목 파일이 없어 개별 재시도가 필요합니다.');}
}
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.add('show'); setTimeout(() => node.classList.remove('show'), 2800); }
function showStop(id, show) { $(id).classList.toggle('hidden', !show); }
function setRunning(selector, running) {
  const node = $(selector);
  if (!node) return;
  node.classList.toggle('is-running', running);
  node.setAttribute('aria-busy', String(running));
}

function initializeHeroCarousel() {
  const carousel=$('#heroCarousel'),slides=$$('.hero-slide'),dots=$$('.hero-dots button');if(!carousel||slides.length<2)return;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;let current=0,timer;
  const show=(index,userInitiated=false)=>{current=(index+slides.length)%slides.length;slides.forEach((slide,i)=>{const active=i===current;slide.classList.toggle('is-active',active);slide.setAttribute('aria-hidden',String(!active));});dots.forEach((dot,i)=>{const active=i===current;dot.classList.remove('is-active');dot.setAttribute('aria-selected',String(active));if(active){void dot.offsetWidth;dot.classList.add('is-active');}});$('#heroCurrent').textContent=String(current+1).padStart(2,'0');if(userInitiated)restart();};
  const stop=()=>{if(timer){clearInterval(timer);timer=null;}};const start=()=>{if(!reduced&&!timer)timer=setInterval(()=>show(current+1),6500)};const restart=()=>{stop();start()};
  $('#heroPrev').addEventListener('click',()=>show(current-1,true));$('#heroNext').addEventListener('click',()=>show(current+1,true));dots.forEach((dot,index)=>dot.addEventListener('click',()=>show(index,true)));
  carousel.addEventListener('mouseenter',stop);carousel.addEventListener('mouseleave',start);carousel.addEventListener('focusin',stop);carousel.addEventListener('focusout',(event)=>{if(!carousel.contains(event.relatedTarget))start();});
  carousel.addEventListener('keydown',(event)=>{if(event.key==='ArrowLeft')show(current-1,true);if(event.key==='ArrowRight')show(current+1,true);});document.addEventListener('visibilitychange',()=>document.hidden?stop():start());show(0);start();
}

function updateSettingsIndicator() {
  $('#settingsButton').classList.toggle('configured', Boolean(state.settings.openApiKey || state.settings.openAiApiKey));
  $('#settingsButton').title = state.settings.openAiApiKey ? 'OpenAI 분석 기능이 설정되어 있습니다.' : '연결 설정';
}

function openSettings() {
  $('#openApiKey').value = state.settings.openApiKey;
  $('#openAiApiKey').value = state.settings.openAiApiKey;
  $('#apiServerUrl').value = state.settings.apiServerUrl;
  $('#openApiKey').type = 'password';
  $('#toggleApiKey').textContent = '표시';
  $('#settingsMessage').className = 'settings-message';
  $('#settingsMessage').textContent = '입력한 인증키는 이 브라우저에만 저장됩니다.';
  $('#settingsDialog').showModal();
  setTimeout(() => $('#openApiKey').focus(), 60);
}

function saveSettings(event) {
  event.preventDefault();
  const openApiKey = $('#openApiKey').value.trim();
  const openAiApiKey = $('#openAiApiKey').value.trim();
  let apiServerUrl = $('#apiServerUrl').value.trim().replace(/\/$/, '');
  if (apiServerUrl) {
    try {
      const parsed = new URL(apiServerUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      apiServerUrl = parsed.origin + parsed.pathname.replace(/\/$/, '');
    } catch {
      $('#settingsMessage').className = 'settings-message error';
      $('#settingsMessage').textContent = 'API 서버 주소를 http:// 또는 https:// 형식으로 입력해 주세요.';
      return;
    }
  }
  state.settings = { openApiKey, openAiApiKey, apiServerUrl };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  updateSettingsIndicator();
  $('#settingsDialog').close();
  toast(openAiApiKey ? 'OpenAI 대시보드 분석 설정을 저장했습니다.' : openApiKey ? 'OpenAPI 설정을 저장했습니다.' : '연결 설정을 저장했습니다.');
}

function clearSettings() {
  state.settings = { openApiKey: '', openAiApiKey: '', apiServerUrl: '' };
  localStorage.removeItem(SETTINGS_KEY);
  $('#openApiKey').value = '';
  $('#openAiApiKey').value = '';
  $('#apiServerUrl').value = '';
  updateSettingsIndicator();
  $('#settingsMessage').className = 'settings-message';
  $('#settingsMessage').textContent = '저장된 설정을 삭제했습니다.';
}
async function cancelServerOperation(operationId) {
  if (!operationId) return;
  await requestApi('/api/cancel-operation', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ operationId }) }).catch(() => {});
}

function setFolderDownloadEnabled(enabled) {
  const button = $('#downloadButton');
  button.disabled = !enabled;
  button.toggleAttribute('disabled', !enabled);
  button.setAttribute('aria-disabled', String(!enabled));
}

function applyStageOneFolderDefaults() {
  const name=state.folderPath||state.directoryHandle?.name;if(!name)return;
  if(!state.cleanFolderExplicit){state.cleanDirectoryHandle=state.directoryHandle;state.cleanFolderToken=state.folderToken;state.cleanFolderPath=name;$('#cleanFolderPath').textContent=`${name} (1단계 폴더)`;$('#cleanFolderPath').title=name;$('#cleanFolderButton').firstChild.textContent='원본 폴더 변경 ';$('#cleanStartButton').disabled=false;setCleanStatus('','1단계 폴더 자동 선택',`${name} 하위에 정제 폴더를 생성합니다.`);}
  if(!state.dashboardFolderExplicit){state.dashboardDirectoryHandle=state.directoryHandle;state.dashboardFolderToken=state.folderToken;state.dashboardFolderPath=name;$('#dashboardFolderPath').textContent=`${name} (1단계 폴더)`;$('#dashboardFolderPath').title=name;$('#dashboardFolderButton').firstChild.textContent='원본 폴더 변경 ';$('#dashboardStartButton').disabled=false;setDashboardStatus('','1단계 폴더 자동 선택',`${name} 하위의 정제 폴더를 사용하고 대시보드 폴더를 생성합니다.`);}
}

async function fetchZip(group) {
  const response = await requestApi('/api/download', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    signal: state.downloadController?.signal,
    body: JSON.stringify({ items: group, meta: { userCode: $('#userCode').value, purposeCode: $('#purposeCode').value, detail: $('#detail').value.trim() } })
  });
  if (!response.ok) { const data = await readApiJson(response); throw new Error(data.error); }
  return response.blob();
}

async function saveBatchToSelectedFolder(group, batchKey) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await requestApi('/api/save-files', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        signal: state.downloadController?.signal,
        body: JSON.stringify({ folderToken: state.folderToken, batchKey, items: group, meta: { userCode: $('#userCode').value, purposeCode: $('#purposeCode').value, detail: $('#detail').value.trim() } })
      });
      const data = await readApiJson(response);
      if (!response.ok) throw new Error(data.error);
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        $('#dockDetail').textContent = `연결이 끊겨 묶음을 다시 요청합니다. 재시도 ${attempt} / 2`;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
      }
    }
  }
  throw lastError;
}

function decodeZipName(bytes, utf8) {
  return new TextDecoder(utf8 ? 'utf-8' : 'euc-kr').decode(bytes);
}

async function inflateRaw(bytes) {
  if (!('DecompressionStream' in window)) throw new Error('이 브라우저는 ZIP 압축 해제를 지원하지 않습니다.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function extractZip(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('ZIP 파일 구조를 읽을 수 없습니다.');
  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let index = 0; index < entryCount; index++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('ZIP 항목 정보가 손상되었습니다.');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decodeZipName(bytes.slice(cursor + 46, cursor + 46 + nameLength), Boolean(flags & 0x800));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('ZIP 파일 데이터가 손상되었습니다.');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = await inflateRaw(compressed);
    else throw new Error(`지원하지 않는 ZIP 압축 방식입니다. (${method})`);
    entries.push({ name, data });
  }
  return entries;
}

async function writeEntry(root, entry, usedNames) {
  const safeParts = entry.name.replaceAll('\\', '/').split('/').filter((part) => part && part !== '.' && part !== '..').map((part) => part.replace(/[<>:"|?*]/g, '_'));
  if (!safeParts.length) return;
  let fileName = safeParts.at(-1);
  const key = safeParts.join('/').toLowerCase();
  const duplicate = usedNames.get(key) || 0;
  usedNames.set(key, duplicate + 1);
  if (duplicate) {
    const dot = fileName.lastIndexOf('.');
    fileName = dot > 0 ? `${fileName.slice(0, dot)}_${duplicate + 1}${fileName.slice(dot)}` : `${fileName}_${duplicate + 1}`;
  }
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt++) {
    let writable;
    try {
      let directory = root;
      for (const part of safeParts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
      const fileHandle = await directory.getFileHandle(fileName, { create: true });
      writable = await fileHandle.createWritable({ keepExistingData: false });
      await writable.write(entry.data);
      await writable.close();
      await new Promise((resolve) => setTimeout(resolve, 70));
      return;
    } catch (error) {
      lastError = error;
      if (writable) await writable.abort().catch(() => {});
      const transient = error.name === 'InvalidStateError' || error.name === 'NotFoundError' || /state cached|changed since|interface object/i.test(error.message || '');
      if (!transient || attempt === 6) break;
      $('#dockDetail').textContent = `${fileName} 저장 상태가 변경되어 다시 시도합니다. (${attempt}/5)`;
      await new Promise((resolve) => setTimeout(resolve, 180 * attempt));
    }
  }
  throw new Error(`${fileName} 저장 실패: ${lastError?.message || '파일을 쓸 수 없습니다.'}`);
}

function renderTable(items) {
  if (!items.length) { $('#tableWrap').innerHTML = '<div class="empty">조건에 맞는 공시 항목이 없습니다.</div>'; return; }
  $('#tableWrap').innerHTML = `<table><thead><tr><th>NO.</th><th>학교 종류</th><th>분류</th><th>파일명</th><th>선택 연도</th><th>다운로드 상태</th><th>개별 다운로드</th></tr></thead><tbody>${items.map((item, index) => {const status=item.downloadStatus||'pending';return `<tr data-item-key="${escapeHtml(itemKey(item))}"><td>${String(index + 1).padStart(3, '0')}</td><td>${escapeHtml(item.schoolName)}</td><td>${escapeHtml(item.categoryName)}</td><td title="${escapeHtml(item.name)}">${escapeHtml(itemFileName(item))}</td><td><span class="year-badge ${item.fallback ? 'fallback' : ''}">${item.year}${item.fallback ? ' 대체' : ''}</span></td><td><span class="item-download-status ${status}" title="${escapeHtml(item.downloadMessage||'')}">${{pending:'대기',running:'진행 중',success:'성공',failed:'실패'}[status]||'대기'}</span></td><td><button class="item-download-button" data-download-item="${escapeHtml(itemKey(item))}" ${status==='running'||state.downloading?'disabled':''}>${status==='success'?'다시 받기':status==='failed'?'재시도':'다운로드'}</button></td></tr>`;}).join('')}</tbody></table>`;
}

function renderSummary() {
  const fallback = state.items.filter((item) => item.fallback).length;
  $('#totalCount').textContent = state.items.length.toLocaleString('ko-KR');
  $('#currentCount').textContent = (state.items.length - fallback).toLocaleString('ko-KR');
  $('#fallbackCount').textContent = fallback.toLocaleString('ko-KR');
  $('#batchCount').textContent = `${state.items.length}개 항목 · ${batches(state.items).length}개 ZIP 묶음`;
  $('#downloadButtonLabel').textContent = state.folderToken || state.directoryHandle || state.browserDownloadFallback ? `${state.items.length}개 파일 저장` : '폴더를 먼저 선택해 주세요';
  setFolderDownloadEnabled(Boolean(state.folderToken || state.directoryHandle || state.browserDownloadFallback));
  state.filtered = state.items;
  updateDownloadCounts();
  renderTable(state.filtered);
}

async function scan() {
  const schools = selectedSchools();
  $('#formError').textContent = '';
  if (!schools.length) { $('#formError').textContent = '학교 종류를 하나 이상 선택해 주세요.'; return false; }
  if (!$('#detail').value.trim()) { $('#formError').textContent = '상세 내용을 입력해 주세요.'; return false; }
  if (location.hostname.endsWith('github.io') && !state.settings.apiServerUrl) {
    const message = 'GitHub Pages에서 다운로드하려면 설정에 별도로 배포한 API 서버 주소가 필요합니다.';
    $('#formError').textContent = message;
    $('#dockStatus').textContent = 'API 서버 설정 필요';
    $('#dockDetail').textContent = '오른쪽 위 설정에서 Node API 서버의 HTTPS 주소를 입력해 주세요.';
    $('#downloadButtonLabel').textContent = state.browserDownloadFallback ? 'API 서버 설정 후 다운로드' : '폴더를 먼저 선택해 주세요';
    openSettings();
    $('#settingsMessage').className = 'settings-message error';
    $('#settingsMessage').textContent = message;
    return false;
  }
  const button = $('#scanButton');
  state.scanController = new AbortController(); showStop('#scanStopButton', true);
  setRunning('#step-download', true);
  button.disabled = true; button.querySelector('span').textContent = '대학알리미 확인 중';
  $('#results').classList.remove('hidden');
  $('#tableWrap').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const response = await requestApi(`/api/catalog?schools=${schools.join(',')}`, { signal: state.scanController.signal });
    const data = await readApiJson(response);
    if (!response.ok) throw new Error(data.error);
    state.items = data.items.map((item) => ({ ...item, downloadStatus:'pending', downloadMessage:'' }));
    renderSummary();
    toast(`${state.items.length}개 항목을 찾았습니다.`);
    return true;
  } catch (error) {
    if (error.name === 'AbortError') { $('#formError').textContent = '항목 조회를 중단했습니다.'; return false; }
    state.items = []; renderSummary(); $('#formError').textContent = error.message || '목록을 가져오지 못했습니다.';
    return false;
  } finally {
    state.scanController = null; showStop('#scanStopButton', false); setRunning('#step-download', false); button.disabled = false; button.querySelector('span').textContent = '전체 항목 다시 조회';
  }
}

async function downloadAll() {
  if (!state.items.length || state.downloading) return;
  state.downloading = true;
  state.downloadCancelled = false; state.downloadController = new AbortController(); showStop('#downloadStopButton', true);
  setRunning('#step-download', true); setRunning('#downloadDock', true);
  const button = $('#zipButton'); button.disabled = true;
  $('#downloadButton').disabled = true;
  const groups = batches(state.items);
  let completed = 0;
  let completedItems = 0;
  try {
    for (let index = 0; index < groups.length; index++) {
      if (state.downloadCancelled) throw new DOMException('다운로드 중단', 'AbortError');
      const group = groups[index];
      group.forEach((item) => updateItemDownloadStatus(item, 'running', 'ZIP 파일 생성 중'));
      $('#dockStatus').textContent = `전체 자동 다운로드 ${index + 1} / ${groups.length}`;
      $('#dockDetail').textContent = `${group[0].schoolName} · ${group.length}개 항목의 ZIP 파일을 생성하고 있습니다.`;
      const blob = await fetchZip(group);
      const entries = await extractZip(blob);
      markGroupDownloadResult(group, entries.map((entry) => entry.name));
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href; link.download = `대학알리미_${group[0].schoolName}_${String(index + 1).padStart(2, '0')}.zip`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 5000);
      completed++; completedItems += group.length;
      $('#dockStatus').textContent = `ZIP 다운로드 누적 ${completedItems} / ${state.items.length}개`;
      $('#dockDetail').textContent = `${completed} / ${groups.length}개 ZIP 묶음을 내려받았습니다.`;
      if (index < groups.length - 1) await new Promise((resolve) => setTimeout(resolve, 450));
    }
    $('#dockStatus').textContent = '다운로드 완료';
    $('#dockDetail').textContent = `전체 ${state.items.length}개 항목을 ${completed}개 ZIP 파일로 저장했습니다.`;
    toast('모든 파일 다운로드가 완료되었습니다.');
  } catch (error) {
    state.items.filter((item) => item.downloadStatus === 'running').forEach((item) => updateItemDownloadStatus(item, 'failed', error.message || '다운로드 실패'));
    $('#dockStatus').textContent = error.name === 'AbortError' ? '사용자가 다운로드를 중단했습니다' : '다운로드 중단';
    $('#dockDetail').textContent = `${completed}개 완료 · ${error.name === 'AbortError' ? '중단 요청이 적용되었습니다.' : error.message || '오류가 발생했습니다.'}`;
  } finally { state.downloading = false; state.downloadController = null; showStop('#downloadStopButton', false); setRunning('#step-download', false); setRunning('#downloadDock', false); button.disabled = false; setFolderDownloadEnabled(Boolean(state.folderToken || state.directoryHandle || state.browserDownloadFallback)); renderTable(state.filtered); }
}

async function selectDirectory() {
  try {
    $('#folderButton').disabled = true;
    $('#folderButton').textContent = '폴더 선택 창 여는 중';
    if (location.protocol === 'https:') {
      if (!('showDirectoryPicker' in window)) {
        state.browserDownloadFallback = true;
        state.directoryHandle = null;
        state.folderToken = null;
        state.folderPath = '브라우저 기본 다운로드 폴더';
        $('#folderButton').textContent = '기본 다운로드 폴더 사용 중';
        $('#folderPath').textContent = state.folderPath;
        $('#folderPath').title = '브라우저 설정에 지정된 다운로드 폴더';
        $('#downloadButtonLabel').textContent = state.items.length ? `${state.items.length}개 파일 다운로드` : '조회 후 개별 파일 다운로드';
        setFolderDownloadEnabled(true);
        $('#dockStatus').textContent = '브라우저 다운로드 폴더 사용';
        $('#dockDetail').textContent = '폴더 선택을 지원하지 않아 브라우저의 기본 다운로드 폴더에 개별 파일로 저장합니다.';
        toast('브라우저 기본 다운로드 폴더를 사용합니다.');
        return;
      }
      const handle = await window.showDirectoryPicker({ id: 'academy-data-output', mode: 'readwrite', startIn: 'downloads' });
      state.directoryHandle = handle;
      state.browserDownloadFallback = false;
      state.folderToken = null;
      state.folderPath = handle.name;
      $('#folderButton').textContent = '저장 폴더 변경';
      $('#folderPath').textContent = handle.name;
      $('#folderPath').title = `선택한 폴더: ${handle.name}`;
      $('#downloadButtonLabel').textContent = state.items.length ? `${state.items.length}개 파일 저장` : '조회 후 선택 폴더에 저장';
      setFolderDownloadEnabled(true);
      $('#dockStatus').textContent = '저장 폴더 지정 완료';
      $('#dockDetail').textContent = `${handle.name} 폴더에 압축 없이 개별 파일로 저장합니다.`;
      applyStageOneFolderDefaults();
      toast('저장 폴더가 지정되었습니다. 다운로드 버튼을 눌러 주세요.');
      return;
    }
    const response = await requestApi('/api/select-folder', { method: 'POST' });
    const data = await readApiJson(response);
    if (!response.ok) throw new Error(data.error);
    if (data.cancelled) return;
    state.folderToken = data.token;
    state.folderPath = data.path;
    state.directoryHandle = null;
    $('#folderButton').textContent = '저장 폴더 변경';
    $('#folderPath').textContent = data.path;
    $('#folderPath').title = data.path;
    $('#downloadButtonLabel').textContent = state.items.length ? `${state.items.length}개 파일 저장` : '조회 후 선택 폴더에 저장';
    setFolderDownloadEnabled(true);
    $('#dockStatus').textContent = '저장 폴더 지정 완료';
    $('#dockDetail').textContent = `${data.path}에 압축 없이 개별 파일로 저장합니다.`;
    applyStageOneFolderDefaults();
    toast('저장 폴더가 지정되었습니다. 다운로드 버튼을 눌러 주세요.');
  } catch (error) {
    if (error.name === 'AbortError') return;
    toast(error.message || '폴더를 열 수 없습니다.');
  } finally {
    $('#folderButton').disabled = false;
    if (!state.folderToken && !state.directoryHandle && !state.browserDownloadFallback) $('#folderButton').textContent = '저장 폴더 선택';
  }
}

async function saveUncompressed() {
  if (state.downloading || (!state.folderToken && !state.directoryHandle && !state.browserDownloadFallback)) return;
  if (!state.items.length) {
    $('#dockStatus').textContent = '항목 자동 조회 중';
    $('#dockDetail').textContent = '선택한 학교 종류의 다운로드 대상을 확인하고 있습니다.';
    const scanned = await scan();
    if (!scanned || !state.items.length) {
      if ($('#dockStatus').textContent === '항목 자동 조회 중') {
        $('#dockStatus').textContent = '다운로드 준비 실패';
        $('#dockDetail').textContent = $('#formError').textContent || '공시 항목을 조회하지 못했습니다. 잠시 후 다시 시도해 주세요.';
      }
      $('#downloadButtonLabel').textContent = '다시 시도';
      setFolderDownloadEnabled(Boolean(state.folderToken || state.directoryHandle || state.browserDownloadFallback));
      return;
    }
  }
  state.downloading = true;
  state.downloadCancelled = false; state.downloadController = new AbortController(); showStop('#downloadStopButton', true);
  setRunning('#step-download', true); setRunning('#downloadDock', true);
  const zipButton = $('#downloadButton');
  const folderButton = $('#folderButton');
  const legacyZipButton = $('#zipButton');
  zipButton.disabled = true; folderButton.disabled = true; legacyZipButton.disabled = true;
  const groups = batches(state.items);
  const signature = checkpointSignature();
  const previous = readLocal(CHECKPOINT_KEY, null);
  const resumeThisRun=state.resumeRequested&&previous?.signature===signature&&!previous?.done;state.resumeRequested=false;
  const runId=resumeThisRun&&previous?.runId?previous.runId:crypto.randomUUID();
  const completedGroups = new Set(resumeThisRun ? previous.completed : []);
  const failedGroups = [];
  const usedNames = new Map();
  let savedFiles = 0;
  try {
    for (let index = 0; index < groups.length; index++) {
      if (state.downloadCancelled) throw new DOMException('다운로드 중단', 'AbortError');
      if (completedGroups.has(index)) continue;
      const group = groups[index];
      group.forEach((item) => updateItemDownloadStatus(item, 'running', '개별 파일 저장 중'));
      $('#dockStatus').textContent = `다운로드 누적 ${savedFiles} / ${state.items.length}개 · 묶음 ${index + 1} / ${groups.length}`;
      $('#dockDetail').textContent = `${group[0].schoolName} 자료를 받아 선택한 폴더에 풀고 있습니다.`;
      try { let downloadedNames = []; if (state.folderToken) {
        const data = await saveBatchToSelectedFolder(group, `${runId}-${group[0].schoolCode}-${index}`); savedFiles += data.count;
        downloadedNames = data.files || [];
        $('#dockStatus').textContent = `다운로드 누적 ${savedFiles} / ${state.items.length}개`;
      } else if (state.browserDownloadFallback) {
        const entries = await extractZip(await fetchZip(group));
        downloadedNames = entries.map((entry) => entry.name);
        for (const entry of entries) {
          const fileName = entry.name.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)?.replace(/[<>:"|?*]/g, '_');
          if (!fileName) continue;
          const href = URL.createObjectURL(new Blob([entry.data]));
          const link = document.createElement('a');
          link.href = href; link.download = fileName;
          document.body.append(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(href), 5000);
          savedFiles++;
          $('#dockStatus').textContent = `다운로드 누적 ${savedFiles} / ${state.items.length}개`;
        }
      } else {
        const entries = await extractZip(await fetchZip(group));
        downloadedNames = entries.map((entry) => entry.name);
        for (const entry of entries) {
          await writeEntry(state.directoryHandle, entry, usedNames);
          savedFiles++;
          $('#dockStatus').textContent = `다운로드 누적 ${savedFiles} / ${state.items.length}개`;
        }
      }
      markGroupDownloadResult(group, downloadedNames);
      completedGroups.add(index);
      writeLocal(CHECKPOINT_KEY, { signature, runId, completed:[...completedGroups], failed:failedGroups, total:groups.length, done:false, updatedAt:new Date().toISOString() });
      updateResumeUi();
      } catch (error) { if (error.name === 'AbortError') throw error; group.forEach((item) => updateItemDownloadStatus(item, 'failed', error.message || '다운로드 실패')); failedGroups.push(index); $('#dockDetail').textContent = `${index + 1}번 묶음 실패 — 나머지를 계속 저장합니다.`; }
      if (index < groups.length - 1) await new Promise((resolve) => setTimeout(resolve, 350));
    }
    const done = failedGroups.length === 0;
    writeLocal(CHECKPOINT_KEY, { signature, runId, completed:[...completedGroups], failed:failedGroups, total:groups.length, done, updatedAt:new Date().toISOString() }); updateResumeUi();
    $('#dockStatus').textContent = done ? `개별 파일 저장 완료 · 누적 ${savedFiles}개` : `누적 ${savedFiles}개 · ${failedGroups.length}개 묶음 재시도 필요`;
    $('#dockDetail').textContent = `${state.folderPath || state.directoryHandle?.name}에 ${savedFiles}개 파일을 저장했습니다.${done ? ' ZIP 파일은 남기지 않았습니다.' : ' 운영 센터에서 실패 묶음을 재시도하세요.'}`;
    addHistory('1단계 다운로드', done ? '완료' : '부분 완료', `${savedFiles}개 저장 · 실패 묶음 ${failedGroups.length}개`);
    toast(done ? '선택한 폴더에 개별 파일 저장을 완료했습니다.' : '가능한 파일을 저장했습니다. 실패 묶음은 이어받을 수 있습니다.');
  } catch (error) {
    $('#dockStatus').textContent = error.name === 'AbortError' ? '사용자가 다운로드를 중단했습니다' : '개별 파일 저장 중단';
    $('#dockDetail').textContent = `${savedFiles}개 저장 · ${error.name === 'AbortError' ? '중단 요청이 적용되었습니다.' : error.message || '오류가 발생했습니다.'}`;
    addHistory('1단계 다운로드', error.name === 'AbortError' ? '중단' : '실패', `${savedFiles}개 저장 · ${error.message || ''}`);
  } finally {
    state.downloading = false; state.downloadController = null; showStop('#downloadStopButton', false); setRunning('#step-download', false); setRunning('#downloadDock', false); setFolderDownloadEnabled(true); folderButton.disabled = false; legacyZipButton.disabled = false; renderTable(state.filtered);
  }
}

async function downloadSingle(item) {
  if (!item || state.downloading) return;
  if (!state.folderToken && !state.directoryHandle && !state.browserDownloadFallback) {
    await selectDirectory();
    if (!state.folderToken && !state.directoryHandle && !state.browserDownloadFallback) return;
  }
  state.downloading = true;
  state.downloadCancelled = false;
  state.downloadController = new AbortController();
  updateItemDownloadStatus(item, 'running', '개별 다운로드 요청 중');
  $('#dockStatus').textContent = `개별 다운로드 · ${itemFileName(item)}`;
  $('#dockDetail').textContent = '선택한 항목 하나를 받아 저장하고 있습니다.';
  try {
    let names = [];
    if (state.folderToken) {
      const data = await saveBatchToSelectedFolder([item], `single-${crypto.randomUUID()}`);
      names = data.files || [];
      if (!data.count) throw new Error('저장된 파일이 없습니다.');
    } else {
      const entries = await extractZip(await fetchZip([item]));
      if (!entries.length) throw new Error('ZIP 파일 안에 저장할 데이터가 없습니다.');
      names = entries.map((entry) => entry.name);
      if (state.browserDownloadFallback) {
        for (const entry of entries) {
          const fileName = entry.name.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)?.replace(/[<>:"|?*]/g, '_');
          if (!fileName) continue;
          const href = URL.createObjectURL(new Blob([entry.data]));
          const link = document.createElement('a'); link.href = href; link.download = fileName;
          document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(href), 5000);
        }
      } else {
        const usedNames = new Map();
        for (const entry of entries) await writeEntry(state.directoryHandle, entry, usedNames);
      }
    }
    markGroupDownloadResult([item], names);
    $('#dockStatus').textContent = '개별 다운로드 성공';
    $('#dockDetail').textContent = `${itemFileName(item)} 파일을 저장했습니다.`;
    toast('선택한 항목을 다운로드했습니다.');
  } catch (error) {
    updateItemDownloadStatus(item, 'failed', error.message || '개별 다운로드 실패');
    $('#dockStatus').textContent = error.name === 'AbortError' ? '개별 다운로드 중단' : '개별 다운로드 실패';
    $('#dockDetail').textContent = error.message || '파일을 저장하지 못했습니다.';
  } finally {
    state.downloading = false; state.downloadController = null; renderTable(state.filtered);
  }
}

function setCleanStatus(type, title, detail) {
  const status = $('#cleanStatus');
  status.className = `clean-status ${type || ''}`.trim();
  status.setAttribute('aria-busy', String(type === 'running'));
  setRunning('#step-clean', type === 'running');
  status.querySelector('strong').textContent = title;
  status.querySelector('small').textContent = detail;
}

async function selectCleanFolder() {
  const button = $('#cleanFolderButton');
  try {
    button.disabled = true;
    button.firstChild.textContent = 'Windows 폴더 선택 창 여는 중 ';
    if (location.protocol === 'https:') {
      if (!('showDirectoryPicker' in window)) throw new Error('최신 Chrome 또는 Edge에서 폴더를 선택해 주세요.');
      const handle = await window.showDirectoryPicker({ id:'academy-clean-source', mode:'readwrite' });
      state.cleanDirectoryHandle = handle; state.cleanFolderPath = handle.name; state.cleanFolderToken = null; state.cleanFolderExplicit = true;
      button.firstChild.textContent = '원본 폴더 변경 '; $('#cleanFolderPath').textContent = handle.name; $('#cleanStartButton').disabled = false;
      setCleanStatus('', '웹 정제 준비 완료', `${handle.name}의 Excel 파일을 Railway에서 정제합니다.`); return;
    }
    const response = await requestApi('/api/select-clean-folder', { method: 'POST' });
    const data = await readApiJson(response);
    if (!response.ok) throw new Error(data.error);
    if (data.cancelled) return;
    state.cleanFolderToken = data.token;
    state.cleanFolderPath = data.path;
    state.cleanFolderExplicit = true;
    button.firstChild.textContent = '원본 폴더 변경 ';
    $('#cleanFolderPath').textContent = data.path;
    $('#cleanFolderPath').title = data.path;
    $('#cleanStartButton').disabled = false;
    setCleanStatus('', '정제 준비 완료', `${data.path} 하위에 정제 폴더를 만들어 결과를 저장합니다.`);
  } catch (error) {
    setCleanStatus('error', '폴더 선택 실패', error.message || '원본 폴더를 선택할 수 없습니다.');
  } finally {
    button.disabled = false;
    if (!state.cleanFolderToken) button.firstChild.textContent = '정제할 원본 폴더 선택 ';
  }
}

function renderCleanResults(result) {
  state.cleanResult = result;
  const container = $('#cleanResults');
  container.classList.remove('hidden');
  const rows = (result.files || []).map((file) => {const running=file.status==='running',success=file.status==='success';return `<div class="clean-file-row ${success?'':'error'}"><strong>${escapeHtml(file.file)}</strong><span class="process-item-status ${running?'running':success?'success':'failed'}">${running?'진행 중':success?'성공':'실패'}</span><span>${success?`${Number(file.before||0).toLocaleString('ko-KR')} → ${Number(file.after||0).toLocaleString('ko-KR')}행 · ${Number(file.merged||0).toLocaleString('ko-KR')}행 통합`:escapeHtml(file.error||(running?'파일을 다시 정제하고 있습니다.':'정제 실패'))}</span><button class="process-retry-button" data-clean-retry="${escapeHtml(file.file)}" ${running?'disabled':''}>재정제</button></div>`;}).join('');
  const total=(result.files||[]).length||result.total||0,success=(result.files||[]).filter(file=>file.status==='success').length,failed=(result.files||[]).filter(file=>file.status==='error'||file.status==='failed').length;
  result.total=total;result.success=success;result.failed=failed;
  container.innerHTML = `<div class="clean-result-summary"><div><strong>${success}</strong><span> / ${total}개 파일 완료</span></div><span>저장 위치: ${escapeHtml(result.output)}</span></div><div class="clean-file-list">${rows}</div>`;
  const rate = total ? Math.round(success / total * 100) : 0;
  $('#qualitySummary').textContent = `정제 성공률 ${rate}% · 성공 ${success}개 · 오류 ${failed}개`;
  $('#qualityMeter i').style.width = `${rate}%`;
  addHistory('2단계 정제', failed ? '부분 완료' : '완료', `${success}/${total}개 · 품질 성공률 ${rate}%`);
}

async function retryCleanFile(fileName) {
  if (state.cleaning) return;
  const fileResult = state.cleanResult?.files?.find((file) => file.file === fileName);
  if (!fileResult) return;
  fileResult.status = 'running'; fileResult.error = '';
  renderCleanResults(state.cleanResult); state.cleaning = true;
  setCleanStatus('running', '개별 파일 재정제 중', fileName);
  try {
    let updated;
    const handle = state.cleanRetryFiles.get(fileName);
    if (handle && state.cleanDirectoryHandle) {
      const file = await handle.getFile();
      const response = await requestApi('/api/web/clean',{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':encodeURIComponent(file.name)},body:file});
      if(!response.ok) throw new Error((await readApiJson(response)).error);
      const name=decodeURIComponent(response.headers.get('x-output-name')||file.name.replace(/\.xlsx$/i,'_정제.xlsx'));
      const output=await state.cleanDirectoryHandle.getDirectoryHandle('정제',{create:true});const target=await output.getFileHandle(name,{create:true});const writable=await target.createWritable();await writable.write(await response.blob());await writable.close();
      updated={file:fileName,status:'success',before:0,after:0,merged:0};
    } else {
      const response=await requestApi('/api/clean-folder',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({folderToken:state.cleanFolderToken,fileName,operationId:crypto.randomUUID()})});
      const data=await readApiJson(response);if(!response.ok)throw new Error(data.error);updated=data.files?.[0];if(!updated)throw new Error('정제 결과가 없습니다.');
    }
    Object.assign(fileResult,updated); setCleanStatus('success','개별 재정제 완료',fileName); toast('선택한 파일을 다시 정제했습니다.');
  } catch(error) { Object.assign(fileResult,{status:'error',error:error.message||'재정제 실패'}); setCleanStatus('error','개별 재정제 실패',fileResult.error); }
  finally { state.cleaning=false; renderCleanResults(state.cleanResult); }
}

async function startCleaning() {
  if ((!state.cleanFolderToken && !state.cleanDirectoryHandle) || state.cleaning) return;
  state.cleaning = true;
  state.cleanOperationId = crypto.randomUUID(); state.cleanController = new AbortController(); showStop('#cleanStopButton', true);
  const startButton = $('#cleanStartButton');
  const folderButton = $('#cleanFolderButton');
  startButton.disabled = true; folderButton.disabled = true;
  startButton.querySelector('span').textContent = '정제 진행 중';
  $('#cleanResults').classList.add('hidden');
  setCleanStatus('running', 'Excel 파일 정제 중', '파일 수와 행 수에 따라 시간이 걸릴 수 있습니다. 창을 닫지 마세요.');
  try {
    if (state.cleanDirectoryHandle) {
      const files=[]; state.cleanRetryFiles.clear(); for await (const entry of state.cleanDirectoryHandle.values()) if(entry.kind==='file' && /\.xlsx$/i.test(entry.name) && !entry.name.startsWith('~$')) { files.push(entry); state.cleanRetryFiles.set(entry.name,entry); }
      if(!files.length) throw new Error('선택한 폴더에 Excel 파일이 없습니다.');
      const output=await state.cleanDirectoryHandle.getDirectoryHandle('정제',{create:true}); const results=[];
      for(let index=0;index<files.length;index++) {
        const file=await files[index].getFile(); setCleanStatus('running',`웹 정제 ${index+1} / ${files.length}`,file.name);
        if(!file.size){results.push({file:file.name,status:'failed',error:'0바이트 파일 — 1단계에서 다시 다운로드 필요'});continue;}
        try {
          const response=await requestApi('/api/web/clean',{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':encodeURIComponent(file.name)},body:file,signal:state.cleanController.signal});
          if(!response.ok) throw new Error((await readApiJson(response)).error);
          const name=decodeURIComponent(response.headers.get('x-output-name')||`${file.name}_정제.xlsx`); const target=await output.getFileHandle(name,{create:true}); let writable;
          try { writable=await target.createWritable({keepExistingData:false}); await writable.write(await response.blob()); await writable.close(); }
          catch(error){if(writable)await writable.abort().catch(()=>{});throw error;}
          results.push({file:name,status:'success',before:0,after:0,merged:0});
        } catch(error) { if(error.name==='AbortError')throw error; results.push({file:file.name,status:'failed',error:error.message||'정제 실패'}); }
      }
      const success=results.filter(item=>item.status==='success').length,failed=results.length-success;
      renderCleanResults({success,failed,total:results.length,output:`${state.cleanDirectoryHandle.name}/정제`,files:results});
      setCleanStatus(success?'success':'error',success?`${success}개 파일 정제 완료`:'정제 가능한 파일이 없습니다.',failed?`${failed}개 손상·미완료 파일은 건너뛰었습니다.`:'정제 폴더에 저장했습니다.'); return;
    }
    const response = await requestApi('/api/clean-folder', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderToken: state.cleanFolderToken, operationId: state.cleanOperationId }), signal: state.cleanController.signal
    });
    const data = await readApiJson(response);
    if (!response.ok) throw new Error(data.error);
    renderCleanResults(data);
    if (data.failed) setCleanStatus('error', `${data.success}개 완료 · ${data.failed}개 실패`, `결과는 ${data.output}에 저장했습니다.`);
    else setCleanStatus('success', `${data.success}개 파일 정제 완료`, `정제 결과를 ${data.output}에 저장했습니다.`);
    toast('데이터 정제가 완료되었습니다.');
  } catch (error) {
    if (error.name === 'AbortError') setCleanStatus('', '정제 작업 중단', '사용자 요청으로 Excel 정제를 중단했습니다.');
    else setCleanStatus('error', '정제 중 오류 발생', error.message || 'Excel 파일을 정제하지 못했습니다.');
  } finally {
    state.cleaning = false; state.cleanOperationId = null; state.cleanController = null; showStop('#cleanStopButton', false); startButton.disabled = false; folderButton.disabled = false;
    startButton.querySelector('span').textContent = '다시 정제';
  }
}

function setDashboardStatus(type, title, detail) {
  const status = $('#dashboardStatus'); status.className = `clean-status ${type || ''}`.trim();
  status.setAttribute('aria-busy', String(type === 'running')); setRunning('#step-dashboard', type === 'running');
  status.querySelector('strong').textContent = title; status.querySelector('small').textContent = detail;
}
function renderDashboardResults(result) {
  state.dashboardResult=result;const container=$('#dashboardResults');container.classList.remove('hidden');
  const rows=(result.items||[]).map((item)=>{const running=item.status==='running',success=item.status==='success';return `<div class="clean-file-row ${success?'':'error'}"><strong>${escapeHtml(item.file)}</strong><span class="process-item-status ${running?'running':success?'success':'failed'}">${running?'진행 중':success?'성공':'실패'}</span><span>${success?escapeHtml(item.output||'HTML 생성 완료'):escapeHtml(item.error||'생성 실패')}</span><button class="process-retry-button" data-dashboard-retry="${escapeHtml(item.file)}" ${running?'disabled':''}>재제작</button></div>`;}).join('');
  const success=(result.items||[]).filter((item)=>item.status==='success').length;container.innerHTML=`<div class="clean-result-summary"><div><strong>${success}</strong><span> / ${(result.items||[]).length}개 HTML 완료</span></div><span>저장 위치: ${escapeHtml(result.output||'대시보드')}</span></div><div class="clean-file-list">${rows}</div>`;
}
async function retryDashboardFile(fileName) {
  if(state.dashboarding)return;const item=state.dashboardResult?.items?.find((entry)=>entry.file===fileName);if(!item)return;
  item.status='running';item.error='';renderDashboardResults(state.dashboardResult);state.dashboarding=true;setDashboardStatus('running','개별 대시보드 재제작 중',fileName);
  try {
    const handle=state.dashboardRetryFiles.get(fileName);
    if(handle&&state.dashboardDirectoryHandle){const file=await handle.getFile();const response=await requestApi('/api/web/dashboard',{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':encodeURIComponent(file.name)},body:file});if(!response.ok)throw new Error((await readApiJson(response)).error);const name=decodeURIComponent(response.headers.get('x-output-name')||file.name.replace(/\.xlsx$/i,'.html'));const output=await state.dashboardDirectoryHandle.getDirectoryHandle('대시보드',{create:true});const target=await output.getFileHandle(name,{create:true});const writable=await target.createWritable();await writable.write(await response.blob());await writable.close();Object.assign(item,{status:'success',output:name});}
    else {const combined=fileName==='통합 대시보드';const response=await requestApi('/api/create-dashboards',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({folderToken:state.dashboardFolderToken,mode:combined?'combined':'individual',fileName:combined?'':fileName,operationId:crypto.randomUUID()})});const data=await readApiJson(response);if(!response.ok)throw new Error(data.error);Object.assign(item,{status:'success',output:data.files?.[0]||'HTML 생성 완료'});}
    setDashboardStatus('success','개별 대시보드 재제작 완료',fileName);toast('선택한 대시보드를 다시 만들었습니다.');
  }catch(error){Object.assign(item,{status:'error',error:error.message||'재제작 실패'});setDashboardStatus('error','개별 대시보드 재제작 실패',item.error);}
  finally{state.dashboarding=false;renderDashboardResults(state.dashboardResult);}
}
async function selectDashboardFolder() {
  const button = $('#dashboardFolderButton');
  try {
    button.disabled = true; button.firstChild.textContent = '폴더 선택 창 여는 중 ';
    if(location.protocol==='https:'){if(!('showDirectoryPicker' in window))throw new Error('최신 Chrome 또는 Edge에서 폴더를 선택해 주세요.');const handle=await window.showDirectoryPicker({id:'academy-dashboard-source',mode:'readwrite'});state.dashboardDirectoryHandle=handle;state.dashboardFolderPath=handle.name;state.dashboardFolderToken=null;state.dashboardFolderExplicit=true;button.firstChild.textContent='원본 폴더 변경 ';$('#dashboardFolderPath').textContent=handle.name;$('#dashboardStartButton').disabled=false;setDashboardStatus('','생성 준비 완료',`${handle.name}의 정제 파일로 생성합니다.`);return;}
    const response = await requestApi('/api/select-dashboard-folder', { method: 'POST' }); const data = await readApiJson(response);
    if (!response.ok) throw new Error(data.error); if (data.cancelled) return;
    state.dashboardFolderToken = data.token; state.dashboardFolderPath = data.path;
    state.dashboardFolderExplicit = true;
    button.firstChild.textContent = '원본 폴더 변경 '; $('#dashboardFolderPath').textContent = data.path; $('#dashboardFolderPath').title = data.path;
    $('#dashboardStartButton').disabled = false; setDashboardStatus('', '생성 준비 완료', `${data.path}의 정제 파일로 대시보드를 만듭니다.`);
  } catch (error) { setDashboardStatus('error', '폴더 선택 실패', error.message || '폴더를 선택할 수 없습니다.'); }
  finally { button.disabled = false; if (!state.dashboardFolderToken) button.firstChild.textContent = '대시보드 원본 폴더 선택 '; }
}
async function startDashboard() {
  if ((!state.dashboardFolderToken && !state.dashboardDirectoryHandle) || state.dashboarding) return; state.dashboarding = true;
  state.dashboardController = new AbortController(); showStop('#dashboardStopButton', true);
  const start = $('#dashboardStartButton'), folder = $('#dashboardFolderButton'); start.disabled = true; folder.disabled = true;
  start.querySelector('span').textContent = '대시보드 생성 중'; $('#dashboardResults').classList.add('hidden');
  setDashboardStatus('running', '정제 데이터 분석 중', '파일 수와 데이터 행 수에 따라 시간이 걸릴 수 있습니다.');
  try {
    if(state.dashboardDirectoryHandle){
      let input=state.dashboardDirectoryHandle;try{input=await input.getDirectoryHandle('정제')}catch{}
      const files=[];state.dashboardRetryFiles.clear();for await(const entry of input.values())if(entry.kind==='file'&&/\.xlsx$/i.test(entry.name)&&!entry.name.startsWith('~$')){files.push(entry);state.dashboardRetryFiles.set(entry.name,entry);}
      if(!files.length)throw new Error('정제 Excel 파일이 없습니다.');const output=await state.dashboardDirectoryHandle.getDirectoryHandle('대시보드',{create:true});const items=[];
      for(let i=0;i<files.length;i++){const file=await files[i].getFile();setDashboardStatus('running',`대시보드 ${i+1} / ${files.length}`,file.name);try{const response=await requestApi('/api/web/dashboard',{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':encodeURIComponent(file.name)},body:file,signal:state.dashboardController.signal});if(!response.ok)throw new Error((await readApiJson(response)).error);const name=decodeURIComponent(response.headers.get('x-output-name')||file.name.replace(/\.xlsx$/i,'.html'));const target=await output.getFileHandle(name,{create:true});const writable=await target.createWritable();await writable.write(await response.blob());await writable.close();items.push({file:file.name,status:'success',output:name});}catch(error){if(error.name==='AbortError')throw error;items.push({file:file.name,status:'error',error:error.message||'생성 실패'});}renderDashboardResults({items,output:`${state.dashboardDirectoryHandle.name}/대시보드`});}
      const success=items.filter(item=>item.status==='success').length;renderDashboardResults({items,output:`${state.dashboardDirectoryHandle.name}/대시보드`});setDashboardStatus(success?'success':'error',`${success}/${items.length}개 대시보드 생성 완료`,success===items.length?'대시보드 폴더에 저장했습니다.':'실패 항목은 재제작 버튼으로 다시 실행할 수 있습니다.');addHistory('3단계 대시보드',success===items.length?'완료':'부분 완료',`${success}/${items.length}개 HTML 생성`);return;}
    const mode = $('input[name="dashboardMode"]:checked').value;
    let data;
    if (mode === 'individual') {
      const listResponse = await requestApi('/api/list-dashboard-files', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ folderToken:state.dashboardFolderToken }), signal:state.dashboardController.signal });
      const listData = await readApiJson(listResponse); if (!listResponse.ok) throw new Error(listData.error);
      const made = []; const items=[]; let output = listData.output;
      for (let index = 0; index < listData.files.length; index++) {
        const fileName = listData.files[index];
        state.dashboardOperationId = crypto.randomUUID(); state.dashboardController = new AbortController();
        setDashboardStatus('running', `개별 대시보드 ${index + 1} / ${listData.files.length}`, `${fileName} 파일 하나를 생성하고 있습니다.`);
        try { const response = await requestApi('/api/create-dashboards', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ folderToken:state.dashboardFolderToken, mode, fileName, operationId:state.dashboardOperationId }), signal:state.dashboardController.signal });
        const result = await readApiJson(response); if (!response.ok) throw new Error(result.error?.includes('Command failed') ? `${fileName} 파일을 Excel에서 읽지 못했습니다.` : result.error);
        made.push(...result.files); output = result.output;items.push({file:fileName,status:'success',output:result.files?.[0]||'HTML 생성 완료'});}
        catch(error){if(error.name==='AbortError')throw error;items.push({file:fileName,status:'error',error:error.message||'생성 실패'});}renderDashboardResults({items,output});
      }
      data = { count:made.length, files:made, output, items };
    } else {
      state.dashboardOperationId = crypto.randomUUID();
      const response = await requestApi('/api/create-dashboards', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ folderToken:state.dashboardFolderToken, mode, operationId:state.dashboardOperationId }), signal:state.dashboardController.signal });
      data = await readApiJson(response); if (!response.ok) throw new Error(data.error?.includes('Command failed') ? '통합 대시보드용 Excel 파일을 읽지 못했습니다.' : data.error);data.items=(data.files||[]).map(file=>({file:'통합 대시보드',status:'success',output:file}));
    }
    renderDashboardResults(data);
    setDashboardStatus('success', `${data.count}개 대시보드 생성 완료`, `${data.output}에 HTML 문서를 저장했습니다.`); addHistory('3단계 대시보드', '완료', `${data.count}개 HTML 생성`); toast('데이터 대시보드 생성이 완료되었습니다.');
  } catch(error) { if(error.name==='AbortError') setDashboardStatus('', '대시보드 생성 중단', '사용자 요청으로 생성을 중단했습니다.'); else setDashboardStatus('error', '대시보드 생성 실패', error.message || 'HTML을 생성하지 못했습니다.'); addHistory('3단계 대시보드', error.name==='AbortError'?'중단':'실패', error.message || 'HTML 생성 실패'); }
  finally { state.dashboarding=false; state.dashboardOperationId=null; state.dashboardController=null; showStop('#dashboardStopButton',false); start.disabled=false; folder.disabled=false; start.querySelector('span').textContent='다시 생성'; }
}

function stopDownload() { if (!state.downloading) return; state.downloadCancelled = true; state.downloadController?.abort(); $('#dockStatus').textContent = '다운로드 중단 중'; }
function stopScan() { state.scanController?.abort(); }
async function stopCleaning() { const id=state.cleanOperationId; state.cleanController?.abort(); setCleanStatus('', '정제 중단 중', '실행 중인 Excel 작업을 종료하고 있습니다.'); await cancelServerOperation(id); }
async function stopDashboard() { const id=state.dashboardOperationId; state.dashboardController?.abort(); setDashboardStatus('', '생성 중단 중', '실행 중인 대시보드 작업을 종료하고 있습니다.'); await cancelServerOperation(id); }

async function runFullPipeline() {
  const button=$('#pipelineButton'); if(state.downloading||state.cleaning||state.dashboarding)return;
  try {
    button.disabled=true; button.textContent='전체 작업 진행 중'; setRunning('#step-operations',true);
    if(!state.directoryHandle){await selectDirectory();if(!state.directoryHandle)throw new Error('원클릭 실행은 Chrome 또는 Edge에서 선택 폴더 저장을 사용해 주세요.');}
    if(!state.items.length && !(await scan()))throw new Error('수집 항목 조회에 실패했습니다.');
    await saveUncompressed();
    const checkpoint=readLocal(CHECKPOINT_KEY,null);if(!checkpoint?.done)throw new Error('다운로드 실패 묶음이 남아 있어 정제를 시작하지 않았습니다.');
    state.cleanDirectoryHandle=state.directoryHandle;state.cleanFolderPath=state.directoryHandle.name;$('#cleanFolderPath').textContent=state.directoryHandle.name;$('#cleanStartButton').disabled=false;
    await startCleaning();
    if($('#cleanStatus').classList.contains('error'))throw new Error('정제 단계에 오류 파일이 있어 전체 작업을 중단했습니다.');
    state.dashboardDirectoryHandle=state.directoryHandle;state.dashboardFolderPath=state.directoryHandle.name;$('#dashboardFolderPath').textContent=state.directoryHandle.name;$('#dashboardStartButton').disabled=false;
    await startDashboard();if($('#dashboardStatus').classList.contains('error'))throw new Error('대시보드 생성 단계가 실패했습니다.');addHistory('전체 파이프라인','완료','다운로드 → 정제 → 대시보드 순차 실행');toast('전체 파이프라인 실행을 마쳤습니다.');
  } catch(error){addHistory('전체 파이프라인','실패',error.message||'작업 실패');toast(error.message||'전체 작업을 완료하지 못했습니다.');}
  finally{button.disabled=false;button.textContent='전체 작업 시작';setRunning('#step-operations',false);}
}

async function resumeDownload(){
  if(!state.items.length){const ok=await scan();if(!ok)return;}
  if(!state.directoryHandle&&!state.folderToken&&!state.browserDownloadFallback)await selectDirectory();
  state.resumeRequested=true;
  await saveUncompressed();
}

$('#scanButton').addEventListener('click', scan);
$('#downloadButton').addEventListener('click', () => { state.resumeRequested=false; saveUncompressed(); });
$('#zipButton').addEventListener('click', downloadAll);
$('#tableWrap').addEventListener('click', (event) => {
  const button = event.target.closest('[data-download-item]');
  if (!button) return;
  const item = state.items.find((candidate) => itemKey(candidate) === button.dataset.downloadItem);
  if (item) downloadSingle(item);
});
$('#folderButton').addEventListener('click', selectDirectory);
$('#cleanFolderButton').addEventListener('click', selectCleanFolder);
$('#cleanStartButton').addEventListener('click', startCleaning);
$('#cleanResults').addEventListener('click',(event)=>{const button=event.target.closest('[data-clean-retry]');if(button)retryCleanFile(button.dataset.cleanRetry);});
$('#dashboardFolderButton').addEventListener('click', selectDashboardFolder);
$('#dashboardStartButton').addEventListener('click', startDashboard);
$('#dashboardResults').addEventListener('click',(event)=>{const button=event.target.closest('[data-dashboard-retry]');if(button)retryDashboardFile(button.dataset.dashboardRetry);});
$('#scanStopButton').addEventListener('click', stopScan);
$('#downloadStopButton').addEventListener('click', stopDownload);
$('#cleanStopButton').addEventListener('click', stopCleaning);
$('#dashboardStopButton').addEventListener('click', stopDashboard);
$('#resumeButton').addEventListener('click', resumeDownload);
$('#pipelineButton').addEventListener('click', runFullPipeline);
$('#clearHistoryButton').addEventListener('click', () => { localStorage.removeItem(HISTORY_KEY); renderHistory(); toast('작업 이력을 지웠습니다.'); });
$('#settingsButton').addEventListener('click', openSettings);
$('#settingsCloseButton').addEventListener('click', () => $('#settingsDialog').close());
$('#settingsForm').addEventListener('submit', saveSettings);
$('#clearSettingsButton').addEventListener('click', clearSettings);
$('#toggleApiKey').addEventListener('click', () => {
  const input = $('#openApiKey');
  const visible = input.type === 'text';
  input.type = visible ? 'password' : 'text';
  $('#toggleApiKey').textContent = visible ? '표시' : '숨김';
  $('#toggleApiKey').setAttribute('aria-label', visible ? '인증키 표시' : '인증키 숨기기');
});
$('#settingsDialog').addEventListener('click', (event) => {
  if (event.target === $('#settingsDialog')) $('#settingsDialog').close();
});
updateSettingsIndicator();
renderHistory();
updateResumeUi();
initializeExampleLinks();
initializeHeroCarousel();
$('#selectAllSchools').addEventListener('click', () => {
  $$('.school-grid input').forEach((input) => { input.checked = true; });
  $('#formError').textContent = '';
});
$('#clearSchools').addEventListener('click', () => {
  $$('.school-grid input').forEach((input) => { input.checked = false; });
});
$('#searchInput').addEventListener('input', (event) => {
  const query = event.target.value.trim().toLowerCase();
  state.filtered = state.items.filter((item) => `${itemFileName(item)} ${item.name} ${item.categoryName} ${item.schoolName}`.toLowerCase().includes(query));
  renderTable(state.filtered);
});
