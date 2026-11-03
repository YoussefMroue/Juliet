// Usage: node web/test.mjs <synthetic input directory> <output directory>
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const [fixture, output]=process.argv.slice(2);
if(!fixture||!output) throw Error('Supply synthetic fixtures and a temporary output directory.');
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
const browser=await chromium.launch();
try{
  for(const ext of ['pdf','docx']){
    const context=await browser.newContext();
    const page=await context.newPage();
    page.on('pageerror',e=>console.log('Browser error:',e.message));
    page.on('console',m=>{if(m.type()==='error')console.log('Browser error:',m.text().slice(0,300));});
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled,null,{timeout:15000});
    await context.setOffline(true);
    const requests=[];page.on('request',req=>{if(/^https?:/.test(req.url()))requests.push(req.url());});
    await page.locator('#sponsor').fill('NIH');await page.locator('#date').fill('2026-11-03');
    await page.locator('#budget').setInputFiles(path.join(fixture,'input.xlsx'));
    await page.locator('#justification').setInputFiles(path.join(fixture,'input.'+ext));
    await page.getByText('Inspect files',{exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled);
    console.log('File check:',await page.locator('#status').textContent());
    assert(await page.locator('#review').isVisible());
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
    await page.locator('#approved').check();
    const download=page.waitForEvent('download',{timeout:5000});
    await page.locator('#save').click();console.log(await page.locator('#status').textContent());
    await (await download).saveAs(path.join(output,'round-'+ext+'.zip'));
    assert.deepEqual(requests,[]);
    console.log(ext,'offline workflow passed');await context.close();
  }
}finally{await browser.close();server.close();}
