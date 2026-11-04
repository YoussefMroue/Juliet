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
  const standalonePage=await portfolioContext.newPage();
  await portfolioPage.goto('http://127.0.0.1:'+server.address().port);
  await portfolioPage.waitForFunction(()=>!document.querySelector('#pick').disabled);
  await standalonePage.goto(portfolioPage.url());
  await standalonePage.waitForFunction(()=>!document.querySelector('#pick').disabled);
  await portfolioContext.setOffline(true);
  const portfolioRequests=[];
  for(const page of [portfolioPage,standalonePage])page.on('request',request=>portfolioRequests.push(request.url()));
  const portfolio=portfolioPage.locator('#portfolio');
  const portfolioButton=name=>portfolio.getByRole('button',{name,exact:true});
  await portfolioButton('Open portfolio folder').click();
  const first='NIH-2026-11-03', second='NIH-2026-11-03-02';
  for(const [index,label] of [first,second].entries()){
    await expand(portfolio.getByText('Create a proposal',{exact:true}));
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
  const ownerText=await portfolio.getByText(/^Proposal ID /).innerText();
  const owner=ownerText.match(/^Proposal ID ([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/)[1];
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
  // Both tabs share the real origin, Web Locks and localStorage. They deliberately
  // use the same sponsor/date/sequence, but only one is bound to the portfolio.
  await standalonePage.getByRole('tab',{name:'Prepare files',exact:true}).click();
  await standalonePage.locator('#sponsor').fill('NIH');
  await standalonePage.locator('#date').fill('2026-11-03');
  await standalonePage.locator('#budget').setInputFiles({name:'standalone-source.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:await readFile(path.join(fixture,'input.xlsx'))});
  await standalonePage.locator('#justification').setInputFiles(path.join(fixture,'input.docx'));
  await standalonePage.getByRole('button',{name:'Inspect files',exact:true}).click();
  await standalonePage.locator('#review').waitFor();
  for(const choice of await standalonePage.locator('.rule select').all())await choice.selectOption('keep');
  await standalonePage.locator('#inspect').click();
  await standalonePage.locator('#approved').check();
  for(const page of [standalonePage,portfolioPage])await page.locator('#privateBackup summary').click();
  async function privateExport(page) {
    await page.locator('#includeOriginals').check();
    const [file]=await Promise.all([page.waitForEvent('download',{timeout:10000}),page.locator('#backup').click()]);
    return file;
  }
  async function checkPrivate(file,isBound,round) {
    const roundName='Round-'+String(round).padStart(5,'0');
    const folder=isBound ? first+'_'+owner : first;
    assert.equal(file.suggestedFilename(),'Private-'+folder+'-'+roundName+'.zip');
    const saved=await file.path();
    const prefix=folder+'/Reviews/'+roundName+'/';
    const entries=Object.keys(zipContents(saved));
    assert(entries.length>0 && entries.every(name=>name.startsWith(prefix)));
    const record=zipText(saved,prefix+'Review record.txt').split('\n');
    assert(record.includes(first) && record.includes(roundName));
    assert.equal(record.includes('Portfolio proposal ID: '+owner),isBound);
    assert(record.includes(isBound?'input.xlsx':'standalone-source.xlsx'));
  }
  await checkPrivate(await privateExport(standalonePage),false,1);
  await checkPrivate(await privateExport(portfolioPage),true,1);
  const [legacyBackup,boundBackup]=await Promise.all([privateExport(standalonePage),privateExport(portfolioPage)]);
  await checkPrivate(legacyBackup,false,2);
  await checkPrivate(boundBackup,true,2);
  const counters=await standalonePage.evaluate(()=>({...localStorage}));
  assert.deepEqual(counters,{['proposal-review:last-round:'+first]:'2',['proposal-review:last-round:'+owner]:'2'});
  await standalonePage.close();
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

  async function expand(summary){
    if(!await summary.locator('..').evaluate(el=>el.open))await summary.click();
  }
  async function addDocument(category,name,{record=true}={}){
    await expand(portfolio.getByText('Add a requirement',{exact:true}));
    const form=portfolio.locator('form').filter({has:portfolioPage.getByRole('button',{name:'Add requirement',exact:true})});
    await form.getByLabel('Document category').selectOption(category);
    await form.getByLabel('Document label').fill(name);
    await form.getByLabel('Applicability').selectOption('Required');
    await form.getByRole('button',{name:'Add requirement',exact:true}).click();
    const card=portfolio.locator('article').filter({has:portfolioPage.getByRole('heading',{name,exact:true})});
    if(!record)return card;
    await expand(card.getByText('Versions and requirement details',{exact:true}));
    await card.getByLabel('Version label').fill('Original');
    await card.getByRole('checkbox',{name:'Use this as the active version',exact:true}).check();
    await card.getByRole('button',{name:'Record version',exact:true}).click();
    await card.getByText(/Required · Active v1 · Original/).waitFor();
  }
  async function freezeRound({number=1,label='First review',lane='focused',purpose='initial',opportunity='Fictional fabrication opportunity, edition 1',scope='Check the requested fabrication amount against the supplied ceiling.',checks=['compliance'],guidance='provided',owner='Review administrator',nextAction='Confirm the requested amount.',calculationEvidence='not_checked',calculationNote=''}={}){
    if(!await portfolio.locator('[data-key^="check-"]').count()){
      await expand(portfolio.locator('summary').filter({hasText:/^Add checklist check$/}));
      const checklist=portfolio.locator('form').filter({has:portfolioPage.getByRole('button',{name:'Add checklist check',exact:true})});
      await checklist.getByLabel('Check requirement',{exact:true}).fill('Review the assigned source evidence and record limitations.');
      await checklist.locator('select[name="applicability"]').selectOption('required');
      await checklist.getByLabel('Requirement and applicability basis',{exact:true}).fill('Fictional case-specific scope and supplied source edition.');
      for(const card of await portfolio.locator('[data-key^="document-"]').all()){
        const name=await card.locator('h4').innerText();
        const guidanceDoc=/Opportunity guidance|Institutional guidance/.test(await card.locator('p').first().innerText());
        await checklist.getByRole('checkbox',{name:guidanceDoc?name+' is governing guidance':name,exact:true}).check();
      }
      await checklist.getByRole('button',{name:'Add checklist check',exact:true}).click();
      await portfolio.locator('[data-key^="check-"]').waitFor();
    }
    await expand(portfolio.getByText('Record an inventory snapshot',{exact:true}));
    const form=portfolio.locator('form').filter({has:portfolioPage.getByRole('button',{name:'Record snapshot',exact:true})});
    await form.getByLabel('Round label').fill(label);
    await form.locator('select[name="lane"]').selectOption(lane);
    await form.locator('select[name="purpose"]').selectOption(purpose);
    await form.getByLabel('Opportunity and edition',{exact:true}).fill(opportunity);
    await form.getByLabel('Review scope',{exact:true}).fill(scope);
    for(const [value,name] of [['completeness','Completeness'],['calculations','Calculations'],['compliance','Compliance with supplied guidance'],['consistency','Cross-document consistency'],['narrative','Narrative sections and consistency']])await form.getByRole('checkbox',{name,exact:true}).setChecked(checks.includes(value));
    await form.locator('select[name="guidanceStatus"]').selectOption(guidance);
    await expand(form.getByText('Owners and evidence limits',{exact:true}));
    await form.getByLabel('Next-action owner',{exact:true}).fill(owner);
    await form.getByLabel('Review next action',{exact:true}).fill(nextAction);
    await form.locator('select[name="calculationEvidence"]').selectOption(calculationEvidence);
    await form.getByLabel('Calculation evidence note',{exact:true}).fill(calculationNote);
    await form.locator('select[name="handling"]').selectOption('fictional_only');
    await form.getByRole('checkbox',{name:'I confirmed the selected active versions for this round.',exact:true}).check();
    await form.getByRole('checkbox',{name:'I confirmed this proposal checklist, applicability and review scope.',exact:true}).check();
    await portfolioButton('Record snapshot').click();
    await portfolio.getByText(`Round ${number} · ${label}`,{exact:true}).waitFor();
  }
  async function openRound(number=1,label='First review'){
    const summary=portfolio.getByText(`Round ${number} · ${label}`,{exact:true});
    const round=summary.locator('..');
    if(!await round.evaluate(node=>node.open))await summary.click();
    await round.getByRole('button',{name:'Review this round',exact:true}).click();
  }
  console.log('Two-tab private backups and proposal preparation isolation passed');
  await portfolioButton('Open '+first).click();
  await addDocument('Budget','Fabrication budget');
  await addDocument('Opportunity guidance','Invented instructions');
  await freezeRound();
  console.log('V3 inventory, active versions and checklist freeze passed');
  await openRound();
  const exchange=portfolioPage.locator('#round-exchange');
  const excerpts=[
    ['Fabrication budget · v1','Budget!B7','Requested amount is 1200.'],
    ['Invented instructions · v1','Section 2','The total cost ceiling is 1000.']
  ];
  for(const [doc,anchor,excerpt] of excerpts){
    await exchange.getByLabel('Document version').selectOption({label:doc});
    await exchange.getByLabel('Page, paragraph or sheet and cell').fill(anchor);
    await exchange.getByLabel('Evidence excerpt',{exact:true}).fill(excerpt);
    await exchange.getByLabel('Human evidence source and limitations',{exact:true}).fill('Fictional case author supplied this excerpt; no engine recalculation claimed.');
    await exchange.getByRole('button',{name:'Add excerpt',exact:true}).click();
  }
  const firstExport=await downloadPacket();
  const packetPath=firstExport.path, packet=firstExport.packet;
  assert.equal(packet.format,'juliet.packet.v3');
  assert.equal(packet.reviewerRelease,'1.0.0');
  assert.equal(packet.reviewContext.lane,'focused');
  assert.equal(packet.reviewContext.guidanceStatus,'provided');
  assert.deepEqual(packet.requiredFollowups,[]);
  assert.deepEqual(packet.items.map(i=>i.text),excerpts.map(e=>e[2]));
  const {reviewerRelease,proposalId,roundId,packetId,reportId,digest}=packet;
  const report={...reportHeader(packet),
    findings:[{type:'objective_error',message:'Requested amount exceeds the fictional ceiling by 200.',
      evidence:[{itemId:'E1',quote:excerpts[0][2]}],guidance:[{itemId:'E2',quote:excerpts[1][2]}],
      gapIds:[],priorFindingId:null,owner:'Review administrator',nextAction:'Correct the request or supply the applicable ceiling.',calculation:''}]};
  async function checkReport(value=report){
    await exchange.getByLabel('Returned findings JSON').setInputFiles({name:'findings.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
    await exchange.getByRole('button',{name:'Check packet and report'}).click();
  }
  await exchange.getByLabel('Original registered packet').setInputFiles(packetPath);
  await checkReport();
  await exchange.getByRole('button',{name:'Save checked report to this round'}).waitFor();
  // A second set for the same frozen round cannot be mixed into current coverage.
  await addExcerpt('Invented instructions · v1','Section 3','A fictional agency will announce the award in June.');
  await exchange.getByRole('button',{name:'Preview review packets',exact:true}).click();
  await exchange.getByRole('checkbox').check();
  await exchange.getByRole('button',{name:'Register approved packet set',exact:true}).click();
  await exchange.getByText(/already.*packet set|one packet set|new round/i).last().waitFor();
  await portfolioPage.getByRole('tab',{name:'Guidelines',exact:true}).click();
  assert.equal(await exchange.textContent(),'');
  await portfolioPage.getByRole('tab',{name:'Portfolio',exact:true}).click();
  await openRound();
  await exchange.getByLabel('Original registered packet').setInputFiles(packetPath);
  await checkReport();
  await exchange.getByRole('button',{name:'Save checked report to this round'}).waitFor();
  assert((await exchange.textContent()).includes(excerpts[1][2]));
  await exchange.getByRole('button',{name:'Save checked report to this round'}).click();
  await portfolio.getByText('Report '+reportId,{exact:true}).waitFor({state:'attached'});
  await expand(portfolio.getByText('Round 1 · First review',{exact:true}));
  await portfolio.getByText('Report '+reportId,{exact:true}).click();
  await portfolio.getByText('Record a finding decision',{exact:true}).click();
  const decision=portfolio.locator('form').filter({has:portfolioPage.getByRole('button',{name:'Save decision',exact:true})});
  await decision.locator('select[name="disposition"]').selectOption('Accepted');
  await portfolio.getByLabel('Decision note').fill('Compared requested amount with the supplied ceiling.');
  await portfolioButton('Save decision').click();
  await portfolio.getByText(/Accepted · Compared requested amount/).waitFor({state:'attached'});
  await expand(portfolio.getByText('Round 1 · First review',{exact:true}));
  await portfolio.getByText(/Accepted · Compared requested amount/).waitFor();
  await portfolioButton('Open '+second).click();
  assert.equal(await exchange.textContent(),'');
  assert.equal(await portfolio.getByText(report.findings[0].message,{exact:true}).count(),0);
  await addDocument('Budget','Fabrication budget');
  await addDocument('Budget justification','Fabrication justification');
  const missingScope='Reconcile the second proposal only; exact opportunity guidance has not been supplied.';
  await freezeRound({lane:'budget',opportunity:'',scope:missingScope,checks:['calculations','compliance','consistency'],guidance:'missing',owner:'Budget administrator',nextAction:'Obtain the dated notice for the second proposal.',calculationEvidence:'independent',calculationNote:'The fictional line 4 × 100 = 400 was recomputed; no spreadsheet engine was run.'});
  await openRound();
  await exchange.getByLabel('Original registered packet').setInputFiles(packetPath);
  await checkReport();
  await exchange.getByText(/belongs to another proposal or review round/).waitFor();
  assert.equal(await exchange.getByRole('button',{name:'Save checked report to this round'}).isVisible(),false);

  async function addExcerpt(document,anchor,text){
    await exchange.getByLabel('Document version').selectOption({label:document});
    await exchange.getByLabel('Page, paragraph or sheet and cell').fill(anchor);
    await exchange.getByLabel('Evidence excerpt',{exact:true}).fill(text);
    await exchange.getByLabel('Human evidence source and limitations',{exact:true}).fill('Fictional case author supplied this excerpt; no engine recalculation claimed.');
    await exchange.getByRole('button',{name:'Add excerpt',exact:true}).click();
  }
  async function downloadPacket(){
    await exchange.getByRole('button',{name:'Preview review packets',exact:true}).click();
    await exchange.getByRole('checkbox').check();
    await exchange.getByRole('button',{name:'Register approved packet set',exact:true}).click();
    const [file]=await Promise.all([portfolioPage.waitForEvent('download'),exchange.getByRole('button',{name:'Download packet 1 of 1',exact:true}).click()]);
    const filePath=path.join(output,file.suggestedFilename());
    await file.saveAs(filePath);
    return {packet:JSON.parse(await readFile(filePath,'utf8')),path:filePath};
  }
  function reportHeader(packet){
    const fields=['reviewerRelease','proposalId','roundId','packetId','reportId','digest','packetSetId','batchId','batchIndex','batchCount','manifestDigest'];
    return {format:'juliet.findings.v3',...Object.fromEntries(fields.map(key=>[key,packet[key]])),
      coverage:{reviewed:packet.items.map(item=>item.itemId),unreviewed:[]},
      checkResults:packet.assignedCheckIds.map(checkId=>{
        const check=packet.checklist.find(row=>row.checkId===checkId);
        const refs=ids=>packet.items.filter(item=>ids.includes(item.documentId)).map(item=>({itemId:item.itemId,quote:item.text.slice(0,300)}));
        return {checkId,status:packet.reviewContext.guidanceStatus==='missing'?'decision_needed':'checked',message:'Fictional evidence checked within the assigned scope; see linked findings.',evidence:refs(check.documentIds),guidance:refs(check.sourceDocumentIds),findingRefs:['F1']};
      })};
  }
  async function journalEntries(){
    return portfolioPage.evaluate(async()=>{
      const folder=await (await navigator.storage.getDirectory()).getDirectoryHandle('Juliet Portfolio');
      const rows=[];
      for await(const [name,handle] of folder.entries())if(name.endsWith('.json'))rows.push(JSON.parse(await (await handle.getFile()).text()));
      return rows;
    });
  }
  await addExcerpt('Fabrication budget · v1','Budget!B7','Four units at 100 each total 400.');
  await addExcerpt('Fabrication justification · v1','Paragraph 1','Four fabrication units are requested for 400.');
  const missing=await downloadPacket();
  assert.notEqual(missing.packet.proposalId,packet.proposalId);
  assert.equal(missing.packet.reviewContext.scope,missingScope);
  assert.equal(missing.packet.reviewContext.guidanceStatus,'missing');
  assert.equal(missing.packet.reviewContext.opportunity,'');
  assert.equal(missing.packet.requiredFollowups.length,2);
  assert(missing.packet.requiredFollowups.some(g=>g.message.includes('opportunity identifier and dated edition are unknown')));
  assert(missing.packet.requiredFollowups.some(g=>g.message.includes('Applicable opportunity guidance is missing')));
  assert.deepEqual(missing.packet.priorFindings,[]);
  await exchange.getByLabel('Original registered packet').setInputFiles(missing.path);
  await checkReport({...reportHeader(missing.packet),findings:[]});
  await exchange.getByText(/Required follow-up G1 is missing from the report/).waitFor();
  assert.equal(await exchange.getByRole('button',{name:'Save checked report to this round'}).isVisible(),false);
  const missingReport={...reportHeader(missing.packet),findings:missing.packet.requiredFollowups.map(g=>({
    type:g.type,message:g.message,evidence:[],guidance:[],gapIds:[g.id],priorFindingId:null,
    owner:'Budget administrator',nextAction:g.nextAction,calculation:''
  }))};
  await checkReport(missingReport);
  await exchange.getByRole('button',{name:'Save checked report to this round'}).click();
  await portfolio.getByText('Report '+missingReport.reportId,{exact:true}).waitFor({state:'attached'});
  await portfolioButton('Close portfolio').click();
  await portfolioButton('Open portfolio folder').click();
  await portfolioButton('Open '+second).click();
  await openRound();
  assert.match(await exchange.textContent(),new RegExp(missingScope));
  assert.equal((await exchange.textContent()).includes(packet.reviewContext.scope),false);
  await portfolio.getByText('Report '+missingReport.reportId,{exact:true}).click();
  for(const finding of missingReport.findings)await portfolio.getByText(finding.message,{exact:true}).first().waitFor();
  const savedMissing=(await journalEntries()).find(event=>event.action==='report' && event.data.reportId===missingReport.reportId);
  assert.equal(savedMissing.proposalId,missing.packet.proposalId);
  assert.deepEqual(savedMissing.data.requiredFollowups,missing.packet.requiredFollowups);
  assert.deepEqual(savedMissing.data.findings.map(f=>({message:f.message,gapIds:f.gapIds,owner:f.owner,nextAction:f.nextAction})),missingReport.findings.map(f=>({message:f.message,gapIds:f.gapIds,owner:f.owner,nextAction:f.nextAction})));

  // A subsequent review of the first proposal carries its own unresolved issue,
  // preserves identity and uses the revised document; the other case's gaps stay out.
  await portfolioButton('Open '+first).click();
  assert.equal(await portfolio.getByText(missingReport.findings[0].message,{exact:true}).count(),0);
  const budgetCard=portfolio.locator('article').filter({has:portfolioPage.getByRole('heading',{name:'Fabrication budget',exact:true})});
  await expand(budgetCard.getByText('Versions and requirement details',{exact:true}));
  await budgetCard.getByLabel('Version label').fill('Revised');
  await budgetCard.getByRole('checkbox',{name:'Use this as the active version',exact:true}).check();
  await budgetCard.getByRole('button',{name:'Record version',exact:true}).click();
  await budgetCard.getByText(/Required · Active v2 · Revised/).waitFor();
  await freezeRound({number:2,label:'Targeted revision',purpose:'revision',scope:'Recheck the first proposal ceiling issue against its revised budget.'});
  await openRound(2,'Targeted revision');
  assert.equal((await exchange.textContent()).includes(missingScope),false);
  await addExcerpt('Fabrication budget · v2','Budget!B7','The revised request remains 1200.');
  await addExcerpt('Invented instructions · v1','Section 2',excerpts[1][2]);
  const revision=await downloadPacket();
  const findingId=report.reportId+'/F1';
  assert.equal(revision.packet.proposalId,packet.proposalId);
  assert.notEqual(revision.packet.roundId,packet.roundId);
  assert.equal(revision.packet.priorFindings.length,1);
  assert.equal(revision.packet.priorFindings[0].findingId,findingId);
  assert.equal(revision.packet.priorFindings[0].disposition,'Accepted');
  assert.equal(revision.packet.priorFindings[0].owner,'Review administrator');
  assert.equal(revision.packet.requiredFollowups.length,1);
  assert.equal(revision.packet.requiredFollowups[0].priorFindingId,findingId);
  assert.notEqual(revision.packet.items[0].versionId,packet.items[0].versionId);
  const revisionReport={...reportHeader(revision.packet),findings:[{
    type:'question',message:'The ceiling issue remains open in the revised budget. A human decision is needed.',
    evidence:[{itemId:'E1',quote:'The revised request remains 1200.'}],guidance:[{itemId:'E2',quote:excerpts[1][2]}],
    gapIds:[revision.packet.requiredFollowups[0].id],priorFindingId:findingId,
    owner:'Review administrator',nextAction:'Correct the request or supply the applicable ceiling.',calculation:''
  }]};
  await exchange.getByLabel('Original registered packet').setInputFiles(revision.path);
  await checkReport(revisionReport);
  await exchange.getByRole('button',{name:'Save checked report to this round'}).click();
  await portfolio.getByText('Report '+revisionReport.reportId,{exact:true}).waitFor({state:'attached'});
  let journal=await journalEntries();
  const savedRevision=journal.find(event=>event.action==='report' && event.data.reportId===revisionReport.reportId);
  assert.equal(savedRevision.data.findings[0].id,findingId);
  assert.equal(savedRevision.data.findings[0].priorFindingId,findingId);
  assert.equal(savedRevision.proposalId,packet.proposalId);
  // Reimporting the unchanged response is idempotent and never creates a human decision.
  await openRound(2,'Targeted revision');
  await exchange.getByLabel('Original registered packet').setInputFiles(revision.path);
  await checkReport(revisionReport);
  await exchange.getByRole('button',{name:'Save checked report to this round'}).click();
  await exchange.getByText('Report recorded against its frozen round. Review the findings in history; importing does not change decisions or proposal status.',{exact:true}).waitFor();
  journal=await journalEntries();
  assert.equal(journal.filter(event=>event.action==='report' && event.data.reportId===revisionReport.reportId).length,1);
  assert.equal(journal.filter(event=>event.action==='review').length,1);
  assert.equal(journal.filter(event=>event.action==='details').length,0);
  assert.deepEqual(portfolioRequests,[]);
  // The complete-package path reads one original file independently, registers
  // its actual hash/limitations, and keeps extracted provenance through import.
  await expand(portfolio.getByText('Create a proposal',{exact:true}));
  const singleCreate=portfolio.locator('form').filter({has:portfolioPage.getByRole('button',{name:'Create proposal',exact:true})});
  await singleCreate.getByLabel('Sponsor initials').fill('LOCAL');
  await singleCreate.getByLabel('Original submission date').fill('2026-11-03');
  await singleCreate.getByLabel('Proposal sequence').fill('1');
  await singleCreate.getByRole('button',{name:'Create proposal',exact:true}).click();
  await portfolio.getByRole('heading',{name:'LOCAL-2026-11-03 workspace',exact:true}).waitFor();
  await addDocument('Budget','Single source workbook',{record:false});
  await portfolioButton('Inspect local file for Single source workbook').click();
  const intake=portfolioPage.locator('#document-intake');
  await intake.getByLabel('Source document',{exact:true}).setInputFiles(path.join(fixture,'input.xlsx'));
  await intake.getByRole('button',{name:'Inspect file locally',exact:true}).click();
  await intake.getByText(/extracted entries/).waitFor();
  const extractedText=await intake.locator('pre').innerText();
  assert(extractedText.length>0);
  await intake.getByRole('button',{name:'Use this source excerpt',exact:true}).click();
  await intake.getByLabel('Version label',{exact:true}).fill('Locally inspected original');
  await intake.getByLabel('Use this as the active version',{exact:true}).check();
  await intake.getByLabel('I reviewed these source excerpts and limitations',{exact:true}).check();
  await intake.getByRole('heading',{name:'Prepare evidence · Single source workbook',exact:true}).scrollIntoViewIfNeeded();
  await portfolioPage.screenshot({path:path.join(output,'v1-intake-desktop.png')});
  await intake.getByRole('button',{name:'Register version and retain selected evidence',exact:true}).click();
  await intake.getByText(/Version registered with 1 locally retained excerpts/).waitFor();
  await freezeRound({label:'Single-source review',lane:'focused',checks:['consistency'],scope:'Inspect the selected fictional workbook evidence and its extraction limitations.'});
  await openRound(1,'Single-source review');
  await exchange.getByRole('button',{name:'Add prepared evidence from this session',exact:true}).click();
  const prepared=await downloadPacket();
  assert.equal(prepared.packet.items.length,1);
  assert.equal(prepared.packet.items[0].text,extractedText);
  assert.equal(prepared.packet.items[0].provenance.method,'extracted');
  assert.equal(prepared.packet.inventory[0].sha256,createHash('sha256').update(await readFile(path.join(fixture,'input.xlsx'))).digest('hex'));
  assert.equal(prepared.packet.inventory[0].coverage,'partial');
  assert(prepared.packet.inventory[0].limitations.some(row=>row.feature==='calculation evidence'));
  const preparedReport={...reportHeader(prepared.packet),findings:prepared.packet.requiredFollowups.map(g=>({type:g.type,message:g.message,evidence:[],guidance:[],gapIds:[g.id],priorFindingId:null,owner:'Reviewer',nextAction:g.nextAction,calculation:''}))};
  for(const result of preparedReport.checkResults){result.status='unchecked';result.message='Selected text inspected; source limitations need local follow-up.';}
  await exchange.getByLabel('Original registered packet').setInputFiles(prepared.path);
  await checkReport(preparedReport);
  await exchange.getByRole('button',{name:'Save checked report to this round'}).click();
  await portfolio.getByText('Report '+preparedReport.reportId,{exact:true}).waitFor({state:'attached'});
  const preparedSaved=(await journalEntries()).find(event=>event.action==='report'&&event.data.reportId===preparedReport.reportId);
  assert.equal(preparedSaved.data.evidenceProvenance[0].method,'extracted');
  const sourceSaved=(await journalEntries()).find(event=>event.action==='version'&&event.proposalId===prepared.packet.proposalId);
  assert.equal(sourceSaved.data.sha256,prepared.packet.inventory[0].sha256);
  assert.equal(sourceSaved.data.coverage,'partial');
  assert(!Object.hasOwn(sourceSaved.data,'sourceName')&&!Object.hasOwn(sourceSaved.data,'bytes'));
  await portfolioPage.setViewportSize({width:390,height:844});
  await portfolio.getByRole('heading',{name:'LOCAL-2026-11-03 workspace',exact:true}).scrollIntoViewIfNeeded();
  assert(await portfolioPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await portfolioPage.screenshot({path:path.join(output,'v1-workspace-mobile.png')});
  assert.deepEqual(portfolioRequests,[]);
  await portfolioContext.close();
  console.log('Two-proposal offline preparation, scoped packets, required guidance gaps, revision carryforward, idempotent findings and isolation passed');
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
    assert.match(await page.locator('#guidelinesPanel').textContent(),/does not automatically apply this reference list or establish compliance/);
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
