import ExcelJS from 'exceljs';
import XLSX from '@e965/xlsx';
import { readFile } from 'node:fs/promises';

const dashboardTemplate = await readFile(new URL('./scripts/dashboard-template.html', import.meta.url), 'utf8');

const exceptions = new Set(['고려대학교','고려대학교(세종)_분교','건국대학교','건국대학교(글로컬)_분교','동국대학교','동국대학교(WISE)_분교','연세대학교','연세대학교(미래)_분교','한양대학교','한양대학교(ERICA)_분교']);
const metadataPattern = /기준연도|^연도$|학교종류|설립구분|지역|상태/;
const ratePattern = /비율|비중|율\b|퍼센트|%/;
const averagePattern = /평균|평점/;
const number = (value) => typeof value === 'number' && Number.isFinite(value);
const sum = (rows, column) => rows.reduce((total, row) => total + (number(row[column]) ? row[column] : 0), 0);
const cleanText = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
const canonicalSchool = (value) => {
  const name = cleanText(value);
  if (exceptions.has(name)) return name;
  return name.replace(/\s*_제[2-4]캠퍼스\s*$/,'').replace(/\s*\([^)]*\)\s*(?:_캠퍼스)?\s*$/,'').trim();
};
const graduationYear = (value) => {
  const digits = String(value ?? '').replace(/[^0-9]/g,'');
  return /^(19|20)\d{4}$/.test(digits) ? `${digits.slice(0,4)}.${digits.slice(4)}` : value;
};
const flatHeader = (header) => {
  let parts = String(header).split(' / ').map((part) => cleanText(part).replace(/\s/g,'').replace(/^_+|_+$/g,'')).filter(Boolean);
  if (parts.length > 1 && (/및|구분$/.test(parts[0]) || /^연구비지원$/.test(parts[0]))) parts = parts.slice(1);
  if (parts[0] === '전임교원1인당연구비') parts[0] = '1인당연구비';
  const result = parts.join('_').replace(/_+/g,'_').replace(/^_+|_+$/g,'');
  if (result === '학교명') return '학교';
  if (result === '상태') return '상태정보';
  return result;
};

function mergedValue(rows, merges, row, column) {
  const merge = merges.find((item) => row >= item.s.r && row <= item.e.r && column >= item.s.c && column <= item.e.c);
  return merge ? rows[merge.s.r]?.[merge.s.c] : rows[row]?.[column];
}

function layoutOf(rows, columnCount) {
  let schoolColumn = -1, schoolHeaderRow = -1;
  for (let row = 0; row < Math.min(15, rows.length) && schoolColumn < 0; row++) {
    for (let column = 0; column < columnCount; column++) if (/^(학교|학교명|대학명|대학)$/.test(cleanText(rows[row]?.[column]).replace(/\s/g,''))) { schoolColumn = column; schoolHeaderRow = row; break; }
  }
  if (schoolColumn < 0) return null;
  let dataStart = -1;
  for (let row = schoolHeaderRow + 1; row < rows.length; row++) {
    const school = cleanText(rows[row]?.[schoolColumn]);
    const numericCount = (rows[row] || []).filter(number).length;
    if (school && !/^(학교|학교명|대학명|대학|남|여|계|과제|연구비)$/.test(school) && numericCount >= 1) { dataStart = row; break; }
  }
  if (dataStart < 0) return null;
  let headerStart = 0;
  for (let row = 0; row <= schoolHeaderRow; row++) {
    const values = (rows[row] || []).map(cleanText);
    if (values.filter(Boolean).length > 1 && values.some((value) => /학교|기준연도|설립|지역|상태|교원|학생|연구비|과제/.test(value))) { headerStart = row; break; }
  }
  return { schoolColumn, dataStart, headerStart, headerEnd: dataStart - 1 };
}

function weightColumn(headers, target, rows) {
  const preferred = [], secondary = [];
  for (let column = 0; column < target; column++) {
    const header = headers[column] || '', leaf = header.split(' / ').at(-1) || '';
    if (!rows.some((row) => number(row[column])) || /비율|평균|비중|1인당/.test(leaf)) continue;
    if (/총|전체|대상|정원|모수/.test(header)) preferred.push(column);
    else if (/학생수|인원|교원수|건수|개수|수$/.test(leaf)) secondary.push(column);
  }
  return preferred.at(-1) ?? secondary[0] ?? -1;
}

function findColumn(headers, pattern) { return headers.findIndex((header) => pattern.test(flatHeader(header))); }

function aggregate(rows, headers, schoolColumn, itemKind) {
  const result = [...rows[0]];
  for (let column = 0; column < headers.length; column++) {
    const header = headers[column] || '', leaf = header.split(' / ').at(-1) || '';
    if (column === schoolColumn || metadataPattern.test(header)) { result[column] = rows[0][column]; continue; }
    if (/졸업연도/.test(header)) { result[column] = graduationYear(rows[0][column]); continue; }
    const values = rows.map((row) => row[column]).filter(number);
    if (!values.length) { result[column] = rows.map((row) => row[column]).find((value) => value !== '' && value != null) ?? ''; continue; }
    if ((/졸업생.*취업.*현황/.test(itemKind) && column >= 38) || /유지취업률/.test(header)) result[column] = Math.round(values.reduce((a,b)=>a+b,0) / rows.length * 10) / 10;
    else if (ratePattern.test(leaf) || averagePattern.test(leaf) || /1인당/.test(header)) {
      const weight = weightColumn(headers, column, rows);
      let weighted = 0, weights = 0;
      for (const row of rows) if (number(row[column])) { const w = weight >= 0 && number(row[weight]) ? row[weight] : 1; weighted += row[column] * w; weights += w; }
      result[column] = weights ? Math.round(weighted / weights * 10000) / 10000 : 0;
    } else result[column] = values.reduce((a,b)=>a+b,0);
  }
  if (/외국학생.*현황/.test(itemKind)) {
    const degree=findColumn(headers,/^학위과정.*_소계\(A\)$/), language=findColumn(headers,/^언어능력_계\(E\)$/), rate=findColumn(headers,/^언어능력충족학생비율/);
    if(degree>=0&&language>=0&&rate>=0) result[rate]=sum(rows,degree)?Math.round(sum(rows,language)/sum(rows,degree)*1000)/10:0;
    const degreeDorm=findColumn(headers,/^기숙사.*_학위과정_계\(F\)$/),trainingDorm=findColumn(headers,/^기숙사.*_비학위과정_계\(G\)$/),accepted=findColumn(headers,/^기숙사.*_비학위과정_수용$/),notAccepted=findColumn(headers,/^기숙사.*_비학위과정_미수용$/);
    if(degree>=0&&degreeDorm>=0)result[degreeDorm]=sum(rows,degree);
    if(trainingDorm>=0&&accepted>=0&&notAccepted>=0)result[trainingDorm]=sum(rows,accepted)+sum(rows,notAccepted);
  }
  if (/학생.*1인당.*교육비/.test(itemKind)) {
    const cost=findColumn(headers,/^총교육비\(E=A\+B\+C\+D\)$/), students=findColumn(headers,/^재학생수\(F\)$/), per=findColumn(headers,/^학생1인당교육비/);
    if(cost>=0&&students>=0&&per>=0) result[per]=sum(rows,students)?Math.round(sum(rows,cost)/sum(rows,students)*10)/10:0;
  }
  if (/연구비.*수혜.*실적/.test(itemKind)) {
    for (let column=0;column<headers.length;column++) {
      const target=flatHeader(headers[column]), match=target.match(/^1인당연구비_(교내|교외)_(남|여)$/);
      if(!match)continue;
      const [,scope,gender]=match, denominator=findColumn(headers,new RegExp(`^전임교원_${gender}$`));
      const numerators=headers.map((header,index)=>[flatHeader(header),index]).filter(([header])=>scope==='교내'?header===`교내_연구비_${gender}`:new RegExp(`^교외_.+_연구비_${gender}$`).test(header)).map(([,index])=>index);
      const denominatorValue=denominator>=0?sum(rows,denominator):0, numeratorValue=numerators.reduce((total,index)=>total+sum(rows,index),0);
      result[column]=denominatorValue?Math.round(numeratorValue/denominatorValue*10000)/10000:0;
    }
  }
  if (/전임교원.*연구.*실적/.test(itemKind)) {
    for(let column=0;column<headers.length;column++){
      const target=flatHeader(headers[column]);let metric='',gender='';
      let match=target.match(/^전임교원1인당논문실적_(.+)_(계|남|여)$/);
      if(match){metric=match[1];gender=match[2];}else{match=target.match(/^전임교원1인당저.*역서실적_(계|남|여)$/);if(match){metric='저역서';gender=match[1];}else continue;}
      let numeratorPattern;
      if(/국내기준/.test(metric))numeratorPattern=new RegExp(`^논문실적_국내_소계_${gender}$`);
      else if(/국제기준/.test(metric))numeratorPattern=new RegExp(`^논문실적_국제_소계_${gender}$`);
      else if(/등재지/.test(metric))numeratorPattern=new RegExp(`^논문실적_국내_연구재단등재지.*_${gender}$`);
      else if(/SCI/.test(metric))numeratorPattern=new RegExp(`^논문실적_국제_SCI.*_${gender}$`);
      else numeratorPattern=new RegExp(gender==='계'?'^저.*역서실적_계$':`^저.*역서실적_계_${gender}$`);
      const numerator=findColumn(headers,numeratorPattern),denominator=findColumn(headers,new RegExp(`^전임교원_${gender}$`));
      if(numerator>=0&&denominator>=0)result[column]=sum(rows,denominator)?Math.round(sum(rows,numerator)/sum(rows,denominator)*10000)/10000:0;
    }
  }
  return result;
}

function adjustEmployment(row, merged) {
  if(row.length!==50)return row;
  const shifted=Array(50).fill('');
  for(let column=0;column<6;column++)shifted[column]=row[column];
  shifted[6]=(number(row[6])?row[6]:0)+(number(row[7])?row[7]:0);
  for(let column=7;column<50;column++)shifted[column]=row[column-1];
  const excluded=shifted.slice(21,30).reduce((total,value)=>total+(number(value)?value:0),0),base=shifted[6]-excluded;
  if(!base)shifted[34]='';
  else if(merged){const employed=shifted.slice(9,21).reduce((total,value)=>total+(number(value)?value:0),0);shifted[34]=Math.round(employed/base*1000)/10;}
  shifted[48]='';shifted[49]='';return shifted;
}

function outputTitle(original, fileName) {
  if (original && !/^(기준연도|학교종류|학교명|학교)$/.test(original)) return original.replace(/_?\]$/,'_]').trim();
  const match = fileName.match(/^(\d{4}년)\s*_?[^_]*_(.+?)_학교별자료/);
  return match ? `${match[1]}_ [${match[2]}_]` : fileName.replace(/\.(xlsx|xls)$/i,'');
}

function sheetName(title, fallback) {
  let name = title.match(/\[([^\]]+)\]/)?.[1] || fallback;
  name = name.replace(/^\s*\d+[-가-힣0-9.]*\s*\.\s*/,'').replace(/[^0-9A-Za-z가-힣]/g,'') || '정제';
  return `${name.slice(0,28)}_정제`.slice(0,31);
}

function parseSource(bytes, fileName) {
  try {
    const workbook = XLSX.read(bytes, { type:'buffer', raw:true, cellDates:false });
    if (!workbook.SheetNames.length) throw new Error('worksheet');
    return workbook;
  } catch { throw new Error(`${fileName}: 파일 내용이 손상되었거나 다운로드가 완료되지 않았습니다. 1단계에서 해당 파일을 다시 다운로드해 주세요.`); }
}

function addGenericSheet(output, sourceSheet, sourceName, fileName) {
  const rows=XLSX.utils.sheet_to_json(sourceSheet,{header:1,raw:true,defval:''});
  if(!rows.length)return;
  let headerRow=0,best=-1;
  for(let row=0;row<Math.min(15,rows.length);row++){const count=(rows[row]||[]).filter((value)=>cleanText(value)).length;if(count>best){best=count;headerRow=row;}}
  const columnCount=Math.max(1,...rows.map((row)=>row.length)),headers=Array.from({length:columnCount},(_,column)=>cleanText(rows[headerRow]?.[column])||`열${column+1}`);
  const data=rows.slice(headerRow+1).filter((row)=>row.some((value)=>value!==''&&value!=null));
  const title=outputTitle(cleanText(rows[0]?.[0]),fileName),sheet=output.addWorksheet(sheetName(title,sourceName));
  sheet.addRow([`${title} 정제 데이터`]);sheet.addRow(['']);sheet.addRow(headers);data.forEach((row)=>sheet.addRow(Array.from({length:columnCount},(_,column)=>row[column]??'')));
  sheet.mergeCells(1,1,1,columnCount);sheet.mergeCells(2,1,2,columnCount);styleOutputSheet(sheet,headers,data.length);
}

function styleOutputSheet(sheet, headers, dataRowCount) {
  const lastColumn=Math.max(1,headers.length),lastRow=3+dataRowCount;
  sheet.getRow(1).font={name:'맑은 고딕',bold:true,size:12};sheet.getRow(2).font={name:'맑은 고딕',size:9,color:{argb:'FF666666'}};
  sheet.getRow(3).height=34;sheet.getRow(3).eachCell((cell)=>{cell.font={name:'맑은 고딕',bold:true,size:9,color:{argb:'FFFFFFFF'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1F4E79'}};cell.alignment={horizontal:'center',vertical:'middle',wrapText:true};});
  for(let row=4;row<=lastRow;row++)for(let column=1;column<=lastColumn;column++){const cell=sheet.getCell(row,column),header=flatHeader(headers[column-1]);cell.font={name:'맑은 고딕',size:9};cell.alignment={vertical:'middle',horizontal:column<=6?'center':'right'};cell.numFmt=/졸업연도/.test(header)?'@':/비율|평균|평점|1인당/.test(header)?'#,##0.0':'#,##0';}
  sheet.columns.forEach((column,index)=>{column.width=index===5?24:index<6?[10,11,10,9,10,24][index]:14;});
  sheet.autoFilter={from:{row:3,column:1},to:{row:3,column:lastColumn}};sheet.views=[{state:'frozen',ySplit:3,showGridLines:false}];
}

export async function cleanWorkbook(bytes, fileName) {
  const source = parseSource(bytes, fileName);
  const output = new ExcelJS.Workbook();
  for (const sourceName of source.SheetNames) {
    const sourceSheet=source.Sheets[sourceName], range=XLSX.utils.decode_range(sourceSheet['!ref'] || 'A1:A1');
    const columnCount=range.e.c+1, rows=XLSX.utils.sheet_to_json(sourceSheet,{header:1,raw:true,defval:''}), layout=layoutOf(rows,columnCount);
    if(!layout){addGenericSheet(output,sourceSheet,sourceName,fileName);continue;}
    const merges=sourceSheet['!merges'] || [], headers=[];
    for(let column=0;column<columnCount;column++){
      const parts=[]; for(let row=layout.headerStart;row<=layout.headerEnd;row++){const value=cleanText(mergedValue(rows,merges,row,column));if(value&&!parts.includes(value))parts.push(value);} headers.push(parts.join(' / '));
    }
    const schoolTypeColumn=headers.findIndex((h)=>/학교종류/.test(h)), statusColumn=headers.findIndex((h)=>/상태/.test(h));
    const carry={}, cleaned=[]; let lastSchool='';
    for(let row=layout.dataStart;row<rows.length;row++){
      const values=Array.from({length:columnCount},(_,column)=>rows[row]?.[column]??'');
      if(!values.some((value)=>value!==''&&value!=null)||!values.some(number))continue;
      for(let column=0;column<columnCount;column++){if(metadataPattern.test(headers[column])&&(values[column]===''||values[column]==null))values[column]=carry[column]??'';else if(values[column]!==''&&values[column]!=null)carry[column]=values[column];}
      let school=cleanText(values[layout.schoolColumn])||lastSchool;if(!school)continue;lastSchool=school;
      const schoolType=cleanText(values[schoolTypeColumn]),status=cleanText(values[statusColumn]);
      if(schoolTypeColumn>=0&&!['대학','대학교','교육대학','산업대학','기술대학'].includes(schoolType))continue;
      if(statusColumn>=0&&status&&status!=='기존')continue;
      if(school==='한국전통문화대학교')continue;
      values[layout.schoolColumn]=canonicalSchool(school); cleaned.push(values);
    }
    if(!cleaned.length){addGenericSheet(output,sourceSheet,sourceName,fileName);continue;}
    const groups=new Map();
    for(const row of cleaned){const dimensions=headers.flatMap((h,i)=>i!==layout.schoolColumn&&/기준연도|^연도$|학교종류|설립구분/.test(h)?[row[i]]:[]);const key=[row[layout.schoolColumn],...dimensions].join('\u001f');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
    const aggregated=[...groups.values()].map((group)=>{const row=aggregate(group,headers,layout.schoolColumn,fileName);return /졸업생.*취업.*현황/.test(fileName)?adjustEmployment(row,group.length>1):row;});
    const title=outputTitle(cleanText(rows[0]?.[0]),fileName), unit=/연구비/.test(fileName)?'(단위 : 천원, 1인당 연구비: 천원/명)':rows.slice(0,3).flat().map(cleanText).find((v)=>/단위/.test(v))||'';
    const sheet=output.addWorksheet(sheetName(title,sourceName));
    sheet.addRow([`${title} 정제 데이터`]); sheet.addRow([unit]); sheet.addRow(headers.map(flatHeader)); aggregated.forEach((row)=>sheet.addRow(row));
    sheet.mergeCells(1,1,1,columnCount); sheet.mergeCells(2,1,2,columnCount);styleOutputSheet(sheet,headers.map(flatHeader),aggregated.length);
  }
  if(!output.worksheets.length)throw new Error(`${fileName}: 학교 데이터와 헤더를 찾지 못했습니다.`);
  const outputName=fileName.replace(/\.(xlsx|xls)$/i,'').replace(/_정제$/,'')+'_정제.xlsx';
  return{name:outputName,bytes:Buffer.from(await output.xlsx.writeBuffer())};
}

export async function dashboardFromWorkbook(bytes,fileName){
  const workbook=parseSource(bytes,fileName),sheet=workbook.Sheets[workbook.SheetNames[0]],rows=XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:''});
  let headerRow=rows.findIndex((row)=>row.some((value)=>/^(학교|학교명|대학명|대학)$/.test(cleanText(value).replace(/\s/g,''))));if(headerRow<0)headerRow=Math.min(2,rows.length-1);
  const seen=new Map(),headers=(rows[headerRow]||[]).map((value,index)=>{const base=cleanText(value)||`열${index+1}`,count=(seen.get(base)||0)+1;seen.set(base,count);return count===1?base:`${base} (${count})`;});
  const dataRows=rows.slice(headerRow+1).filter((row)=>row.some((value)=>value!==''&&value!=null)).map((row)=>Object.fromEntries(headers.map((header,index)=>[header,row[index]??''])));
  const title=fileName.replace(/_정제\.xlsx$/i,''),pack={datasets:[{name:title,headers,rows:dataRows}]},json=JSON.stringify(pack).replace(/<\//g,'<\\/');
  const html=dashboardTemplate.replaceAll('__TITLE_TEXT__',`${title} · 데이터 대시보드`.replace(/[&<>]/g,(character)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[character]))).replace('__DATA_JSON__',json);
  return{name:title+'.html',bytes:Buffer.from(html)};
}
