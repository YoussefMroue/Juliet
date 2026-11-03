// Usage: node web/lynn.test.mjs <fictional Lynn fixture directory> <output directory>
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const [fixture,output]=process.argv.slice(2);
if(!fixture||!output)throw Error('Supply fictional fixtures and a temporary output directory.');
const headers=Object.fromEntries((await readFile('web/_headers','utf8')).split('\n').slice(1).filter(x=>x.trim()).map(x=>x.trim().split(/: (.*)/s).slice(0,2)));
const server=createServer(async(req,res)=>{
  const file=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  try{
    if(file.includes('..'))throw Error();
    const data=await readFile(path.join('dist/site',file));
    res.writeHead(200,{...headers,'content-type':({js:'application/javascript',mjs:'application/javascript',html:'text/html',css:'text/css',wasm:'application/wasm',json:'application/json'})[file.split('.').pop()]||'application/octet-stream'});
    res.end(data);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH,channel:process.env.PLAYWRIGHT_CHANNEL});
try{
  for(const width of [1280,390]){
    const context=await browser.newContext({viewport:{width,height:900}});
    const page=await context.newPage(),errors=[],requests=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled);
    await context.setOffline(true);
    page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
    await page.locator('#sponsor').fill('NIH');await page.locator('#date').fill('2026-11-03');
    await page.locator('#budget').setInputFiles(path.join(fixture,'input.xlsx'));
    await page.locator('#justification').setInputFiles(path.join(fixture,'input.docx'));
    await page.getByText('Inspect files',{exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled);
    await page.locator('#useLynnWorkflow').check();
    assert.match(await page.locator('#lynnSheets').textContent(),/Project and TU Year One found/);
    assert.match(await page.locator('#lynnOriginal').textContent(),/Project!F7.*immune response pilot/);
    await page.locator('#submissionStatus').selectOption('submitted');
    for(const row of await page.locator('.rule').all())await row.locator('select').selectOption('keep');
    async function preview(error){
      await page.locator('#inspect').click();
      await page.waitForFunction(()=>!document.querySelector('#inspect').disabled);
      if(error){assert.match(await page.locator('#status').textContent(),error);assert.equal(await page.locator('#preview').isVisible(),false);}
      else assert(await page.locator('#preview').isVisible());
    }
    await preview(/Cayuse record/);
    await page.locator('#cayuseChecked').check();await page.locator('#guidanceGathered').check();
    await preview(/Verify all salaries in Waveworks/);
    await page.locator('#salariesVerified').check();
    await preview(/Enter the PI name/);
    await page.locator('#projectPi').fill('Mira Example');await page.locator('#projectTitle').fill('not the actual title');
    await page.locator('#addProjectIdentifiers').click();
    await preview(/Enter the project title as it appears/);
    await page.locator('#projectTitle').fill('immune response pilot');
    await page.locator('#addProjectIdentifiers').click();
    for(const row of await page.locator('.rule').all()){
      const term=await row.locator('input').first().inputValue();
      if(['Noor Fictional','mira@example.invalid'].includes(term))await row.locator('select').selectOption('redact');
    }
    for(const [term,label] of [['XQ-417','Employee 01'],['MX','Person PI']]){
      await page.locator('#add').click();const row=page.locator('.rule').last();
      await row.locator('input').nth(0).fill(term);await row.locator('input').nth(1).fill(label);
    }
    await preview(/confirm every personnel name/);
    await page.locator('#personnelCovered').check();await preview();
    await page.locator('#approved').check();
    await page.locator('#salariesVerified').uncheck();
    assert.equal(await page.locator('#preview').isVisible(),false);
    assert.equal(await page.locator('#approved').isChecked(),false);
    await preview(/Verify all salaries in Waveworks/);
    await page.locator('#salariesVerified').check();
    const piRow=page.locator('.rule').filter({has:page.locator('input')});
    for(const row of await piRow.all()){
      if(await row.locator('input').first().inputValue()==='Mira Example')await row.locator('select').selectOption('keep');
    }
    await page.locator('#personnelCovered').check();await preview(/Select the PI name for redaction/);
    await page.locator('#addProjectIdentifiers').click();
    assert.equal(await page.locator('#personnelCovered').isChecked(),false);
    await page.locator('#personnelCovered').check();await preview();
    await page.getByRole('tab',{name:'Guidelines',exact:true}).click();
    await page.getByRole('tab',{name:'Proposal',exact:true}).click();
    assert(await page.locator('#salariesVerified').isChecked());
    assert.equal(await page.locator('#submissionStatus').inputValue(),'submitted');
    assert.equal(await page.locator('#feedback').getAttribute('href'),'mailto:ymroue9@gmail.com');
    assert.deepEqual(await page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}})),{local:{},session:{}});
    await page.locator('#approved').check();
    async function download(id,name){
      const [file]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);
      const dest=path.join(output,name+'-'+width+'.zip');await file.saveAs(dest);return dest;
    }
    const handoff=await download('save','lynn-handoff');
    await page.locator('#privateBackup summary').click();await page.locator('#includeOriginals').check();
    const backup=await download('backup','lynn-private');
    // Reopen exported Office files independently, preserving numeric cells and formula text.
    execFileSync(process.env.PYTHON||'python3',['-c',`import io, sys, zipfile
from pathlib import Path
from openpyxl import load_workbook
from docx import Document
handoff, backup, fixture = sys.argv[1:]
with zipfile.ZipFile(handoff) as z, zipfile.ZipFile(backup) as private:
 assert sorted(z.namelist()) == ['Budget.xlsx', 'Justification.docx']
 book = load_workbook(io.BytesIO(z.read('Budget.xlsx')))
 assert book['Project']['C3'].value != 'Mira Example'
 assert book['Project']['F7'].value == 'Project 01'
 assert book['TU Year One']['B2'].value == 700
 assert book['TU Year One']['B5'].value == 150
 assert book['TU Year One']['B4'].value == '=SUM(B2:B3,B5)'
 assert book['TU Year One']['A5'].value != 'Noor Fictional'
 doc = Document(io.BytesIO(z.read('Justification.docx')))
 assert 'Project 01' in '\\n'.join(p.text for p in doc.paragraphs)
 for name in z.namelist():
  with zipfile.ZipFile(io.BytesIO(z.read(name))) as office:
   xml = '\\n'.join(office.read(p).decode() for p in office.namelist() if p.endswith('.xml'))
   for term in ['Mira Example','Noor Fictional','immune response pilot','mira@example.invalid','XQ-417']:
    assert term not in xml, term
  prefix = 'NIH-2026-11-03/Reviews/Round-00001/'
  assert private.read(prefix+'01 Sources/'+name) == (Path(fixture)/('input'+Path(name).suffix)).read_bytes()
 record = private.read(prefix+'Review record.txt').decode()
 assert 'NIH R01 checklist — human-confirmed' in record
 assert 'immune response pilot' not in record and 'Mira Example' not in record
`,handoff,backup,fixture]);
    await page.locator('#useLynnWorkflow').uncheck();
    assert.equal(await page.locator('#preview').isVisible(),false);
    await page.locator('#useLynnWorkflow').check();
    assert.equal(await page.locator('#salariesVerified').isChecked(),false);
    assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);
    await context.setOffline(false);await page.locator('#reset').click();
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled);
    assert.equal(await page.locator('#useLynnWorkflow').isChecked(),false);
    assert.equal(await page.locator('#projectPi').inputValue(),'');
    assert.equal(await page.locator('#projectTitle').inputValue(),'');
    await context.close();console.log('Lynn NIH R01 workflow passed at width',width);
  }
}finally{await browser.close();server.close();}
