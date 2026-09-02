import fs from 'node:fs/promises';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const [filePath, previewPath] = process.argv.slice(2);
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(filePath));
const sheets = await workbook.inspect({ kind: 'sheet', include: 'id,name', maxChars: 3000 });
const firstName = JSON.parse(sheets.ndjson.split('\n').find((line) => line.trim())).name;
const errors = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A', options: { useRegex: true, maxResults: 100 }, summary: 'final formula error scan' });
console.log(sheets.ndjson + '\n' + errors.ndjson);
const preview = await workbook.render({ sheetName: firstName, range: 'A1:AN18', scale: 1.2, format: 'png' });
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
