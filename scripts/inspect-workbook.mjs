import fs from 'node:fs/promises';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const filePath = process.argv[2];
if (!filePath) throw new Error('검사할 XLSX 경로가 필요합니다.');
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(filePath));
const summary = await workbook.inspect({ kind: 'workbook,sheet,table', maxChars: 8000, tableMaxRows: 8, tableMaxCols: 12, tableMaxCellChars: 100 });
console.log(summary.ndjson);
if (process.argv[3]) await fs.writeFile(process.argv[3], summary.ndjson, 'utf8');
