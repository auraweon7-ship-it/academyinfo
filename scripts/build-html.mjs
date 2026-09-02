import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const portable = source
  .replace('href="/styles.css"', 'href="./public/styles.css"')
  .replace('src="/app.js"', 'src="./public/app.js"')
  .replace('<title>대학알리미 데이터 수집기</title>', '<title>대학알리미 데이터 수집기 · HTML</title>');

await writeFile(`${root}대학알리미_데이터수집기.html`, portable, 'utf8');
console.log(`${root}대학알리미_데이터수집기.html`);
