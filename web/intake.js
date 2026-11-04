// Read-only source evidence. Nothing in this module uploads or rewrites a document.
const LIMIT = 64 * 1024 * 1024;
const HEX = /^[0-9a-f]{64}$/;
function requireValue(ok, message) { if (!ok) throw Error(message); }
export async function sourceDigest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
}
export async function inspectLocalFile(file, {readOffice, readPdf} = {}) {
  requireValue(file && file.size > 0 && file.size <= LIMIT, 'Choose a nonempty file no larger than 64 MiB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  requireValue(bytes.byteLength === file.size, 'The source changed while it was being read. Select it again.');
  const kind = (file.name.split('.').pop() || '').toLowerCase();
  const sha256 = await sourceDigest(bytes);
  let result;
  try {
    if (['xlsx', 'docx'].includes(kind)) {
      requireValue(typeof readOffice === 'function', 'The local Office reader is not ready.');
      result = await readOffice(bytes, kind);
      if (typeof result === 'string') result = JSON.parse(result);
      requireValue(result?.sha256 === sha256 && result.size === file.size && Array.isArray(result.items) && Array.isArray(result.limitations), 'Local extraction did not match the selected source.');
    } else if (kind === 'pdf') {
      requireValue(typeof readPdf === 'function', 'The local PDF reader is not ready.');
      const pages = await readPdf(bytes);
      result = {items: pages.flatMap((lines, page) => lines.map((line, index) => ({anchor:`Page ${page + 1} · line ${index + 1}`, text:line.value, method:'extracted'}))), limitations:[{location:'document', feature:'coverage', message:'Extracted lines establish only the cited text. Inspect rendered layout and requirements locally.'}], coverage:'partial'};
    } else {
      throw Error('This format has no supported local extractor. Register its identity and supply a supported derivative or human inspection evidence.');
    }
  } catch (error) {
    result = {items:[], coverage:'blocked', limitations:[{location:'document', feature:'unsupported source', message:String(error.message || error).split('\n').filter(Boolean).at(-1).slice(0, 1000)}]};
  }
  return {...result, kind:kind.slice(0,20) || 'unknown', sha256, size:file.size, sourceName:file.name};
}
function node(tag, text) { const e=document.createElement(tag); if (text !== undefined) e.textContent=text; return e; }
function input(type, label) { const e=node('input'); e.type=type; e.setAttribute('aria-label',label); return e; }
function field(label, control) { const el=node('label',label+' '); el.append(control); return el; }
function button(label, action) { const b=node('button',label); b.type='button'; b.onclick=action; return b; }

// context.registerVersion stores metadata only. Selected excerpts remain in memory until
// the separately reviewed packet is sealed. A new selected document discards this view.
export function mountIntake(root, {readOffice, readPdf, context, onEvidence} = {}) {
  root.replaceChildren();
  const heading=node('h3','Prepare evidence · '+context.document.name);
  root.append(heading, node('p','Source contents stay on this device. This is read-only extraction of unredacted evidence, not a redacted copy or a complete review. Approve only the excerpts needed for this proposal.'));
  const file=input('file','Source document'), inspect=button('Inspect file locally', inspectFile), message=node('p');
  message.setAttribute('role','status');
  const preview=node('div');
  root.append(field('Source document',file),inspect,message,preview);
  let generation=0, result=null, selected=[];
  const active=()=>{ context.assertActive?.(); requireValue(root.isConnected, 'This document view is no longer active.'); };
  const work=async(fn)=>{ try { active(); await fn(); } catch(e) { message.textContent=e.message; } };
  file.onchange=()=>{generation++;result=null;selected=[];preview.replaceChildren();message.textContent='Select Inspect file locally to read this source.';};
  async function inspectFile() {
    const current=++generation; inspect.disabled=true; file.disabled=true;
    await work(async()=>{
      requireValue(file.files[0], 'Choose a source document.');
      const extracted=await inspectLocalFile(file.files[0],{readOffice,readPdf});
      active(); if(current!==generation) return;
      result=extracted; selected=[]; renderSource();
      message.textContent=`${result.items.length} extracted entries · ${result.coverage}. Originals were not changed.`;
    });
    if(current===generation){inspect.disabled=false;file.disabled=false;}
  }
  function renderSource() {
    preview.replaceChildren();
    preview.append(node('p',`Local source: ${result.sourceName} · ${result.size} bytes · SHA-256 ${result.sha256}`));
    const limitations=node('details'); limitations.open=true;
    limitations.append(node('summary',`Coverage limitations (${result.limitations.length})`));
    const list=node('ul');
    for(const item of result.limitations) list.append(node('li',`${item.location}: ${item.feature} — ${item.message}`));
    limitations.append(list); preview.append(limitations);
    const search=input('search','Find a source entry'), pick=node('select'), excerpt=node('pre'), chosen=node('ul');
    pick.setAttribute('aria-label','Source entry'); excerpt.style.whiteSpace='pre-wrap';
    let visible=[];
    function showChoice() { excerpt.textContent=visible[Number(pick.value)]?.text || ''; }
    function findEntries() {
      const term=search.value.trim().toLowerCase();
      visible=result.items.filter(row=>!term || row.anchor.toLowerCase().includes(term) || row.text.toLowerCase().includes(term)).slice(0,200);
      pick.replaceChildren(...visible.map((row,i)=>{const option=node('option',row.anchor);option.value=String(i);return option;}));
      showChoice();
    }
    search.oninput=findEntries;pick.onchange=showChoice;findEntries();
    const selectedCount=node('p');
    function showSelected() {
      chosen.replaceChildren(); selectedCount.textContent=`${selected.length} excerpts selected for this document. Excerpts are still local and unredacted.`;
      selected.forEach((row,index)=>{const li=node('li',`${row.anchor} · ${row.method==='manual'?'Human-supplied evidence':'Extracted source text'} `);li.append(button('Remove',()=>{selected.splice(index,1);showSelected();}));chosen.append(li);});
    }
    function selectEvidence(row) {
      requireValue(selected.length<30, 'Select at most 30 excerpts here. Additional evidence can be prepared separately.');
      requireValue(row.text.trim() && row.text.length<=6000 && row.anchor.trim() && row.anchor.length<=180, 'An excerpt needs a location up to 180 characters and text up to 6,000 characters.');
      requireValue(!selected.some(value=>value.anchor===row.anchor && value.text===row.text), 'This excerpt is already selected.');
      selected.push({anchor:row.anchor.trim(),text:row.text,method:row.method}); showSelected();
    }
    preview.append(field('Find an entry (first 200 matches shown)',search), field('Source entry',pick), excerpt,
      button('Use this source excerpt',()=>work(()=>{const row=visible[Number(pick.value)];requireValue(row,'Choose a source entry.');selectEvidence(row);})));
    const manual=node('details');manual.append(node('summary','Add local inspection evidence'));
    const anchor=input('text','Inspected location'), text=node('textarea');text.setAttribute('aria-label','Human-supplied evidence');text.maxLength=6000;anchor.maxLength=180;
    manual.append(node('p','Record what you inspected and its location. This is human-supplied evidence, not independently extracted text or proof of recalculation.'),field('Inspected location',anchor),field('Inspection evidence and limitations',text),button('Use human-supplied evidence',()=>work(()=>{selectEvidence({anchor:anchor.value,text:text.value,method:'manual'});anchor.value='';text.value='';})));
    preview.append(manual,selectedCount,chosen); showSelected();
    const label=input('text','Version label');label.maxLength=120;label.placeholder='Active internal workbook — reviewed locally';
    const provenance=node('select');provenance.setAttribute('aria-label','Source provenance');
    for(const [value,title] of [['original','Original source'],['derivative','Supported derivative of a registered source']]){const option=node('option',title);option.value=value;provenance.append(option);}
    const sourceVersion=node('select');sourceVersion.setAttribute('aria-label','Derivative source version');
    for(const version of context.document.versions || []){const option=node('option',version.label);option.value=version.id;sourceVersion.append(option);}
    sourceVersion.disabled=true;provenance.onchange=()=>{sourceVersion.disabled=provenance.value!=='derivative';};
    const activate=input('checkbox','Use this as the active version'), approved=input('checkbox','I reviewed these source excerpts and limitations');
    preview.append(field('Neutral version label (saved locally; source filename is not saved)',label),field('Provenance',provenance),field('Derivative source version',sourceVersion),field('Use this as the active version',activate),field('I reviewed these source excerpts and limitations',approved));
    const save=button('Register version and retain selected evidence',()=>work(async()=>{
      requireValue(label.value.trim(), 'Enter a neutral version label.');
      requireValue(approved.checked, 'Review the selected excerpts and limitations before retaining them.');
      requireValue(HEX.test(result.sha256),'Missing source identity.');
      if(provenance.value==='derivative') requireValue(sourceVersion.value,'Choose the original registered version for this derivative.');
      active();save.disabled=true;file.disabled=true;
      const savedResult=result, savedItems=structuredClone(selected), current=generation;
      try {
        const registration=await context.registerVersion({label:label.value.trim(),sha256:result.sha256,size:result.size,format:result.kind,provenance:provenance.value,coverage:result.coverage,limitations:structuredClone(result.limitations),...(provenance.value==='derivative'?{sourceVersionId:sourceVersion.value}:{}),activate:activate.checked});
        const version=registration.version;
        requireValue(version?.id,'The saved source version was not returned.');
        if(current!==generation)return;
        await onEvidence?.({proposalId:context.proposalId,documentId:context.documentId,versionId:version.id,sha256:savedResult.sha256,coverage:savedResult.coverage,limitations:structuredClone(savedResult.limitations),items:savedItems});
        message.textContent=`Version registered with ${savedItems.length} locally retained excerpts. Approve packet contents separately before sharing.`;
        selected=[]; preview.replaceChildren(); file.value=''; result=null;
      } finally { save.disabled=false;file.disabled=false; }
    }));
    preview.append(save);
  }
  return {close(){generation++;result=null;selected=[];root.replaceChildren();}};
}
