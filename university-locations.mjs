import XLSX from '@e965/xlsx';
import { readFile } from 'node:fs/promises';

const DEFAULT_LOCATION_URL='https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003547770&fileDetailSn=1&insertDataPrcus=N';
const CACHE_TTL=24*60*60*1000;
let cache={loadedAt:0,rows:[]},pending=null;
const text=(value)=>String(value??'').replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim();

function parseLocations(bytes){
  const workbook=XLSX.read(bytes,{type:'buffer'}),sheet=workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet,{raw:false,defval:''}).filter((row)=>text(row['학교구분'])==='대학'&&['기존','신설'].includes(text(row['학교상태']))).map((row)=>({
    school:text(row['학교명']),campus:text(row['본분교']),region:text(row['지역']),address:text(row['도로명 주소']||row['도로명주소']||row['지번주소']),
    latitude:Number(row['위도']),longitude:Number(row['경도']),source:'교육부 대학교 주소기반 좌표정보'
  })).filter((row)=>row.school&&row.address&&row.latitude>=30&&row.latitude<=40&&row.longitude>=120&&row.longitude<=135);
}

export async function loadUniversityLocations(){
  if(cache.rows.length&&Date.now()-cache.loadedAt<CACHE_TTL)return cache.rows;
  if(pending)return pending;
  pending=(async()=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25_000);let bundled=[];try{
    const local=JSON.parse(await readFile(new URL('./data/university-locations.json',import.meta.url),'utf8'));bundled=Array.isArray(local)?local:Array.isArray(local.rows)?local.rows:[];
    const response=await fetch(process.env.UNIVERSITY_LOCATION_URL||DEFAULT_LOCATION_URL,{signal:controller.signal,headers:{'user-agent':'AcademyDataDashboard/1.0'}});
    if(!response.ok)throw new Error(`대학 주소 데이터 요청 실패 (HTTP ${response.status})`);
    const rows=parseLocations(Buffer.from(await response.arrayBuffer()));if(!rows.length)throw new Error('대학 주소 데이터가 비어 있습니다.');
    cache={loadedAt:Date.now(),rows};return rows;
  }catch(error){if(!bundled.length)throw error;console.warn(`대학 주소 원격 갱신 실패, 내장 데이터 ${bundled.length}건 사용: ${error.message}`);cache={loadedAt:Date.now(),rows:bundled};return bundled;
  }finally{clearTimeout(timer);pending=null;}})();
  return pending;
}
