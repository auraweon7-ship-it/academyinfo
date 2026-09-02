import fs from 'node:fs/promises';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const [filePath, previewPath] = process.argv.slice(2);
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(filePath));
const region = await workbook.inspect({ kind: 'region', sheetId: '연구비수혜실적_정제', range: 'A1:AN10', maxChars: 18000, tableMaxRows: 10, tableMaxCols: 40 });
const formulas = await workbook.inspect({ kind: 'formula', sheetId: '연구비수혜실적_정제', range: 'A1:AN202', maxChars: 5000, options: { maxResults: 100 } });
const styles = await workbook.inspect({ kind: 'computedStyle', sheetId: '연구비수혜실적_정제', range: 'A1:AN6', maxChars: 7000 });
console.log('---REGION---\n' + region.ndjson + '\n---FORMULAS---\n' + formulas.ndjson + '\n---STYLES---\n' + styles.ndjson);
const preview = await workbook.render({ sheetName: '연구비수혜실적_정제', range: 'A1:AN18', scale: 1.2, format: 'png' });
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
