import {loadPyodide} from './pyodide/pyodide.mjs';
import {readPdf,redactPdf} from './pdf.js';
import {selectTab,startSubmission,submissionRecord} from './case-ui.js';
import {mountPortfolio} from './portfolio.js';
import {showRoundExchange} from './packet-ui.js';
const $=id=>document.getElementById(id);
const status=message=>{$('status').textContent=message;};
let py,kit,inputs,output;
let portfolioCase=null, generation=0, ready=false;
const previewUrls=[];
const lynnChecks=['cayuseChecked','guidanceGathered','salariesVerified','personnelCovered'];
const projectLocation=/(?:^|, )Project(?: \((?:hidden|veryHidden)\))?!/i;
const personnelLocation=/(?:^|, )TU Year One(?: \((?:hidden|veryHidden)\))?!/i;
const sameTerm=(a,b)=>a.trim().toLowerCase()===b.trim().toLowerCase();
function requireLynnReview(blankTerms){
  if(!$('useLynnWorkflow').checked){
    if(blankTerms.length)throw Error('Blank cell requires Lynn’s NIH R01 checklist. Choose Redact for the general workflow.');
    return;
  }
  if(!inputs.lynnSheets)throw Error('This checklist requires Project and TU Year One sheets. Check the workbook before continuing.');
  if(!$('cayuseChecked').checked || !$('guidanceGathered').checked)
    throw Error('Confirm the Cayuse record and funding-opportunity guidance checks.');
  if(!$('salariesVerified').checked)throw Error('Verify all salaries in Waveworks and confirm before previewing redacted copies.');
  for(const [id,label] of [['projectPi','PI name'],['projectTitle','project title']]){
    const term=$(id).value.trim();
    if(!term || !inputs.projectFields.some(([,value])=>sameTerm(value,term)))
      throw Error('Enter the complete '+label+' as it appears in a standalone text cell on Project.');
    if(!blankTerms.some(value=>sameTerm(value,term)))throw Error('Select Blank cell for the '+label+' in the identifier list.');
  }
  if(!$('personnelCovered').checked)throw Error('Check TU Year One and confirm every personnel name is selected as Blank cell.');
}
function lynnRecord(){
  return $('useLynnWorkflow').checked
    ? 'NIH R01 checklist — human-confirmed: Cayuse pair and record checked; opportunity guidance gathered; all salaries verified in Waveworks before redaction; Project PI/title and TU Year One personnel selected for blank cells. Other occurrences use neutral labels. Not independent system verification or compliance approval.'
    : 'NIH R01 checklist not used.';
}
function discardPreview(){
  output=null;
  $('approved').checked=false;
  $('privateBackup').open=false;
  $('includeOriginals').checked=false;
  $('preview').hidden=true;
  $('pages').replaceChildren();
  previewUrls.splice(0).forEach(URL.revokeObjectURL);
}
function call(name,...args){
  const fn=py.globals.get(name);
  try{
    const result=fn(...args);
    if(result?.toJs){try{return result.toJs();}finally{result.destroy();}}
    return result;
  }finally{fn.destroy();}
}
function task(button,work){
  return async event=>{
    event.preventDefault();
    const current=generation;
    button.disabled=true;
    if(button===$('inspect'))$('review').inert=true;
    try{await work(current);}catch(e){if(current===generation)status(e.message.split('\n').filter(Boolean).at(-1));}
    finally{if(current===generation){button.disabled=false;if(button===$('inspect'))$('review').inert=false;}}
  };
}
function rule(term='',label='',decision=''){
  const row=document.createElement('div');row.className='rule';
  const orig=document.createElement('input'), alias=document.createElement('input'),pick=document.createElement('select');
  orig.value=term;alias.value=label;orig.placeholder='Identifier';alias.placeholder='Person 01';
  orig.setAttribute('aria-label','Identifier');alias.setAttribute('aria-label','Replacement');
  pick.setAttribute('aria-label','Decision');
  for(const [v,name] of [['','Choose…'],['redact','Redact'],['blank','Blank cell (Lynn checklist)'],['keep','Keep']])pick.add(new Option(name,v));
  pick.value=decision;row.append(orig,alias,pick);$('rules').append(row);discardPreview();
}
$('rules').addEventListener('input',discardPreview);
$('rules').addEventListener('input',()=>{$('personnelCovered').checked=false;});
$('lynnWorkflow').addEventListener('input',discardPreview);
for(const id of ['projectPi','projectTitle'])$(id).addEventListener('input',()=>{$('personnelCovered').checked=false;});
$('useLynnWorkflow').onchange=()=>{
  $('lynnWorkflow').hidden=!$('useLynnWorkflow').checked;
  lynnChecks.forEach(id=>{$(id).checked=false;});
  discardPreview();
};
$('addProjectIdentifiers').onclick=task($('addProjectIdentifiers'),()=>{
  if(!$('projectPi').value.trim() || !$('projectTitle').value.trim())throw Error('Enter both the PI name and project title from Project.');
  for(const [id,label] of [['projectPi','Person PI'],['projectTitle','Project 01']]){
    const term=$(id).value.trim();
    const existing=[...$('rules').children].find(row=>sameTerm(row.children[0].value,term));
    if(existing){existing.children[2].value='blank';if(!existing.children[1].value.trim())existing.children[1].value=label;}
    else rule(term,label,'blank');
  }
  $('personnelCovered').checked=false;
  discardPreview();
  status('PI and project title selected as Blank cell. Select all TU Year One personnel names as Blank cell before previewing.');
});
$('add').onclick=()=>rule('','','redact');
function clearLynnReview(){
  $('useLynnWorkflow').checked=false;
  $('lynnWorkflow').hidden=true;
  for(const id of lynnChecks)$(id).checked=false;
  for(const id of ['projectPi','projectTitle'])$(id).value='';
  for(const id of ['lynnOriginal','lynnSheets'])$(id).textContent='';
}
function closePreparation(){
  generation++;
  inputs=null;
  portfolioCase=null;
  discardPreview();
  clearLynnReview();
  $('inputs').reset();
  for(const id of ['sponsor','date','sequence'])$(id).readOnly=false;
  for(const id of ['original','checked','changes','rules','boundCase','exportCase'])$(id).replaceChildren();
  for(const detail of $('casePanel').querySelectorAll('details'))detail.open=false;
  for(const id of ['review','boundCase','reset'])$(id).hidden=true;
  for(const id of ['inspect','save','backup'])$(id).disabled=false;
  $('round').value='';
  $('review').inert=false;
  $('pick').disabled=!ready;
  $('inputs').hidden=false;
  startSubmission(null);
  if(ready)status('Ready · You can disconnect before selecting documents.');
}
$('reset').onclick=closePreparation;
const portfolio=mountPortfolio($('portfolio'),{
  onSelectProposal(proposal){
    closePreparation();
    portfolioCase=Object.freeze({...proposal});
    $('sponsor').value=proposal.sponsor;
    $('date').value=proposal.originalDate;
    $('sequence').value=String(proposal.sequence);
    for(const id of ['sponsor','date','sequence'])$(id).readOnly=true;
    $('boundCase').textContent='Preparing files for '+proposal.label+' from your portfolio.';
    $('boundCase').hidden=false;
    $('reset').hidden=false;
    selectTab($('caseTab'));
    $('caseTab').focus();
  },
  onContextChange(){if(portfolioCase)closePreparation();},
  onSelectRound(context){showRoundExchange($('round-exchange'),context);}
});
$('portfolioPanel').addEventListener('leaveportfolio',()=>portfolio.closeRound());
$('inputs').onsubmit=task($('pick'),async(current)=>{
  const budget=$('budget').files[0],just=$('justification').files[0];
  const kind=just.name.split('.').pop().toLowerCase();
  if(!/\.xlsx$/i.test(budget.name)||!['pdf','docx'].includes(kind)) throw Error('Select an XLSX and a DOCX or PDF.');
  if(Math.max(budget.size,just.size)>64*1024*1024)throw Error('Each input must be under 64 MiB.');
  const b=new Uint8Array(await budget.arrayBuffer()),j=new Uint8Array(await just.arrayBuffer());
  if(current!==generation)return;
  const budgetFields=call('office_read',b,'xlsx');
  const rows=budgetFields.map(([loc,v])=>['Budget · '+loc,v]);
  const pages=kind==='pdf'?readPdf(j):null;
  if(pages)pages.forEach((lines,i)=>lines.forEach((l,k)=>rows.push(['Page '+(i+1)+' · line '+(k+1),l.value])));
  else rows.push(...call('office_read',j,kind).map(([loc,v])=>['Justification · '+loc,v]));
  const suffix=Number($('sequence').value);
  const id=portfolioCase?.label??($('sponsor').value.toUpperCase()+'-'+$('date').value+(suffix>1?'-'+String(suffix).padStart(2,'0'):''));
  inputs={id,b,j,kind,pages,budgetName:budget.name,justName:just.name};
  clearLynnReview();
  const sheets=budgetFields.filter(([loc])=>loc==='Sheet name').map(([,value])=>value.trim().toLowerCase());
  inputs.lynnSheets=['project','tu year one'].every(name=>sheets.includes(name));
  inputs.projectFields=budgetFields.filter(([loc])=>projectLocation.test(loc));
  $('lynnOriginal').textContent=budgetFields.filter(([loc])=>projectLocation.test(loc)||personnelLocation.test(loc)).map(([loc,value])=>loc+'   '+value).join('\n');
  $('lynnSheets').textContent=inputs.lynnSheets?'Project and TU Year One found. Confirm their contents and the selected pair.':'Project or TU Year One was not found. Check the workbook; this checklist expects both sheets.';
  startSubmission(id,portfolioCase?.status);
  $('exportCase').textContent='Approved copies for '+id;
  $('original').textContent=rows.map(([loc,v])=>loc+'   '+v).join('\n');
  $('rules').replaceChildren();
  for(const [t,l] of JSON.parse(call('suggestions',JSON.stringify(rows))))rule(t,l);
  $('inputs').hidden=true;$('review').hidden=false;$('reset').hidden=false;
  status(id+' · Files inspected on this device.');
});
$('inspect').onclick=task($('inspect'),async(current)=>{
  discardPreview();
  const rules=[],blankTerms=[];
  for(const row of $('rules').children){
    const [t,l,pick]=row.children;
    if(!pick.value)throw Error('Choose Redact, Blank cell or Keep for each suggestion.');
    if(['redact','blank'].includes(pick.value))rules.push([t.value,l.value]);
    if(pick.value==='blank')blankTerms.push(t.value);
  }
  requireLynnReview(blankTerms);
  const r=JSON.stringify(rules);
  const projectTerms=$('useLynnWorkflow').checked?[$('projectPi').value,$('projectTitle').value]:[];
  const [b,changes,fields]=call('office_edit',inputs.b,'xlsx',r,JSON.stringify(blankTerms),JSON.stringify(projectTerms));
  const edits=JSON.parse(changes), checked=JSON.parse(fields);
  let j;
  if(inputs.kind==='pdf'){
    const match=inputs.pages.map(lines=>JSON.parse(call('pdf_matches',JSON.stringify(lines.map(l=>l.value)),r)));
    const result=await redactPdf(inputs.j,inputs.pages,match,text=>call('check_residual',text,r));
    if(current!==generation)return;
    j=result.data;edits.push(...result.changes);
    for(const [i,blob] of result.previews.entries()){
      const img=document.createElement('img');img.alt='Redacted PDF page '+(i+1);img.src=URL.createObjectURL(blob);
      previewUrls.push(img.src);$('pages').append(img);
    }
  }else{
    const [data,more,rows]=call('office_edit',inputs.j,'docx',r);
    j=data;edits.push(...JSON.parse(more));checked.push(...JSON.parse(rows));
  }
  output={b,j};$('checked').textContent=checked.map(([loc,v])=>loc+'   '+v).join('\n');
  $('changes').textContent=edits.length?edits.map(([f,loc,old,v])=>f+' · '+loc+'\n'+old+' → '+(v===''?'[blank cell]':v)).join('\n\n'):'No replacements selected.';
  $('preview').hidden=false;status('Inspect both copies before saving.');$('preview').scrollIntoView();
});
function downloadZip(files,filename){
  const data=call('archive_round',new Map(Object.entries(files)));
  const url=URL.createObjectURL(new Blob([data],{type:'application/zip'}));
  const link=document.createElement('a');
  link.href=url;link.download=filename;
  try{link.click();}finally{setTimeout(()=>URL.revokeObjectURL(url),60000);}
}
function requireApproval(){
  if(!output || !$('approved').checked)throw Error('Inspect both copies and select the approval box.');
}
$('save').onclick=task($('save'),()=>{
  requireApproval();
  downloadZip({'Budget.xlsx':output.b,['Justification.'+inputs.kind]:output.j},'Approved-files.zip');
  status('Approved files download started. Open both files before handoff.');
});
$('backup').onclick=task($('backup'),async(current)=>{
  const counterId=portfolioCase?.id??inputs.id;
  await navigator.locks.request('proposal-round-'+counterId,()=>{
    if(current!==generation)return;
    requireApproval();
    if(!$('includeOriginals').checked)throw Error('Confirm that the private backup will include both originals.');
    const key='proposal-review:last-round:'+counterId;
    const previous=Number(localStorage.getItem(key)||0);
    const number=Number($('round').value)||previous+1;
    if(!Number.isSafeInteger(number)||number<=previous||number>99999)throw Error('Choose a later round number, or clear it for the next round.');
    const name='Round-'+String(number).padStart(5,'0');
    const prefix=inputs.id+'/Reviews/'+name+'/';
    const files={};
    for(const [folder,b,j] of [['01 Sources',inputs.b,inputs.j],['03 Redacted',output.b,output.j]]){
      files[prefix+folder+'/Budget.xlsx']=b;files[prefix+folder+'/Justification.'+inputs.kind]=j;
    }
    files[prefix+'02 Guidance/']='';
    const portfolioRecord=portfolioCase?['Portfolio proposal ID: '+portfolioCase.id,'Portfolio revision on opening: '+portfolioCase.revision]:[];
    files[prefix+'Review record.txt']=[inputs.id,...portfolioRecord,name,new Date().toISOString(),inputs.budgetName,inputs.justName,submissionRecord(),lynnRecord(),'03 Redacted contains the approved copies.'].join('\n');
    for(const [title,text] of Object.entries(kit))files[prefix+'04 Review/'+title]=text;
    downloadZip(files,'Private-'+inputs.id+'-'+name+'.zip');
    localStorage.setItem(key,String(number));
    $('includeOriginals').checked=false;
    status('Private '+name+' backup download started. Store it in the restricted proposal folder.');
  });
});
try{
  const runtime=await(await fetch('./runtime.json')).json();
  kit=runtime.kit;py=await loadPyodide({indexURL:new URL('./pyodide/',location.href).href});
  py.FS.mkdirTree('/home/pyodide/proposal_review');
  for(const [name,src] of Object.entries(runtime.modules))py.FS.writeFile('/home/pyodide/proposal_review/'+name,src);
  py.runPython(runtime.bridge);
  ready=true;$('pick').disabled=false;status('Ready · You can disconnect before selecting documents.');
}catch(e){status('Inspection tools could not load. Reload before selecting files.');console.error(e.message);}
