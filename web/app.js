import {loadPyodide} from './pyodide/pyodide.mjs';
import {readPdf,redactPdf} from './pdf.js';
const $=id=>document.getElementById(id);
const status=message=>{$('status').textContent=message;};
let py,kit,inputs,output;
const previewUrls=[];
function discardPreview(){
  output=null;
  $('approved').checked=false;
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
    button.disabled=true;
    if(button===$('inspect'))$('review').inert=true;
    try{await work();}catch(e){status(e.message.split('\n').filter(Boolean).at(-1));}
    finally{button.disabled=false;if(button===$('inspect'))$('review').inert=false;}
  };
}
function rule(term='',label='',decision=''){
  const row=document.createElement('div');row.className='rule';
  const orig=document.createElement('input'), alias=document.createElement('input'),pick=document.createElement('select');
  orig.value=term;alias.value=label;orig.placeholder='Identifier';alias.placeholder='Person 01';
  orig.setAttribute('aria-label','Identifier');alias.setAttribute('aria-label','Replacement');
  pick.setAttribute('aria-label','Decision');
  for(const [v,name] of [['','Choose…'],['redact','Redact'],['keep','Keep']])pick.add(new Option(name,v));
  pick.value=decision;row.append(orig,alias,pick);$('rules').append(row);discardPreview();
}
$('rules').addEventListener('input',discardPreview);
$('add').onclick=()=>rule('','','redact');
$('reset').onclick=()=>location.reload();
$('inputs').onsubmit=task($('pick'),async()=>{
  const budget=$('budget').files[0],just=$('justification').files[0];
  const kind=just.name.split('.').pop().toLowerCase();
  if(!/\.xlsx$/i.test(budget.name)||!['pdf','docx'].includes(kind)) throw Error('Select an XLSX and a DOCX or PDF.');
  if(Math.max(budget.size,just.size)>64*1024*1024)throw Error('Each input must be under 64 MiB.');
  const b=new Uint8Array(await budget.arrayBuffer()),j=new Uint8Array(await just.arrayBuffer());
  const rows=call('office_read',b,'xlsx').map(([loc,v])=>['Budget · '+loc,v]);
  const pages=kind==='pdf'?readPdf(j):null;
  if(pages)pages.forEach((lines,i)=>lines.forEach((l,k)=>rows.push(['Page '+(i+1)+' · line '+(k+1),l.value])));
  else rows.push(...call('office_read',j,kind).map(([loc,v])=>['Justification · '+loc,v]));
  const suffix=Number($('sequence').value);
  const id=$('sponsor').value.toUpperCase()+'-'+$('date').value+(suffix>1?'-'+String(suffix).padStart(2,'0'):'');
  inputs={id,b,j,kind,pages,budgetName:budget.name,justName:just.name};
  $('original').textContent=rows.map(([loc,v])=>loc+'   '+v).join('\n');
  $('rules').replaceChildren();
  for(const [t,l] of JSON.parse(call('suggestions',JSON.stringify(rows))))rule(t,l);
  $('inputs').hidden=true;$('review').hidden=false;$('reset').hidden=false;
  status(id+' · Files inspected on this device.');
});
$('inspect').onclick=task($('inspect'),async()=>{
  discardPreview();
  const rules=[];
  for(const row of $('rules').children){
    const [t,l,pick]=row.children;
    if(!pick.value)throw Error('Choose Redact or Keep for each suggestion.');
    if(pick.value==='redact')rules.push([t.value,l.value]);
  }
  const r=JSON.stringify(rules);
  const [b,changes,fields]=call('office_edit',inputs.b,'xlsx',r);
  const edits=JSON.parse(changes), checked=JSON.parse(fields);
  let j;
  if(inputs.kind==='pdf'){
    const match=inputs.pages.map(lines=>JSON.parse(call('pdf_matches',JSON.stringify(lines.map(l=>l.value)),r)));
    const result=await redactPdf(inputs.j,inputs.pages,match,text=>call('check_residual',text,r));
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
  $('changes').textContent=edits.length?edits.map(([f,loc,old,v])=>f+' · '+loc+'\n'+old+' → '+v).join('\n\n'):'No replacements selected.';
  $('preview').hidden=false;status('Inspect both copies before saving.');$('preview').scrollIntoView();
});
$('save').onclick=task($('save'),async()=>{
  if(!output || !$('approved').checked)throw Error('Inspect both copies and select the approval box.');
  await navigator.locks.request('proposal-round-'+inputs.id,async()=>{
    const key='proposal-review:last-round:'+inputs.id;
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
    files[prefix+'Review record.txt']=[inputs.id,name,new Date().toISOString(),inputs.budgetName,inputs.justName,'03 Redacted contains the approved copies.'].join('\n');
    for(const [title,text] of Object.entries(kit))files[prefix+'04 Review/'+title]=text;
    const map=new Map(Object.entries(files));
    const data=call('archive_round',map);
    const url=URL.createObjectURL(new Blob([data],{type:'application/zip'}));
    const link=document.createElement('a');link.href=url;link.download=inputs.id+'-'+name+'.zip';
    localStorage.setItem(key,String(number));link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
    status(name+' download started. Extract the folder locally. Only 03 Redacted is for handoff.');
  });
});
try{
  const runtime=await(await fetch('./runtime.json')).json();
  kit=runtime.kit;py=await loadPyodide({indexURL:new URL('./pyodide/',location.href).href});
  py.FS.mkdirTree('/home/pyodide/proposal_review');
  for(const [name,src] of Object.entries(runtime.modules))py.FS.writeFile('/home/pyodide/proposal_review/'+name,src);
  py.runPython(runtime.bridge);
  $('pick').disabled=false;status('Ready · You can disconnect before selecting documents.');
}catch(e){status('Inspection tools could not load. Reload before selecting files.');console.error(e.message);}
