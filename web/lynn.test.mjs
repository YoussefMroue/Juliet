// Usage: node web/lynn.test.mjs <fictional Lynn fixture directory> <output directory>
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const [fixture,output]=process.argv.slice(2);
if(!fixture||!output)throw Error('Supply fictional fixtures and a temporary output directory.');
// Distinct people, title and amounts in same-named files expose cross-case leakage.
const otherPair=JSON.parse(execFileSync(process.env.PYTHON||'python3',['-c',`import base64, io, json
from openpyxl import Workbook
from docx import Document
book = Workbook()
project = book.active
project.title = 'Project'
project['C3'] = 'Avery Sample'
project['F7'] = 'nutrient maps'
people = book.create_sheet('TU Year One')
people['A2'] = 'Avery Sample'
people['B2'] = 275
doc = Document()
doc.add_paragraph('Avery Sample requests 275 for nutrient maps.')
def data(obj):
    output = io.BytesIO()
    obj.save(output)
    return base64.b64encode(output.getvalue()).decode()
print(json.dumps([data(book), data(doc)]))`],{encoding:'utf8'}));
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
    await context.addInitScript(()=>{window.showDirectoryPicker=()=>navigator.storage.getDirectory();});
    const page=await context.newPage(),errors=[],requests=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled);
    await context.setOffline(true);
    page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
    const portfolio=page.locator('#portfolio');
    const portfolioButton=name=>portfolio.getByRole('button',{name,exact:true});
    await portfolioButton('Open portfolio folder').click();
    const labels=['NIH-2026-11-03','NIH-2026-11-03-02'];
    for(const [i,label] of labels.entries()){
      await portfolio.getByText('Create a proposal',{exact:true}).click();
      const form=portfolio.locator('form').filter({has:page.getByRole('button',{name:'Create proposal',exact:true})});
      await form.getByLabel('Sponsor initials').fill('NIH');
      await form.getByLabel('Original submission date').fill('2026-11-03');
      await form.getByLabel('Proposal sequence').fill(String(i+1));
      await form.getByLabel('Proposal status').selectOption(i===0?'Submitted':'Drafting');
      await form.getByRole('button',{name:'Create proposal',exact:true}).click();
      await portfolio.getByRole('heading',{name:label+' workspace',exact:true}).waitFor();
    }
    await portfolioButton('Open '+labels[0]).click();
    if(width===1280){
      await portfolioButton('Prepare budget and justification').click();
    }else{
      await page.getByRole('tab',{name:'Prepare files',exact:true}).click();
      await page.locator('#sponsor').fill('NIH');await page.locator('#date').fill('2026-11-03');
    }
    await page.locator('#budget').setInputFiles(path.join(fixture,'input.xlsx'));
    await page.locator('#justification').setInputFiles(path.join(fixture,'input.docx'));
    await page.getByText('Inspect files',{exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled);
    assert(await page.locator('#lynnPilotNotice').isVisible());
    const checklist=page.locator('#useLynnWorkflow');
    assert.match(await checklist.getAttribute('aria-describedby'), /lynnPilotNotice/);
    assert.match(await page.locator('#lynnPilotNotice').innerText(), /permitted local environment and data.*does not establish institutional authorization or verify the workbook calculations/);
    await checklist.check();
    assert.match(await page.locator('#lynnSheets').textContent(),/Project and TU Year One found/);
    assert.match(await page.locator('#lynnOriginal').textContent(),/Project!F7.*immune response pilot/);
    if(width===1280)assert.match(await page.locator('#boundStatus').textContent(),/Submitted/);
    else await page.locator('#submissionStatus').selectOption('submitted');
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
    await preview(/Enter the complete PI name/);
    // Substrings that the real short-token matcher would never redact must fail.
    await page.locator('#projectPi').fill('ir');await page.locator('#projectTitle').fill('mm');
    await page.locator('#personnelCovered').check();
    await preview(/Enter the complete PI name/);
    assert.equal(await page.locator('#approved').isChecked(),false);
    await page.locator('#projectPi').fill('Mira Example');await page.locator('#projectTitle').fill('not the actual title');
    await page.locator('#addProjectIdentifiers').click();
    await preview(/Enter the complete project title/);
    await page.locator('#projectTitle').fill('immune response pilot');
    await page.locator('#addProjectIdentifiers').click();
    for(const row of await page.locator('.rule').all()){
      const term=await row.locator('input').first().inputValue();
      if(term==='Noor Fictional')await row.locator('select').selectOption('blank');
      if(term==='mira@example.invalid')await row.locator('select').selectOption('redact');
      if(term==='not the actual title')await row.locator('select').selectOption('keep');
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
    await page.locator('#personnelCovered').check();await preview(/Select Blank cell for the PI name/);
    await page.locator('#addProjectIdentifiers').click();
    assert.equal(await page.locator('#personnelCovered').isChecked(),false);
    await page.locator('#personnelCovered').check();await preview();
    assert.match(await page.locator('#changes').textContent(),/\[blank cell\]/);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.getByRole('tab',{name:'Guidelines',exact:true}).click();
    await page.getByRole('tab',{name:'Prepare files',exact:true}).click();
    assert(await page.locator('#salariesVerified').isChecked());
    if(width===1280)assert.match(await page.locator('#boundStatus').textContent(),/Submitted/);
    else assert.equal(await page.locator('#submissionStatus').inputValue(),'submitted');
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
handoff, backup, fixture, width = sys.argv[1:]
with zipfile.ZipFile(handoff) as z, zipfile.ZipFile(backup) as private:
 roots = {entry.split('/')[0] for entry in private.namelist()}
 assert len(roots) == 1
 root = roots.pop()
 prefix = root + '/Reviews/Round-00001/'
 record = private.read(prefix+'Review record.txt').decode()
 if width == '1280':
  proposal_id = next(line.removeprefix('Portfolio proposal ID: ') for line in record.splitlines() if line.startswith('Portfolio proposal ID: '))
  assert root == 'NIH-2026-11-03_' + proposal_id
 else:
  assert root == 'NIH-2026-11-03'
 assert sorted(z.namelist()) == ['Budget.xlsx', 'Justification.docx']
 book = load_workbook(io.BytesIO(z.read('Budget.xlsx')))
 assert book['Project']['C3'].value is None
 assert book['Project']['F7'].value is None
 assert book['TU Year One']['A2'].value is None
 assert book['TU Year One']['B2'].value == 700
 assert book['TU Year One']['B5'].value == 150
 assert book['TU Year One']['B4'].value == '=SUM(B2:B3,B5)'
 assert book['TU Year One']['A5'].value is None
 doc = Document(io.BytesIO(z.read('Justification.docx')))
 assert 'Project 01' in '\\n'.join(p.text for p in doc.paragraphs)
 for name in z.namelist():
  with zipfile.ZipFile(io.BytesIO(z.read(name))) as office:
   xml = '\\n'.join(office.read(p).decode() for p in office.namelist() if p.endswith('.xml'))
   for term in ['Mira Example','Noor Fictional','immune response pilot','mira@example.invalid','XQ-417']:
    assert term not in xml, term
  assert private.read(prefix+'01 Sources/'+name) == (Path(fixture)/('input'+Path(name).suffix)).read_bytes()
 assert 'NIH R01 checklist — human-confirmed' in record
 assert 'immune response pilot' not in record and 'Mira Example' not in record
`,handoff,backup,fixture,String(width)]);
    await page.locator('#useLynnWorkflow').uncheck();
    assert.equal(await page.locator('#preview').isVisible(),false);
    await preview(/Blank cell requires/);
    await page.locator('#useLynnWorkflow').check();
    assert.equal(await page.locator('#salariesVerified').isChecked(),false);
    for(const id of ['cayuseChecked','guidanceGathered','salariesVerified','personnelCovered'])await page.locator('#'+id).check();
    await preview();
    await page.locator('#approved').check();
    await page.getByRole('tab',{name:'Portfolio',exact:true}).click();
    await portfolioButton('Open '+labels[1]).click();
    await portfolioButton('Prepare budget and justification').click();
    assert.equal(await page.locator('#budget').inputValue(),'');
    assert.equal(await page.locator('#justification').inputValue(),'');
    for(const id of ['lynnOriginal','lynnSheets','original','rules','checked','changes'])assert.equal(await page.locator('#'+id).textContent(),'');
    for(const id of ['useLynnWorkflow','cayuseChecked','guidanceGathered','salariesVerified','personnelCovered','approved'])assert.equal(await page.locator('#'+id).isChecked(),false);
    for(const id of ['projectPi','projectTitle'])assert.equal(await page.locator('#'+id).inputValue(),'');
    for(const [i,id,extension] of [[0,'budget','xlsx'],[1,'justification','docx']]){
      await page.locator('#'+id).setInputFiles({name:'input.'+extension,mimeType:'application/octet-stream',buffer:Buffer.from(otherPair[i],'base64')});
    }
    await page.getByText('Inspect files',{exact:true}).click();
    await page.locator('#useLynnWorkflow').check();
    assert.match(await page.locator('#boundStatus').textContent(),/Drafting/);
    assert.match(await page.locator('#lynnOriginal').textContent(),/nutrient maps/);
    assert.doesNotMatch(await page.locator('#lynnOriginal').textContent(),/Mira Example|immune response pilot|Noor Fictional/);
    for(const row of await page.locator('.rule').all())await row.locator('select').selectOption('keep');
    await preview(/Cayuse record/);
    await page.locator('#projectPi').fill('Avery Sample');
    await page.locator('#projectTitle').fill('nutrient maps');
    await page.locator('#addProjectIdentifiers').click();
    for(const id of ['cayuseChecked','guidanceGathered','salariesVerified','personnelCovered'])await page.locator('#'+id).check();
    await preview();
    assert.match(await page.locator('#exportCase').textContent(),new RegExp(labels[1]));
    assert.match(await page.locator('#changes').textContent(),/Avery Sample/);
    assert.doesNotMatch(await page.locator('#changes').textContent(),/Mira Example|immune response pilot/);
    assert.equal(await page.locator('#approved').isChecked(),false);
    await page.locator('#reset').click();
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled);
    assert.equal(await page.locator('#useLynnWorkflow').isChecked(),false);
    assert.equal(await page.locator('#projectPi').inputValue(),'');
    assert.equal(await page.locator('#projectTitle').inputValue(),'');
    assert.equal(await page.locator('#lynnOriginal').textContent(),'');
    assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);
    await context.close();console.log('Lynn NIH R01 workflow passed at width',width);
  }
}finally{await browser.close();server.close();}
