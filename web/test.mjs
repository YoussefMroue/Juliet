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
  // Only the native folder picker is substituted; Chromium performs real file writes
  // and Web Locks on an isolated test directory in its temporary profile.
  const portfolioContext=await browser.newContext();
  await portfolioContext.addInitScript(()=>{
    window.showDirectoryPicker=async()=>navigator.storage.getDirectory();
  });
  const portfolioPage=await portfolioContext.newPage();
  await portfolioPage.goto('http://127.0.0.1:'+server.address().port);
  await portfolioPage.waitForFunction(()=>!document.querySelector('#pick').disabled);
  await portfolioContext.setOffline(true);
  const portfolioRequests=[];
  portfolioPage.on('request',request=>portfolioRequests.push(request.url()));
  const portfolio=portfolioPage.locator('#portfolio');
  const portfolioButton=name=>portfolio.getByRole('button',{name,exact:true});
  await portfolioButton('Open portfolio folder').click();
  const first='NIH-2026-11-03', second='NIH-2026-11-03-02';
  for(const [index,label] of [first,second].entries()){
    await portfolio.getByText('Create a proposal',{exact:true}).click();
    const create=portfolio.locator('form').filter({has:portfolioPage.getByRole('button',{name:'Create proposal',exact:true})});
    await create.getByLabel('Sponsor initials').fill('NIH');
    await create.getByLabel('Original submission date').fill('2026-11-03');
    await create.getByLabel('Proposal sequence').fill(String(index+1));
    await create.getByLabel('Next action').fill(index===0?'Check salary totals':'Check subaward roster');
    await create.getByLabel('Proposal status').selectOption(index===0?'In review':'Drafting');
    await create.getByRole('button',{name:'Create proposal',exact:true}).click();
    await portfolio.getByRole('heading',{name:label+' workspace',exact:true}).waitFor();
  }
  await portfolioButton('Open '+first).click();
  await portfolioButton('Prepare budget and justification').click();
  assert.match(await portfolioPage.locator('#boundCase').textContent(),new RegExp(first));
  assert.equal(await portfolioPage.locator('#sponsor').isEditable(),false);
  await portfolioPage.locator('#budget').setInputFiles(path.join(fixture,'input.xlsx'));
  await portfolioPage.locator('#justification').setInputFiles(path.join(fixture,'input.docx'));
  await portfolioPage.getByRole('button',{name:'Inspect files',exact:true}).click();
  await portfolioPage.locator('#review').waitFor();
  assert.match(await portfolioPage.locator('#boundStatus').textContent(),/In review/);
  for(const choice of await portfolioPage.locator('.rule select').all())await choice.selectOption('keep');
  await portfolioPage.locator('#inspect').click();
  await portfolioPage.locator('#approved').check();
  await portfolioPage.getByRole('tab',{name:'Portfolio',exact:true}).click();
  await portfolioButton('Open '+second).click();
  await portfolioButton('Prepare budget and justification').click();
  assert.match(await portfolioPage.locator('#boundCase').textContent(),new RegExp(second));
  assert.equal(await portfolioPage.locator('#sequence').inputValue(),'2');
  assert.equal(await portfolioPage.locator('#budget').inputValue(),'');
  assert.equal(await portfolioPage.locator('#justification').inputValue(),'');
  assert.equal(await portfolioPage.locator('#preview').isVisible(),false);
  assert.equal(await portfolioPage.locator('#approved').isChecked(),false);
  for(const id of ['rules','changes','original','checked'])assert.equal(await portfolioPage.locator('#'+id).textContent(),'');
  await portfolioPage.getByRole('tab',{name:'Portfolio',exact:true}).click();
  await portfolioButton('Close portfolio').click();
  await portfolioButton('Open portfolio folder').click();
  await portfolioButton('Open '+second).waitFor();
  assert.match(await portfolio.locator('article').filter({has:portfolioPage.getByRole('button',{name:'Open '+first,exact:true})}).textContent(),/Check salary totals/);
  assert.match(await portfolio.locator('article').filter({has:portfolioPage.getByRole('button',{name:'Open '+second,exact:true})}).textContent(),/Check subaward roster/);
  assert.equal(await portfolioPage.locator('#boundCase').textContent(),'');

  async function addDocument(category,name){
    await portfolio.getByText('Add a requirement',{exact:true}).click();
    const form=portfolio.locator('form').filter({has:portfolioPage.getByRole('button',{name:'Add requirement',exact:true})});
    await form.getByLabel('Document category').selectOption(category);
    await form.getByLabel('Document label').fill(name);
    await form.getByLabel('Applicability').selectOption('Required');
    await form.getByRole('button',{name:'Add requirement',exact:true}).click();
    const card=portfolio.locator('article').filter({has:portfolioPage.getByRole('heading',{name,exact:true})});
    await card.getByText('Versions and requirement details',{exact:true}).click();
    await card.getByLabel('Version label').fill('Original');
    await card.getByRole('button',{name:'Record version',exact:true}).click();
    await card.getByText(/Required · v1 · Original/).waitFor();
  }
  async function freezeRound(){
    await portfolio.getByText('Record an inventory snapshot',{exact:true}).click();
    await portfolio.getByLabel('Round label').fill('First review');
    await portfolioButton('Record snapshot').click();
    await portfolio.getByText('Round 1 · First review',{exact:true}).waitFor();
  }
  async function openRound(){
    await portfolio.getByText('Round 1 · First review',{exact:true}).click();
    await portfolioButton('Review this round').click();
  }
  await portfolioButton('Open '+first).click();
  await addDocument('Budget','Fabrication budget');
  await addDocument('Opportunity guidance','Invented instructions');
  await freezeRound();
  await openRound();
  const exchange=portfolioPage.locator('#round-exchange');
  const excerpts=[
    ['Fabrication budget · v1','Budget!B7','Requested amount is 1200.'],
    ['Invented instructions · v1','Section 2','The total cost ceiling is 1000.']
  ];
  for(const [doc,anchor,excerpt] of excerpts){
    await exchange.getByLabel('Document version').selectOption({label:doc});
    await exchange.getByLabel('Page, paragraph or sheet and cell').fill(anchor);
    await exchange.getByLabel('Fictional excerpt',{exact:true}).fill(excerpt);
    await exchange.getByRole('button',{name:'Add excerpt',exact:true}).click();
  }
  await exchange.getByRole('checkbox').check();
  const [download]=await Promise.all([portfolioPage.waitForEvent('download'),exchange.getByRole('button',{name:'Register and download fictional packet'}).click()]);
  const packetPath=path.join(output,download.suggestedFilename());
  await download.saveAs(packetPath);
  const packet=JSON.parse(await readFile(packetPath,'utf8'));
  assert.deepEqual(packet.items.map(i=>i.text),excerpts.map(e=>e[2]));
  const {reviewerRelease,proposalId,roundId,packetId,reportId,digest}=packet;
  const report={format:'juliet.findings.v1', reviewerRelease,proposalId,roundId,packetId,reportId,digest,
    coverage:{reviewed:['E1','E2'],unreviewed:[]},
    findings:[{type:'objective_error',message:'Requested amount exceeds the fictional ceiling by 200.',
      evidence:[{itemId:'E1',quote:excerpts[0][2]}],guidance:[{itemId:'E2',quote:excerpts[1][2]}]}]};
  const returned={name:'findings.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(report))};
  async function checkReport(){
    await exchange.getByLabel('Returned findings JSON').setInputFiles(returned);
    await exchange.getByRole('button',{name:'Check packet and report'}).click();
  }
  await exchange.getByLabel('Original registered fictional packet').setInputFiles(packetPath);
  await checkReport();
  await exchange.getByRole('button',{name:'Save verified report to this round'}).waitFor();
  await exchange.getByLabel('Page, paragraph or sheet and cell').fill('Section 3');
  await exchange.getByLabel('Fictional excerpt',{exact:true}).fill('A fictional agency will announce the award in June.');
  await exchange.getByRole('button',{name:'Add excerpt',exact:true}).click();
  await exchange.getByRole('checkbox').check();
  const [newPacket]=await Promise.all([portfolioPage.waitForEvent('download'),exchange.getByRole('button',{name:'Register and download fictional packet'}).click()]);
  assert.notEqual(newPacket.suggestedFilename(),download.suggestedFilename());
  assert.equal(await exchange.getByRole('button',{name:'Save verified report to this round'}).isVisible(),false);
  assert.equal(await exchange.getByLabel('Original registered fictional packet').inputValue(),'');
  assert.equal(await exchange.getByLabel('Returned findings JSON').inputValue(),'');
  await portfolioPage.getByRole('tab',{name:'Guidelines',exact:true}).click();
  assert.equal(await exchange.textContent(),'');
  await portfolioPage.getByRole('tab',{name:'Portfolio',exact:true}).click();
  await openRound();
  await exchange.getByLabel('Original registered fictional packet').setInputFiles(packetPath);
  await checkReport();
  await exchange.getByRole('button',{name:'Save verified report to this round'}).waitFor();
  assert((await exchange.textContent()).includes(excerpts[1][2]));
  await exchange.getByRole('button',{name:'Save verified report to this round'}).click();
  await portfolio.getByText('Report '+reportId,{exact:true}).waitFor({state:'attached'});
  await portfolio.getByText('Round 1 · First review',{exact:true}).click();
  await portfolio.getByText('Report '+reportId,{exact:true}).click();
  await portfolio.getByText('Record a finding decision',{exact:true}).click();
  const decision=portfolio.locator('form').filter({has:portfolioPage.getByRole('button',{name:'Save decision',exact:true})});
  await decision.getByRole('combobox').selectOption('Accepted');
  await portfolio.getByLabel('Decision note').fill('Compared requested amount with the supplied ceiling.');
  await portfolioButton('Save decision').click();
  await portfolio.getByText(/Accepted · Compared requested amount/).waitFor({state:'attached'});
  await portfolio.getByText('Round 1 · First review',{exact:true}).click();
  await portfolio.getByText(/Accepted · Compared requested amount/).waitFor();
  await portfolioButton('Open '+second).click();
  assert.equal(await exchange.textContent(),'');
  assert.equal(await portfolio.getByText(report.findings[0].message,{exact:true}).count(),0);
  await addDocument('Budget','Fabrication budget');
  await freezeRound();
  await openRound();
  await exchange.getByLabel('Original registered fictional packet').setInputFiles(packetPath);
  await checkReport();
  await exchange.getByText(/belongs to another proposal or review round/).waitFor();
  assert.equal(await exchange.getByRole('button',{name:'Save verified report to this round'}).isVisible(),false);
  assert.deepEqual(portfolioRequests,[]);
  await portfolioContext.close();
  console.log('Two-proposal offline preparation, packet, findings, disposition and isolation passed');
  for(const ext of ['pdf','docx']){
    const context=await browser.newContext({viewport:ext==='docx'?{width:390,height:844}:{width:1280,height:900},hasTouch:ext==='docx'});
    const page=await context.newPage();
    async function checkFeedback(){
      const feedback=page.getByRole('link',{name:'Email feedback to ymroue9@gmail.com',exact:true});
      assert(await feedback.isVisible());
      // Exact URI excludes subject/body, attachments and any dynamic case metadata.
      assert.equal(await feedback.getAttribute('href'),'mailto:ymroue9@gmail.com');
      const box=await feedback.boundingBox(), viewport=page.viewportSize();
      assert(box.width>=44 && box.height>=44);
      assert(box.x>=0 && box.y>=0 && box.x+box.width<=viewport.width && box.y+box.height<=viewport.height);
      // Intercept activation rather than launching an external email client in the test.
      await feedback.evaluate(link=>{
        window.feedbackActivated=false;
        link.addEventListener('click',event=>{event.preventDefault();window.feedbackActivated=true;},{once:true});
      });
      if(ext==='docx')await feedback.tap();else await feedback.click();
      assert.equal(await page.evaluate(()=>window.feedbackActivated),true);
      await feedback.evaluate(link=>{
        window.feedbackActivated=false;
        link.addEventListener('click',event=>{event.preventDefault();window.feedbackActivated=true;},{once:true});
      });
      await feedback.focus();await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(()=>window.feedbackActivated),true);
    }
    page.on('pageerror',e=>console.log('Browser error:',e.message));
    page.on('console',m=>{if(m.type()==='error')console.log('Browser error:',m.text().slice(0,300));});
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled,null,{timeout:15000});
    await context.setOffline(true);
    const requests=[];page.on('request',req=>{if(/^https?:/.test(req.url()))requests.push(req.url());});
    assert.equal(await page.title(),'Juliet · Personal Proposal Reviewer');
    assert(await page.getByRole('heading',{name:'Juliet',exact:true}).isVisible());
    assert.equal(await page.locator('#portfolioTab').getAttribute('aria-selected'),'true');
    await checkFeedback();
    await page.getByRole('tab',{name:'Prepare files',exact:true}).click();
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
    await checkFeedback(); // Guidelines, including the phone viewport.
    await page.locator('#guidelinesTab').focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#caseTab').getAttribute('aria-selected'),'true');
    await page.locator('#sponsor').fill('NIH');await page.locator('#date').fill('2026-11-03');
    await page.locator('#budget').setInputFiles(path.join(fixture,'input.xlsx'));
    await page.locator('#justification').setInputFiles(path.join(fixture,'input.'+ext));
    await page.getByText('Inspect files',{exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled);
    console.log('File check:',await page.locator('#status').textContent());
    assert(await page.locator('#review').isVisible());
    await checkFeedback(); // Identifier review and submission status.
    assert.equal(await page.locator('#submissionStatus').inputValue(),'not-set');
    assert.equal(await page.locator('#submissionCase').textContent(),'Proposal: NIH-2026-11-03');
    await page.locator('#submissionStatus').selectOption('submitted');
    await page.getByRole('tab',{name:'Guidelines',exact:true}).click();
    await page.getByRole('tab',{name:'Prepare files',exact:true}).click();
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
    await checkFeedback(); // Office content or redacted PDF preview.
    assert.equal(await page.locator('#submissionStatus').inputValue(),'submitted');
    let downloads=0;
    page.on('download',()=>downloads++);
    const save=page.getByRole('button',{name:'Download approved files'});
    const backup=page.getByRole('button',{name:'Download private backup with originals'});
    assert.equal(await backup.isVisible(),false);
    await save.click();
    assert.match(await page.locator('#status').textContent(),/select the approval box/);
    await checkFeedback(); // Validation error state.
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
    await checkFeedback(); // Expanded private backup.
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
    await page.locator('#reset').scrollIntoViewIfNeeded();
    const closeBox=await page.locator('#reset').boundingBox();
    const feedbackBar=await page.locator('.feedback-bar').boundingBox();
    assert(closeBox.y+closeBox.height<=feedbackBar.y,'Feedback bar must not cover the final case action.');
    assert.deepEqual(requests,[]);
    // Closing/reloading must not restore status or attach it to a different proposal.
    await page.locator('#reset').click();
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled,null,{timeout:15000});
    assert.equal(await page.locator('#submissionStatus').inputValue(),'not-set');
    assert.equal(await page.locator('#submission').isVisible(),false);
    await checkFeedback(); // Closed/reset case.
    await context.setOffline(true);requests.length=0;
    await page.locator('#sponsor').fill('NIH');await page.locator('#date').fill('2026-11-03');
    await page.locator('#sequence').fill('2');
    await page.locator('#budget').setInputFiles(path.join(fixture,'input.xlsx'));
    await page.locator('#justification').setInputFiles(path.join(fixture,'input.'+ext));
    await page.getByText('Inspect files',{exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#pick').disabled);
    assert.equal(await page.locator('#submissionCase').textContent(),'Proposal: NIH-2026-11-03-02');
    assert.equal(await page.locator('#submissionStatus').inputValue(),'not-set');
    await page.locator('#useLynnWorkflow').check();
    assert.match(await page.locator('#lynnSheets').textContent(),/was not found/);
    for(const row of await page.locator('.rule').all())await row.locator('select').selectOption('keep');
    await page.locator('#inspect').click();
    await page.waitForFunction(()=>!document.querySelector('#inspect').disabled);
    assert.match(await page.locator('#status').textContent(),/requires Project and TU Year One/);
    assert.equal(await page.locator('#preview').isVisible(),false);
    assert.deepEqual(requests,[]);
    console.log(ext,'offline workflow passed');await context.close();
  }
}finally{await browser.close();server.close();}
