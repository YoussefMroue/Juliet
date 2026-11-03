// Usage: node web/test.mjs <synthetic input directory> <output directory>
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const [fixture, output]=process.argv.slice(2);
if(!fixture||!output) throw Error('Supply synthetic fixtures and a temporary output directory.');
// Inspect the actual downloaded ZIP rather than the page's list of files.
function zipContents(file){
  const code=`import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = [[item.filename, hashlib.sha256(archive.read(item)).hexdigest()] for item in archive.infolist()]
    assert len(set(name for name, _ in entries)) == len(entries)
    print(json.dumps(dict(entries)))`;
  return JSON.parse(execFileSync(process.env.PYTHON || 'python3',['-c',code,file],{encoding:'utf8'}));
}
function zipText(file,entry){
  return execFileSync(process.env.PYTHON || 'python3',['-c',
    'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: print(z.read(sys.argv[2]).decode())',file,entry],{encoding:'utf8'});
}
const headers=(await readFile('web/_headers','utf8')).split('\n').slice(1).filter(x=>x.trim()).map(x=>x.trim().split(/: (.*)/s).slice(0,2));
const server=createServer(async(req,res)=>{
  try{
    const file=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
    if(file.includes('..'))throw Error();
    res.writeHead(200,{...Object.fromEntries(headers),'content-type':({js:'application/javascript',mjs:'application/javascript',html:'text/html',css:'text/css',wasm:'application/wasm',json:'application/json'})[file.split('.').pop()]||'application/octet-stream'});
    res.end(await readFile(path.join('dist/site',file)));
  }catch{res.end();}
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});
try{
  for(const ext of ['pdf','docx']){
    const context=await browser.newContext({viewport:ext==='docx'?{width:390,height:844}:{width:1280,height:900}});
    const page=await context.newPage();
    page.on('pageerror',e=>console.log('Browser error:',e.message));
    page.on('console',m=>{if(m.type()==='error')console.log('Browser error:',m.text().slice(0,300));});
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled,null,{timeout:15000});
    await context.setOffline(true);
    const requests=[];page.on('request',req=>{if(/^https?:/.test(req.url()))requests.push(req.url());});
    await page.getByRole('tab',{name:'Proposal',exact:true}).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#guidelinesTab').getAttribute('aria-selected'),'true');
    assert(await page.locator('#guidelinesPanel').isVisible());
    assert.equal(await page.locator('#casePanel').isVisible(),false);
    const links=await page.locator('#guidelinesPanel a').evaluateAll(nodes=>nodes.map(a=>({url:a.href,target:a.target,rel:a.rel,referrer:a.referrerPolicy})));
    assert.equal(links.length,3);
    for(const link of links){
      assert(['www.ecfr.gov','grants.nih.gov'].includes(new URL(link.url).hostname));
      assert.equal(new URL(link.url).protocol,'https:');
      assert.equal(link.target,'_blank');assert.match(link.rel,/noopener/);assert.match(link.rel,/noreferrer/);
      assert.equal(link.referrer,'no-referrer');
    }
    assert.match(await page.locator('#guidelinesPanel').textContent(),/does not apply these sources as automated compliance rules/);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#caseTab').getAttribute('aria-selected'),'true');
    await page.locator('#sponsor').fill('NIH');await page.locator('#date').fill('2026-11-03');
    await page.locator('#budget').setInputFiles(path.join(fixture,'input.xlsx'));
    await page.locator('#justification').setInputFiles(path.join(fixture,'input.'+ext));
    await page.getByText('Inspect files',{exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled);
    console.log('File check:',await page.locator('#status').textContent());
    assert(await page.locator('#review').isVisible());
    assert.equal(await page.locator('#submissionStatus').inputValue(),'not-set');
    assert.equal(await page.locator('#submissionCase').textContent(),'Proposal: NIH-2026-11-03');
    await page.locator('#submissionStatus').selectOption('submitted');
    await page.getByRole('tab',{name:'Guidelines',exact:true}).click();
    await page.getByRole('tab',{name:'Proposal',exact:true}).click();
    assert.equal(await page.locator('#submissionStatus').inputValue(),'submitted');
    assert.deepEqual(await page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}})),{local:{},session:{}});
    let redacted=0;
    for(const row of await page.locator('.rule').all()){
      const term=await row.locator('input').first().inputValue();
      const redact=['Mira Example','mira@example.invalid'].includes(term);
      if(redact){redacted++;await row.locator('input').nth(1).fill(term.includes('@')?'Email 01':'Person 01');}
      await row.locator('select').selectOption(redact?'redact':'keep');
    }
    assert.equal(redacted,2);
    await page.locator('#inspect').click();
    await page.waitForFunction(()=>!document.querySelector('#inspect').disabled);
    console.log('Export check:',await page.locator('#status').textContent());
    assert(await page.locator('#preview').isVisible());
    assert.equal(await page.locator('#submissionStatus').inputValue(),'submitted');
    let downloads=0;
    page.on('download',()=>downloads++);
    const save=page.getByRole('button',{name:'Download approved files'});
    const backup=page.getByRole('button',{name:'Download private backup with originals'});
    assert.equal(await backup.isVisible(),false);
    await save.click();
    assert.match(await page.locator('#status').textContent(),/select the approval box/);
    assert.equal(downloads,0);
    await page.locator('#approved').check();
    async function download(button,filename){
      const [file]=await Promise.all([page.waitForEvent('download',{timeout:5000}),button.click()]);
      const filePath=path.join(output,filename);
      await file.saveAs(filePath);
      return {name:file.suggestedFilename(),entries:zipContents(filePath)};
    }
    const handoff=await download(save,'handoff-'+ext+'.zip');
    assert.equal(handoff.name,'Approved-files.zip');
    const approvedNames=['Budget.xlsx','Justification.'+ext];
    assert.deepEqual(Object.keys(handoff.entries).sort(),approvedNames);
    assert.equal(await page.locator('#submissionStatus').inputValue(),'submitted');
    const roundKey='proposal-review:last-round:NIH-2026-11-03';
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),roundKey),null);
    await page.locator('#privateBackup summary').click();
    await backup.click();
    await page.waitForFunction(()=>!document.querySelector('#backup').disabled);
    assert.match(await page.locator('#status').textContent(),/Confirm that the private backup/);
    assert.equal(downloads,1);
    await page.locator('#includeOriginals').check();
    const privateBackup=await download(backup,'round-'+ext+'.zip');
    assert.equal(privateBackup.name,'Private-NIH-2026-11-03-Round-00001.zip');
    const prefix='NIH-2026-11-03/Reviews/Round-00001/';
    for(const name of approvedNames){
      const original=await readFile(path.join(fixture,'input'+path.extname(name)));
      const sourceHash=createHash('sha256').update(original).digest('hex');
      assert.equal(privateBackup.entries[prefix+'01 Sources/'+name],sourceHash);
      assert.notEqual(handoff.entries[name],sourceHash);
      assert.equal(handoff.entries[name],privateBackup.entries[prefix+'03 Redacted/'+name]);
    }
    assert(Object.hasOwn(privateBackup.entries,prefix+'Review record.txt'));
    assert.match(zipText(path.join(output,'round-'+ext+'.zip'),prefix+'Review record.txt'),/Submission status \(user-set snapshot; not compliance or review approval\): Submitted/);
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),roundKey),'1');
    assert.equal(await page.locator('#includeOriginals').isChecked(),false);
    assert.equal(await page.locator('#submissionStatus').inputValue(),'submitted');
    await page.locator('#submissionStatus').selectOption('withdrawn');
    await page.locator('#includeOriginals').check();
    const second=await download(backup,'round-2-'+ext+'.zip');
    assert.equal(second.name,'Private-NIH-2026-11-03-Round-00002.zip');
    assert.match(zipText(path.join(output,'round-2-'+ext+'.zip'),'NIH-2026-11-03/Reviews/Round-00002/Review record.txt'),/approval\): Withdrawn/);
    assert.match(zipText(path.join(output,'round-'+ext+'.zip'),prefix+'Review record.txt'),/approval\): Submitted/);
    assert.deepEqual(await page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}})),{local:{[roundKey]:'2'},session:{}});
    assert.deepEqual(await page.evaluate(()=>indexedDB.databases()),[]);
    assert.deepEqual(await context.cookies(),[]);
    assert.deepEqual(requests,[]);
    // Closing/reloading must not restore status or attach it to a different proposal.
    await context.setOffline(false);
    await page.locator('#reset').click();
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled,null,{timeout:15000});
    assert.equal(await page.locator('#submissionStatus').inputValue(),'not-set');
    assert.equal(await page.locator('#submission').isVisible(),false);
    await context.setOffline(true);requests.length=0;
    await page.locator('#sponsor').fill('NIH');await page.locator('#date').fill('2026-11-03');
    await page.locator('#sequence').fill('2');
    await page.locator('#budget').setInputFiles(path.join(fixture,'input.xlsx'));
    await page.locator('#justification').setInputFiles(path.join(fixture,'input.'+ext));
    await page.getByText('Inspect files',{exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled);
    assert.equal(await page.locator('#submissionCase').textContent(),'Proposal: NIH-2026-11-03-02');
    assert.equal(await page.locator('#submissionStatus').inputValue(),'not-set');
    assert.deepEqual(requests,[]);
    console.log(ext,'offline workflow passed');await context.close();
  }
}finally{await browser.close();server.close();}
