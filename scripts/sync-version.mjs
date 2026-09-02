import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const versionLabel = `v.${pkg.version}`;
const publicUrl = new URL('public/index.html', root);
let source = await readFile(publicUrl, 'utf8');
source = source.replace(/(<small data-app-version>)[^<]*(<\/small>)/, `$1${versionLabel}$2`);
await writeFile(publicUrl, source, 'utf8');

const portable = source
  .replace('href="/styles.css"', 'href="./public/styles.css"')
  .replace('src="/app.js"', 'src="./public/app.js"')
  .replace('<title>대학알리미 데이터 수집기</title>', '<title>대학알리미 데이터 수집기 · HTML</title>');
await writeFile(new URL('index.html', root), portable, 'utf8');
await writeFile(new URL('대학알리미_데이터수집기.html', root), portable, 'utf8');
console.log(`앱 버전 ${versionLabel} 동기화 완료`);
