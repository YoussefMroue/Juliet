import {sealPacket, sealPacketSet, packetRegistration, verifyPacket, verifyReport} from './packet.js';
import {requiredFollowups, REVIEW_OPTIONS} from './review-context.js';

function node(tag, text) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}
function label(title, control) { const el = node('label', title); el.append(control); return el; }
function picker(title) {
  const input = node('input'); input.type = 'file'; input.accept = '.json,application/json';
  return {input, label:label(title, input)};
}
async function readFile(input, originalPacket = false) {
  const file = input.files?.[0];
  if (!file || file.size > 8 * 1024 * 1024) throw Error('Choose a Juliet JSON file no larger than 8 MiB.');
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch { throw Error('The selected file is not readable JSON.'); }
  if (originalPacket && text !== JSON.stringify(data, null, 2)) throw Error('Choose the original unedited packet download.');
  return data;
}
function download(packet) {
  const link = node('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(packet, null, 2)], {type:'application/json'}));
  link.download = 'Juliet-packet-' + packet.packetId + '.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
}
const outcome = {checked:'Checked within scope',missing:'Missing',unchecked:'Unchecked',decision_needed:'Decision needed',not_applicable:'Not applicable'};
export function showRoundExchange(host, context, {evidence = []} = {}) {
  host.replaceChildren(); host.hidden = !context;
  if (!context) return;
  const section = node('div'); host.append(section);
  const current = () => section.parentNode === host && !host.hidden;
  const status = node('p'); status.setAttribute('role', 'status');
  function button(text, action) {
    const el = node('button', text); el.type = 'button';
    el.addEventListener('click', async () => {
      if (!current() || section.inert) return;
      section.inert = true; status.textContent = '';
      try { await action(); } catch (error) { if(current()) status.textContent = error.message || 'The operation could not be completed.'; }
      finally { section.inert = false; }
    });
    return el;
  }
  const v3 = context.workflowVersion === 3;
  section.append(node('h3',v3 ? 'Review packet' : 'Legacy fictional packet'), node('p',context.proposalLabel+' · Round '+context.roundNumber),
    node('p','Prepare the evidence on this device. The approved download includes scope, inventory labels, source references, prior findings, follow-ups and selected evidence. It may contain confidential research or salary figures. Review all contents before manually sharing it in your permitted review workspace. Originals and private backups are excluded.'));
  if(context.reviewContext) {
    const c=context.reviewContext;
    const title=(key,value)=>REVIEW_OPTIONS[key].find(([v])=>v===value)?.[1] || value;
    section.append(node('p',title('lane',c.lane)+' · '+title('purpose',c.purpose)),node('p','Opportunity and edition: '+(c.opportunity||'Unknown')),
      node('p','Scope: '+c.scope),node('p','Requested checks: '+c.requestedChecks.join(', ')),node('p','Guidance: '+c.guidanceStatus),
      node('p','Calculation evidence (user-recorded): '+c.calculationEvidence+' · '+(c.calculationNote||'No calculation evidence recorded.')));
    const inventory=node('ul');
    for(const doc of context.documents) inventory.append(node('li',`${doc.name} · ${doc.category} · ${doc.requirement} · ${doc.version?.label||'No active version'} · ${doc.source||'No guidance reference'}`));
    section.append(node('h4','Frozen inventory'),inventory);
    for(const f of context.priorFindings??[])section.append(node('p',`Prior ${f.findingId} · ${f.disposition} · ${f.message} · ${f.owner||'Unassigned'} · ${f.nextAction}`));
    if(v3) {
      section.append(node('h4','Assigned checklist'));
      for(const check of context.checklist??[])section.append(node('p',`${check.label} · ${check.applicability} · ${check.basis||'Basis missing'}`));
    }
  } else section.append(node('p','This legacy round has no frozen scope. Import its existing packet below, or record a new round.'));
  const docs=node('select');
  for(const doc of context.documents.filter(d=>d.version)) { const option=node('option',doc.name+' · v'+doc.version.number); option.value=doc.id;docs.append(option); }
  const anchor=node('input');anchor.maxLength=180;
  const excerpt=node('textarea');excerpt.maxLength=6000;
  const note=node('input');note.maxLength=500;
  const rows=node('ol'),followups=node('div'),packetPreview=node('div'),downloads=node('div');
  const entries=[];
  let candidates=null,approvedPacket=null;
  const consent=node('input');consent.type='checkbox';
  function invalidate(){candidates=null;packetPreview.replaceChildren();consent.checked=false;}
  for(const input of [anchor,excerpt,note,docs])input.addEventListener('input',invalidate);
  function renderEntries(){
    invalidate();rows.replaceChildren();
    entries.forEach((entry,i)=>{
      const li=node('li'),doc=context.documents.find(d=>d.id===entry.documentId);
      li.append(node('strong',`E${i+1} · ${doc.name} · ${entry.anchor}`),node('p',entry.text),
        node('p',`${entry.provenance?.method==='extracted'?'Locally extracted':'Human-supplied evidence'} · ${entry.provenance?.note||'Check against the source.'}`),
        button('Remove excerpt',()=>{entries.splice(i,1);renderEntries();}));rows.append(li);
    });
    followups.replaceChildren();
    if(context.reviewContext&&!v3){
      const items=entries.map(e=>({...e,category:context.documents.find(d=>d.id===e.documentId).category}));
      for(const gap of requiredFollowups(context.reviewContext,context.documents,items,context.priorFindings??[]))followups.append(node('p',`${gap.id} · ${gap.message} Next action: ${gap.nextAction}`));
    }
  }
  const add=button('Add excerpt',()=>{
    if(!docs.value||!anchor.value.trim()||!excerpt.value.trim())throw Error('Select a frozen document version, enter a location and enter its evidence.');
    if(v3&&!note.value.trim())throw Error('Describe who inspected or supplied this evidence and any limits.');
    entries.push({documentId:docs.value,anchor:anchor.value.trim(),text:excerpt.value.trim(),...(v3?{provenance:{method:'manual',note:note.value.trim()}}:{})});
    anchor.value='';excerpt.value='';note.value='';renderEntries();anchor.focus();
  });
  const available=evidence.filter(e=>context.documents.some(d=>d.id===e.documentId&&d.version?.id===e.versionId));
  if(v3&&available.length)section.append(button('Add prepared evidence from this session',()=>{
    for(const e of available)if(!entries.some(row=>row.documentId===e.documentId&&row.anchor===e.anchor&&row.text===e.text))entries.push({documentId:e.documentId,anchor:e.anchor,text:e.text,provenance:e.provenance});
    renderEntries();status.textContent='Prepared evidence added. Review all passages before approving the packet.';
  }));
  const previewPackets=button('Preview review packets',async()=>{
    if(anchor.value.trim()||excerpt.value.trim()||note.value.trim())throw Error('Add or clear the unfinished excerpt before previewing.');
    const sealed=v3?await sealPacketSet(context,entries):[await sealPacket(context,entries)];
    if(!current())return;
    candidates=sealed;packetPreview.replaceChildren();consent.checked=false;
    packetPreview.append(node('p',`${sealed.length} batch(es). Review each complete packet below. Each batch is reviewed in its own fresh chat.`));
    for(const packet of sealed){
      const detail=node('details');detail.append(node('summary',`Packet ${packet.batchIndex??1} of ${packet.batchCount??1} · all exported contents`),node('pre',JSON.stringify(packet,null,2)));packetPreview.append(detail);
      for(const gap of packet.requiredFollowups??[])packetPreview.append(node('p',`Required follow-up ${gap.id}: ${gap.message}`));
    }
  });
  const save=button('Register approved packet set',async()=>{
    if(!consent.checked||!candidates)throw Error('Preview the complete packets and approve their contents first.');
    const packets=candidates;
    if(v3)await context.registerPacketSet(packets.map(packetRegistration));
    else await context.registerPacket({packetId:packets[0].packetId,digest:packets[0].digest});
    if(!current())return;
    reset();p.input.value='';r.input.value='';approvedPacket=packets.length===1?packets[0]:null;
    downloads.replaceChildren();
    for(const packet of packets)downloads.append(button(`Download packet ${packet.batchIndex??1} of ${packet.batchCount??1}`,()=>download(packet)));
    candidates=null;consent.checked=false;
    status.textContent='Packet set registered. Download each packet and keep its original file to validate the returned report. No files were uploaded.';
  });
  if(context.reviewContext){
    section.append(label('Document version',docs),label('Page, paragraph or sheet and cell',anchor),label(v3?'Evidence excerpt':'Fictional excerpt',excerpt));
    if(v3)section.append(label('Human evidence source and limitations',note));
    section.append(add,rows,followups,previewPackets,packetPreview,
      label(v3?'I reviewed every packet, including metadata, quotations and salary or research details, and approve these contents for my permitted review workspace.':'I reviewed every packet and confirm all material is fictional.',consent),save,downloads);
  }
  renderEntries();
  const p=picker('Original registered packet'),r=picker('Returned findings JSON'),preview=node('div');
  let pending=null;
  const reset=()=>{pending=null;preview.replaceChildren();accept.hidden=true;};
  const accept=button('Save checked report to this round',async()=>{
    if(!pending)throw Error('Check the report before saving it.');
    await context.recordReport(pending);reset();status.textContent='Report recorded against its frozen round. Review the findings in history; importing does not change decisions or proposal status.';
  });accept.hidden=true;
  p.input.addEventListener('change',reset);r.input.addEventListener('change',reset);
  const validate=button('Check packet and report',async()=>{
    reset();const source=p.input.files.length?await readFile(p.input,true):approvedPacket;
    if(!source)throw Error('Choose the registered packet used by the reviewer.');
    const packet=await verifyPacket(context,source),report=verifyReport(packet,await readFile(r.input));
    if(!current())return;
    preview.append(node('p','Packet '+packet.packetId+' · Report '+report.reportId),node('p',`${report.coverage.reviewed.length} excerpts reviewed · ${report.coverage.unreviewed.length} unreviewed.`));
    for(const check of report.checkResults??[])preview.append(node('p',`${packet.checklist.find(c=>c.checkId===check.checkId)?.label||check.checkId}: ${outcome[check.status]||check.status} · ${check.message}`));
    for(const f of report.findings){
      preview.append(node('p',f.type+' · '+f.message));
      if(f.id)preview.append(node('p',`${f.id} · Owner: ${f.owner||'Unassigned'} · Next action: ${f.nextAction}`));
      if(f.calculation)preview.append(node('p','Calculation to verify: '+f.calculation));
      for(const [title,refs]of [['Proposal evidence',f.evidence],['Guidance',f.guidance]])for(const ref of refs){
        const item=packet.items.find(i=>i.itemId===ref.itemId),doc=context.documents.find(d=>d.id===item.documentId);
        preview.append(node('p',[title,ref.itemId,doc.name,doc.version.label,item.anchor,ref.quote].join(' · ')));
      }
    }
    for(const gap of report.requiredFollowups??[])preview.append(node('p',`Required follow-up ${gap.id}: ${gap.message} Next action: ${gap.nextAction}`));
    pending=report;accept.hidden=false;status.textContent='Packet identity, coverage and quotations match. Check relevance and reasoning before saving.';
  });
  section.append(node('h4','Return findings'),node('p','Use one fresh review chat per packet. Return with that original packet and its findings JSON. Historical results cannot certify the current files.'),p.label,r.label,validate,preview,accept,status);
}
