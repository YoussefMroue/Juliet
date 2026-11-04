// Fictional source intake exercises the UI without transmitting document bytes.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const html=`<!doctype html><html><body><div id="root"></div><script type="module">
import {mountIntake,sourceDigest} from './intake.js';
window.saved=[];window.evidence=[];window.active=true;
window.reader=async(bytes,kind)=>({sha256:await sourceDigest(bytes),size:bytes.length,coverage:'partial',items:[{anchor:'Budget!B8',text:'Formula: =SUM(B4:B6)\\nSaved cached value: 900',method:'extracted'}],limitations:[{location:'Budget!C10',feature:'external link',message:'Dependency was not refreshed.'}]});
window.intake=mountIntake(document.querySelector('#root'),{readOffice:window.reader,context:{proposalId:'proposal-A',documentId:'document-A',document:{name:'Budget',versions:[]},assertActive(){if(!window.active)throw Error('This proposal is no longer active.');},async registerVersion(metadata){window.saved.push(metadata);return{version:{id:'version-A',...metadata}};}},onEvidence(value){window.evidence.push(value);}});
window.ready=true;
</script></body></html>`;
const server=createServer(async(req,res)=>{
  if(req.url==='/intake.js'){res.setHeader('content-type','text/javascript');res.end(await readFile(new URL('./intake.js',import.meta.url)));}
  else{res.setHeader('content-type','text/html');res.end(html);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});
  const page=await browser.newPage();
  const requests=[];
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>window.ready);
  page.on('request',req=>requests.push(req.url()));
  await page.getByLabel('Source document',{exact:true}).setInputFiles({name:'fictional-private-source.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from([1,2,3,4])});
  await page.getByRole('button',{name:'Inspect file locally',exact:true}).click();
  await page.getByText('Budget!C10: external link — Dependency was not refreshed.').waitFor();
  await page.getByRole('button',{name:'Use this source excerpt',exact:true}).click();
  await page.getByText('Add local inspection evidence',{exact:true}).click();
  await page.getByLabel('Inspected location',{exact:true}).fill('Budget!B4:B6');
  await page.getByLabel('Human-supplied evidence',{exact:true}).fill('Locally inspected the source inputs 700, 200 and 150; their independent sum is 1050.');
  await page.getByRole('button',{name:'Use human-supplied evidence',exact:true}).click();
  await page.getByLabel('Version label',{exact:true}).fill('Reviewed internal workbook');
  await page.getByRole('button',{name:'Register version and retain selected evidence',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.saved.length),0,'approval required before metadata or evidence persists');
  await page.getByLabel('I reviewed these source excerpts and limitations',{exact:true}).check();
  await page.getByLabel('Use this as the active version',{exact:true}).check();
  await page.getByRole('button',{name:'Register version and retain selected evidence',exact:true}).click();
  await page.waitForFunction(()=>window.evidence.length===1);
  const actual=await page.evaluate(()=>({saved:window.saved,evidence:window.evidence}));
  assert.equal(actual.saved[0].coverage,'partial');assert.equal(actual.saved[0].limitations[0].feature,'external link');
  assert.equal(actual.saved[0].activate,true);assert.match(actual.saved[0].sha256,/^[0-9a-f]{64}$/);
  assert.equal('sourceName' in actual.saved[0],false);assert.equal('bytes' in actual.saved[0],false);
  assert.deepEqual(actual.evidence[0].items.map(item=>item.method),['extracted','manual']);
  assert.equal(actual.evidence[0].versionId,'version-A');assert.equal(actual.evidence[0].sha256,actual.saved[0].sha256);
  assert.equal(await page.getByLabel('Source document',{exact:true}).inputValue(),'');
  await page.getByLabel('Source document',{exact:true}).setInputFiles({name:'different-proposal.xlsx',mimeType:'application/octet-stream',buffer:Buffer.from([4,3,2,1])});
  await page.evaluate(()=>{window.active=false;});
  await page.getByRole('button',{name:'Inspect file locally',exact:true}).click();
  await page.getByText('This proposal is no longer active.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.saved.length),1);
  assert.deepEqual(requests,[],'intake sends no source data or requests');
  console.log('Intake browser: approval, source identity, coverage, provenance, active selection, metadata privacy, stale context and offline processing passed.');
}finally{await browser?.close();server.close();}
