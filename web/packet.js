import {normalizeReviewContext, normalizePriorFindings, requiredFollowups, normalizeFollowups, GUIDANCE} from './review-context.js';
import {normalizeChecklist, CHECK_RESULTS} from './checklist.js';
// The digest binds the selected excerpt text and its provenance. It is not a signature.
export const RELEASE = '1.0.0';
const LEGACY_RELEASE = '0.2.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const kinds = ['objective_error', 'question', 'suggestion', 'coverage_gap'];
function check(ok, message) {
  if (!ok) throw Error(message);
}
function keys(value, allowed) {
  check(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value, key)),
    'File fields do not match the Juliet format.');
}
function string(value, limit) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}
function sameIds(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
function sameValue(a,b) {
  const canonical=v=>Array.isArray(v) ? v.map(canonical) : v && typeof v==='object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])) : v;
  return JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
}
function header(context, body) {
  check(UUID.test(body.proposalId) && UUID.test(body.roundId) && context.proposalId === body.proposalId &&
    context.roundId === body.roundId, 'This file belongs to another proposal or review round.');
  check(UUID.test(body.packetId) && UUID.test(body.reportId) && ['0.1.0', LEGACY_RELEASE, RELEASE].includes(body.reviewerRelease),
    'Unknown reviewer release or invalid packet identity.');
}
// Reconstruct fields in a fixed order so JSON formatting and input property order do not affect the digest.
function packetBody(context, packet) {
  header(context, packet);
  const legacy=packet.format==='juliet.packet.v1' && packet.reviewerRelease==='0.1.0';
  check((legacy || (packet.format==='juliet.packet.v2' && packet.reviewerRelease===LEGACY_RELEASE)) && packet.material === 'fictional-excerpts',
    'Only fictional excerpt packets are supported by this release.');
  check(!legacy || !context.reviewContext,'A scoped round cannot be downgraded to a legacy packet.');
  check(Array.isArray(packet.items) && packet.items.length > 0 && packet.items.length <= 30,
    'A packet needs between one and thirty excerpts.');
  let total = 0;
  const items = packet.items.map((item, index) => {
    keys(item, ['itemId', 'documentId', 'versionId', 'category', 'anchor', 'text']);
    const source = context.documents.find(doc => doc.id === item.documentId);
    check(source?.version && source.version.id === item.versionId && source.category === item.category,
      'An excerpt refers to a document version outside this frozen round.');
    check(item.itemId === 'E' + (index + 1) && string(item.anchor, 180) && string(item.text, 6000),
      'Each excerpt needs a location and up to 6,000 characters of text.');
    total += item.text.length;
    return {itemId:item.itemId, documentId:item.documentId, versionId:item.versionId,
      category:item.category, anchor:item.anchor, text:item.text};
  });
  check(total <= 60000, 'The packet exceeds 60,000 characters of excerpt text.');
  const body={format:packet.format, material:'fictional-excerpts', reviewerRelease:packet.reviewerRelease,
    proposalId:packet.proposalId, roundId:packet.roundId, packetId:packet.packetId, reportId:packet.reportId};
  if(!legacy) {
    const reviewContext=normalizeReviewContext(context.reviewContext);
    check(reviewContext.handling==='fictional_only','Legacy v2 packets support fictional material only. Create a v3 round for real proposal evidence.');
    const inventory=context.documents.map(doc=>({documentId:doc.id,versionId:doc.version?.id ?? null,name:doc.name,category:doc.category,requirement:doc.requirement,source:doc.source}));
    const priorFindings=normalizePriorFindings(context.priorFindings ?? []);
    const followups=requiredFollowups(reviewContext,context.documents,items,priorFindings);
    for(const [key,value] of Object.entries({reviewContext,inventory,priorFindings,requiredFollowups:followups})) {
      check(sameValue(packet[key],value),'The packet review scope, inventory or required follow-ups do not match this frozen round.');
      body[key]=value;
    }
  }
  return {...body,items};
}
async function digest(body) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2,'0')).join('');
}
export async function sealPacket(context, excerpts) {
  if(context.workflowVersion===3) {
    const packets=await sealPacketSet(context,excerpts);
    check(packets.length===1,'This review needs multiple batches. Use the complete packet-set handoff.');
    return packets[0];
  }
  check(context.reviewContext,'Record a new round with review scope before creating a packet. Existing legacy packets can still be imported.');
  const items = excerpts.map(({documentId, anchor, text}, index) => {
    const doc = context.documents.find(d => d.id === documentId);
    check(doc?.version, 'Choose a versioned document from this review round.');
    return {itemId:'E' + (index+1), documentId, versionId:doc.version.id, category:doc.category,
      anchor:anchor.trim(), text:text.trim()};
  });
  const reviewContext=normalizeReviewContext(context.reviewContext);
  const priorFindings=normalizePriorFindings(context.priorFindings ?? []);
  const inventory=context.documents.map(doc=>({documentId:doc.id,versionId:doc.version?.id ?? null,name:doc.name,category:doc.category,requirement:doc.requirement,source:doc.source}));
  const body = packetBody(context, {format:'juliet.packet.v2', material:'fictional-excerpts', reviewerRelease:LEGACY_RELEASE,
    proposalId:context.proposalId, roundId:context.roundId, packetId:crypto.randomUUID(), reportId:crypto.randomUUID(),
    reviewContext, inventory, priorFindings, requiredFollowups:requiredFollowups(reviewContext,context.documents,items,priorFindings), items});
  return {...body, digest:await digest(body)};
}
export async function verifyPacket(context, packet) {
  if(packet?.format==='juliet.packet.v3') return verifyV3Packet(context,packet);
  keys(packet, ['format','material','reviewerRelease','proposalId','roundId','packetId','reportId',...(packet.format==='juliet.packet.v2' ? ['reviewContext','inventory','priorFindings','requiredFollowups'] : []),'items','digest']);
  const body = packetBody(context, packet);
  check(HEX.test(packet.digest) && await digest(body) === packet.digest, 'The packet contents or digest have changed.');
  check(context.packets.some(p => p.packetId === body.packetId && p.digest === packet.digest),
    'This packet was not registered in the selected round.');
  return {...body, digest:packet.digest};
}
export function verifyReport(packet, report) {
  if(packet?.format==='juliet.packet.v3') return verifyV3Report(packet,report);
  keys(report, ['format','reviewerRelease','proposalId','roundId','packetId','reportId','digest','coverage','findings']);
  header(packet, report);
  const v2=packet.format==='juliet.packet.v2';
  check(report.reviewerRelease===packet.reviewerRelease && report.format === (v2 ? 'juliet.findings.v2' : 'juliet.findings.v1') && report.packetId === packet.packetId &&
    report.digest === packet.digest && report.reportId === packet.reportId, 'The report does not match this sealed packet.');
  keys(report.coverage, ['reviewed','unreviewed']);
  const {reviewed, unreviewed} = report.coverage;
  check(Array.isArray(reviewed) && Array.isArray(unreviewed) &&
    sameIds([...reviewed, ...unreviewed].sort(), packet.items.map(i => i.itemId).sort()),
    'Coverage must list each packet excerpt exactly once.');
  check(Array.isArray(report.findings) && report.findings.length <= (v2 ? 120 : 30), 'Too many findings for this report format.');
  function citations(refs, role) {
    check(Array.isArray(refs) && refs.length <= 6, 'A finding can cite up to six excerpts per evidence field.');
    return refs.map(ref => {
      keys(ref, ['itemId','quote']);
      const item = packet.items.find(i => i.itemId === ref.itemId);
      check(item && reviewed.includes(item.itemId) && string(ref.quote, 300) && item.text.includes(ref.quote),
        'A citation is missing from its reviewed excerpt or the quotation does not match.');
      if (role === 'guidance') check((v2 ? GUIDANCE : ['Opportunity guidance']).includes(item.category), 'A rule citation must reference supplied guidance.');
      return {itemId:ref.itemId, quote:ref.quote};
    });
  }
  const carried=new Set();
  const findings = report.findings.map((finding,index) => {
    keys(finding, ['type','message','evidence','guidance',...(v2 ? ['gapIds','priorFindingId','owner','nextAction','calculation'] : [])]);
    check(kinds.includes(finding.type) && string(finding.message, 1000), 'Unknown finding type or invalid message.');
    const evidence = citations(finding.evidence, 'evidence');
    const guidance = citations(finding.guidance, 'guidance');
    if (['objective_error','suggestion'].includes(finding.type)) {
      check(evidence.some(ref => !GUIDANCE.includes(packet.items.find(item => item.itemId === ref.itemId).category)),
        'Corrections and suggestions must cite proposal evidence.');
    }
    if (finding.type === 'objective_error') {
      const locations = new Set(evidence.map(ref => packet.items.find(item => item.itemId === ref.itemId))
        .filter(item => !GUIDANCE.includes(item.category))
        .map(item => JSON.stringify([item.documentId, item.versionId, item.anchor.trim().toLowerCase().replace(/\s+/g, ' ')])));
      check(guidance.length || locations.size >= 2 || (v2 && string(finding.calculation,500)),
        'An objective error requires cited guidance or two distinct proposal locations, or an explicit calculation in a scoped packet.');
    }
    const row={type:finding.type, message:finding.message, evidence, guidance};
    if(v2) {
      check(Array.isArray(finding.gapIds) && finding.gapIds.length<=300 && new Set(finding.gapIds).size===finding.gapIds.length,'Invalid required follow-up references.');
      check(string(finding.nextAction,300) && typeof finding.owner==='string' && finding.owner.length<=100 && typeof finding.calculation==='string' && finding.calculation.length<=500,'Each finding needs a next action and bounded owner/calculation text.');
      check(finding.priorFindingId===null || (packet.priorFindings.some(p=>p.findingId===finding.priorFindingId) && !carried.has(finding.priorFindingId)),'A prior finding is foreign or duplicated.');
      if(finding.priorFindingId) {
        carried.add(finding.priorFindingId);
        check(finding.gapIds.some(id=>packet.requiredFollowups.some(g=>g.id===id && g.priorFindingId===finding.priorFindingId)),'A carried finding must link its required follow-up.');
      }
      for(const id of finding.gapIds) {
        const gap=packet.requiredFollowups.find(g=>g.id===id);
        check(gap && (gap.priorFindingId ? gap.priorFindingId===finding.priorFindingId : gap.type===finding.type),'A required follow-up is unknown or its type/identity does not match.');
      }
      Object.assign(row,{id:finding.priorFindingId || `${report.reportId}/F${index+1}`,gapIds:[...finding.gapIds],priorFindingId:finding.priorFindingId,owner:finding.owner,nextAction:finding.nextAction,calculation:finding.calculation});
    }
    return row;
  });
  if(v2) for(const gap of packet.requiredFollowups) check(findings.some(f=>f.gapIds.includes(gap.id)),`Required follow-up ${gap.id} is missing from the report. It cannot be replaced by a prose-only note.`);
  check(!unreviewed.length || findings.some(f => f.type === 'coverage_gap'), 'Describe any unreviewed excerpts as a coverage gap.');
  const locations = packet.items.map(({itemId, documentId, versionId, anchor}) => ({itemId, documentId, versionId, anchor}));
  return {packetId:packet.packetId, digest:packet.digest, reportId:report.reportId, locations,...(v2 ? {requiredFollowups:structuredClone(packet.requiredFollowups)} : {}),
    coverage:{reviewed:[...reviewed], unreviewed:[...unreviewed]}, findings};
}

const MAX_BYTES=8*1024*1024;
const V3_FIELDS=['format','material','reviewerRelease','proposalId','roundId','packetId','reportId',
  'packetSetId','batchId','batchIndex','batchCount','manifestDigest','reviewContext','inventory','priorFindings',
  'checklist','heldCheckIds','assignedCheckIds','evidenceCoverage','batchManifest','requiredFollowups','items','digest'];
async function v3Digest(value) {
  const canonical=v=>Array.isArray(v)?v.map(canonical):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(key=>[key,canonical(v[key])])):v;
  return digest(canonical(value));
}
function bounded(value) {
  check(new TextEncoder().encode(JSON.stringify(value)).length<=MAX_BYTES,'The review envelope exceeds 8 MiB. Narrow the round before exporting or importing.');
}
function provenance(value={method:'manual',note:'User-supplied excerpt; inspect the original locally.'}) {
  keys(value,['method','note']);
  check(['extracted','manual'].includes(value.method) && typeof value.note==='string' && value.note.length<=500 && (value.method!=='manual' || value.note.trim()),'Manual evidence requires an attribution note; extraction provenance must be bounded.');
  return {method:value.method,note:value.note.trim()};
}
function sourceCoverage(version) {
  const coverage=version?.coverage ?? 'not_recorded', limitations=version?.limitations ?? [];
  check(['supported_text','partial','blocked','not_recorded'].includes(coverage) && Array.isArray(limitations) && limitations.length<=1000,'Invalid source extraction coverage.');
  check(version?.sha256==null || HEX.test(version.sha256),'Invalid source fingerprint.');
  const provenance=version?.provenance ?? 'not_recorded', sourceVersionId=version?.sourceVersionId ?? null;
  check(['original','derivative','manual','not_recorded'].includes(provenance) && (sourceVersionId===null || (provenance==='derivative' && UUID.test(sourceVersionId))),'Invalid source provenance.');
  check(provenance!=='derivative' || sourceVersionId!==null,'A derivative requires its original registered source version.');
  return {provenance,sourceVersionId,coverage,limitations:limitations.map(row=>{
    keys(row,['location','feature','message']);
    check(typeof row.location==='string' && row.location.length<=500 && string(row.feature,200) && string(row.message,1000),'Invalid source extraction limitation.');
    return {location:row.location,feature:row.feature,message:row.message};
  })};
}
function v3Inventory(context) {
  return context.documents.map(doc=>({documentId:doc.id,versionId:doc.version?.id ?? null,
    name:doc.name,category:doc.category,requirement:doc.requirement,source:doc.source,
    sha256:doc.version?.sha256 ?? null,...sourceCoverage(doc.version)}));
}
function v3Context(context) {
  check(context.workflowVersion===3,'A v3 packet requires a v3 review round.');
  check(UUID.test(context.proposalId) && UUID.test(context.roundId),'Invalid proposal or review-round identity.');
  return {reviewContext:normalizeReviewContext(context.reviewContext,{reviewOnly:true}),
    inventory:v3Inventory(context),priorFindings:normalizePriorFindings(context.priorFindings ?? []),
    checklist:normalizeChecklist(context.checklist,context.documents)};
}
function heldChecks(context, checklist) {
  const values=context.heldCheckIds ?? [];
  check(Array.isArray(values) && new Set(values).size===values.length && values.every(id=>checklist.some(c=>c.checkId===id)),'A held check is foreign or duplicated.');
  return checklist.map(c=>c.checkId).filter(id=>values.includes(id));
}
function v3Items(context,excerpts) {
  check(Array.isArray(excerpts) && excerpts.length<=9000,'Select bounded evidence for the review; a packet set supports at most 9,000 excerpts.');
  return excerpts.map(item=>{
    const doc=context.documents.find(d=>d.id===item.documentId);
    check(doc?.version && (!item.versionId || item.versionId===doc.version.id),'An excerpt refers to a document version outside this frozen round.');
    check(string(item.anchor,180) && string(item.text,6000),'Each excerpt needs a location and up to 6,000 characters of text.');
    return {documentId:doc.id,versionId:doc.version.id,category:doc.category,anchor:item.anchor.trim(),text:item.text.trim(),provenance:provenance(item.provenance)};
  });
}
function fits(items) { return items.length<=30 && items.reduce((n,item)=>n+item.text.length,0)<=60000; }
function withIds(items) { return items.map((item,index)=>({itemId:'E'+(index+1),...item})); }
function coverageFor(context, items) {
  return context.documents.map(doc=>({documentId:doc.id,versionId:doc.version?.id ?? null,
    status:items.some(i=>i.documentId===doc.id)?'provided':doc.requirement==='Not applicable'?'not_applicable':'not_supplied',
    methods:['extracted','manual'].filter(method=>items.some(i=>i.documentId===doc.id && i.provenance.method===method))}));
}
function v3Followups(context,items,assigned,first,evidenceCoverage) {
  const dependencies=new Set(assigned.flatMap(c=>[...c.documentIds,...c.sourceDocumentIds]));
  const documents=context.documents.filter(d=>dependencies.has(d.id));
  // Global omissions use the complete approved set's presence ledger. A source
  // assigned to another batch is not falsely reported as absent from the set.
  const supplied=context.documents.filter(doc=>evidenceCoverage.some(row=>row.documentId===doc.id && row.status==='provided'))
    .map(doc=>({documentId:doc.id,category:doc.category}));
  const rows=first?requiredFollowups(context.reviewContext,context.documents,supplied,context.priorFindings??[],{reviewOnly:true}):[];
  const add=(type,message,nextAction,documentId=null)=>rows.push({id:'G'+(rows.length+1),type,documentId,priorFindingId:null,message,nextAction});
  for(const doc of documents) {
    if(doc.requirement==='Required' && !items.some(item=>item.documentId===doc.id) && !rows.some(row=>row.documentId===doc.id && row.type==='coverage_gap'))
      add('coverage_gap',`${doc.name}: required evidence is absent from this batch.`,'Supply the required material or record the affected review limitation.',doc.id);
    if(['partial','blocked'].includes(doc.version?.coverage))
      add('coverage_gap',`${doc.name}: source extraction is ${doc.version.coverage}. Unsupported portions are not established by selected excerpts.`,
        'Review the frozen extraction limitations, identify affected checks and obtain supported or attributed manual evidence.',doc.id);
  }
  for(const entry of assigned) {
    if(entry.applicability==='unknown') add('question',`${entry.label}: applicability remains unknown.`,'Have Lynn confirm applicability from the governing source.');
    for(const id of entry.sourceDocumentIds) if(!items.some(i=>i.documentId===id) && !rows.some(r=>r.documentId===id))
      add('coverage_gap',`${entry.label}: the required source evidence is absent.`,'Supply the applicable source edition and location, or leave this check unresolved.',id);
  }
  return normalizeFollowups(rows);
}
function manifestBody(packet) {
  return {proposalId:packet.proposalId,roundId:packet.roundId,packetSetId:packet.packetSetId,
    reviewContext:packet.reviewContext,inventory:packet.inventory,priorFindings:packet.priorFindings,
    checklist:packet.checklist,heldCheckIds:packet.heldCheckIds,evidenceCoverage:packet.evidenceCoverage,batchManifest:packet.batchManifest};
}
function bodyWithoutDigest(packet) { return Object.fromEntries(V3_FIELDS.filter(k=>k!=='digest').map(k=>[k,packet[k]])); }

export function packetRegistration(packet) {
  const result={packetId:packet.packetId,digest:packet.digest};
  if(packet.format==='juliet.packet.v3') Object.assign(result,{format:packet.format,reviewerRelease:packet.reviewerRelease,
    reportId:packet.reportId,packetSetId:packet.packetSetId,batchId:packet.batchId,batchIndex:packet.batchIndex,
    batchCount:packet.batchCount,manifestDigest:packet.manifestDigest,assignedCheckIds:[...packet.assignedCheckIds]});
  return result;
}

export async function sealPacketSet(context, excerpts) {
  check(!context.wholeReviewHeld,'Lynn has placed the whole review on hold. Clear the hold before sealing another packet.');
  const frozen=v3Context(context), heldCheckIds=heldChecks(context,frozen.checklist);
  const all=v3Items(context,excerpts), groups=[], used=new Set();
  // A check's complete selected evidence stays together. Shared evidence may
  // repeat between batches, but each checklist assignment occurs exactly once.
  for(const entry of frozen.checklist) {
    const dependencies=new Set([...entry.documentIds,...entry.sourceDocumentIds]);
    const indexes=all.flatMap((item,index)=>dependencies.has(item.documentId)?[index]:[]);
    check(fits(indexes.map(i=>all[i])),'One check exceeds a batch limit. Narrow that check and its selected evidence; it cannot be split across chats.');
    let group=groups.at(-1);
    const union=group?[...new Set([...group.indexes,...indexes])]:indexes;
    if(!group || !fits(union.map(i=>all[i]))) { group={indexes:[],checks:[]};groups.push(group); }
    group.indexes=[...new Set([...group.indexes,...indexes])];group.checks.push(entry.checkId);
    indexes.forEach(i=>used.add(i));
  }
  for(let index=0;index<all.length;index++) if(!used.has(index)) {
    let group=groups.at(-1);
    if(!group || !fits([...group.indexes.map(i=>all[i]),all[index]])) {group={indexes:[],checks:[]};groups.push(group);}
    group.indexes.push(index);
  }
  check(groups.length<=300,'Too many batches. Narrow this review round.');
  // Empty evidence is allowed for a scoped missing-material check, but a whole
  // packet set must contain the deliberately supplied evidence selected above.
  const plans=await Promise.all(groups.map(async group=>({batchId:crypto.randomUUID(),packetId:crypto.randomUUID(),reportId:crypto.randomUUID(),
    assignedCheckIds:group.checks,itemHashes:await Promise.all(group.indexes.map(i=>v3Digest(all[i])))})));
  const shared={proposalId:context.proposalId,roundId:context.roundId,packetSetId:crypto.randomUUID(),...frozen,heldCheckIds,
    evidenceCoverage:coverageFor(context,all),batchManifest:plans};
  const manifestDigest=await v3Digest(manifestBody(shared));
  const packets=[];
  for(const [index,plan] of plans.entries()) {
    const items=withIds(groups[index].indexes.map(i=>all[i]));
    const assigned=frozen.checklist.filter(c=>plan.assignedCheckIds.includes(c.checkId));
    const raw={format:'juliet.packet.v3',material:frozen.reviewContext.handling==='real_proposal'?'approved-proposal-evidence':'fictional-excerpts',reviewerRelease:RELEASE,
      ...shared,packetId:plan.packetId,reportId:plan.reportId,batchId:plan.batchId,batchIndex:index+1,batchCount:plans.length,
      manifestDigest,assignedCheckIds:plan.assignedCheckIds,requiredFollowups:v3Followups(context,items,assigned,index===0,shared.evidenceCoverage),items};
    const body=bodyWithoutDigest(raw), packet={...body,digest:await v3Digest(body)};
    bounded(packet);packets.push(packet);
  }
  return packets;
}

async function verifyV3Packet(context,packet) {
  bounded(packet);keys(packet,V3_FIELDS);header(context,packet);
  check(packet.reviewerRelease===RELEASE && packet.material===(packet.reviewContext.handling==='real_proposal'?'approved-proposal-evidence':'fictional-excerpts'),'Unknown v3 release or material handling.');
  const frozen=v3Context(context);
  for(const [key,value] of Object.entries(frozen)) check(sameValue(packet[key],value),'The packet review scope, inventory or checklist does not match this frozen round.');
  const expectedHeld=heldChecks({...context,heldCheckIds:packet.heldCheckIds},frozen.checklist);
  check(sameValue(expectedHeld,packet.heldCheckIds),'Invalid held-check snapshot.');
  check(UUID.test(packet.packetSetId) && UUID.test(packet.batchId) && Number.isInteger(packet.batchIndex) && Number.isInteger(packet.batchCount) && packet.batchCount>0 && packet.batchCount<=300 && packet.batchIndex>0 && packet.batchIndex<=packet.batchCount,'Invalid packet batch identity.');
  check(Array.isArray(packet.batchManifest) && packet.batchManifest.length===packet.batchCount,'The batch manifest is incomplete.');
  const identities=new Set(),assignments=[];
  for(const batch of packet.batchManifest) {
    keys(batch,['batchId','packetId','reportId','assignedCheckIds','itemHashes']);
    for(const field of ['batchId','packetId','reportId']) {check(UUID.test(batch[field]) && !identities.has(batch[field]),'A batch identity is invalid or duplicated.');identities.add(batch[field]);}
    check(Array.isArray(batch.assignedCheckIds),'Invalid batch check assignments.');assignments.push(...batch.assignedCheckIds);
    check(Array.isArray(batch.itemHashes) && batch.itemHashes.length<=30 && batch.itemHashes.every(hash=>HEX.test(hash)),'Invalid batch evidence manifest.');
  }
  check(sameIds([...assignments].sort(),frozen.checklist.map(c=>c.checkId).sort()),'Each frozen check must be assigned exactly once across the packet set.');
  const plan=packet.batchManifest[packet.batchIndex-1];
  check(['batchId','packetId','reportId'].every(key=>plan[key]===packet[key]) && sameValue(plan.assignedCheckIds,packet.assignedCheckIds),'The batch does not match its set manifest.');
  check(Array.isArray(packet.items) && fits(packet.items),'The batch exceeds the evidence limits.');
  const items=packet.items.map((item,index)=>{
    keys(item,['itemId','documentId','versionId','category','anchor','text','provenance']);
    check(item.itemId==='E'+(index+1),'Invalid evidence item sequence.');
    const result=v3Items(context,[item])[0];
    check(result.category===item.category,'Evidence category does not match its document.');
    return result;
  });
  check(sameValue(await Promise.all(items.map(item=>v3Digest(item))),plan.itemHashes),'Batch evidence differs from its frozen manifest.');
  check(Array.isArray(packet.evidenceCoverage) && packet.evidenceCoverage.length===context.documents.length,'Evidence coverage must describe the entire frozen inventory.');
  for(const [index,row] of packet.evidenceCoverage.entries()) {
    keys(row,['documentId','versionId','status','methods']);const doc=context.documents[index];
    check(row.documentId===doc.id && row.versionId===(doc.version?.id??null) && ['provided','not_supplied','not_applicable'].includes(row.status) && Array.isArray(row.methods) && sameValue(row.methods,['extracted','manual'].filter(method=>row.methods.includes(method))),'Invalid inventory evidence coverage.');
    check((row.status==='provided')===Boolean(row.methods.length) && (row.status!=='provided' || doc.version) && (row.status!=='not_applicable' || doc.requirement==='Not applicable'),'Evidence coverage has an unsupported claim.');
    for(const item of items.filter(item=>item.documentId===doc.id)) check(row.status==='provided' && row.methods.includes(item.provenance.method),'The selected evidence contradicts its coverage record.');
  }
  check(HEX.test(packet.manifestDigest) && await v3Digest(manifestBody(packet))===packet.manifestDigest,'The packet-set manifest has changed.');
  const assigned=frozen.checklist.filter(c=>packet.assignedCheckIds.includes(c.checkId));
  check(sameValue(packet.requiredFollowups,v3Followups(context,withIds(items),assigned,packet.batchIndex===1,packet.evidenceCoverage)),'The batch required follow-ups do not match this frozen round.');
  const body=bodyWithoutDigest({...packet,items:withIds(items),...frozen});
  check(HEX.test(packet.digest) && await v3Digest(body)===packet.digest,'The packet contents or digest have changed.');
  const receipts=(context.packets??[]).filter(p=>p.packetSetId===packet.packetSetId);
  check(receipts.length===packet.batchCount && packet.batchManifest.every((batch,index)=>receipts.some(r=>r.packetId===batch.packetId && r.reportId===batch.reportId && r.batchId===batch.batchId && r.batchIndex===index+1 && r.batchCount===packet.batchCount && r.manifestDigest===packet.manifestDigest && sameValue(r.assignedCheckIds,batch.assignedCheckIds))),'This packet set was not completely registered in the selected round.');
  check(receipts.some(p=>p.packetId===packet.packetId && p.digest===packet.digest),'This packet was not registered in the selected round.');
  return {...body,digest:packet.digest};
}

function verifyV3Report(packet,report) {
  bounded(report);
  const extra=['packetSetId','batchId','batchIndex','batchCount','manifestDigest','checkResults'];
  keys(report,['format','reviewerRelease','proposalId','roundId','packetId','reportId','digest','coverage','findings',...extra]);
  check(report.format==='juliet.findings.v3' && extra.filter(k=>k!=='checkResults').every(key=>report[key]===packet[key]),'The report does not match this packet set and batch.');
  // Reuse the unchanged v2 citation/follow-up validation, preserving old readers.
  const legacy={format:'juliet.findings.v2',...Object.fromEntries(['reviewerRelease','proposalId','roundId','packetId','reportId','digest','coverage','findings'].map(key=>[key,report[key]]))};
  const result=verifyReport({...packet,format:'juliet.packet.v2'},legacy);
  check(Array.isArray(report.checkResults) && sameIds(report.checkResults.map(c=>c.checkId).sort(),[...packet.assignedCheckIds].sort()),'Return every assigned checklist check exactly once.');
  function citations(refs,guidance) {
    check(Array.isArray(refs) && refs.length<=6,'A check can cite up to six excerpts per evidence field.');
    return refs.map(ref=>{
      keys(ref,['itemId','quote']);const item=packet.items.find(i=>i.itemId===ref.itemId);
      check(item && result.coverage.reviewed.includes(item.itemId) && string(ref.quote,300) && item.text.includes(ref.quote),'A checklist citation is absent, unreviewed or its quotation does not match.');
      check(!guidance || GUIDANCE.includes(item.category),'A rule citation must reference supplied guidance.');
      return {itemId:ref.itemId,quote:ref.quote};
    });
  }
  const checkResults=report.checkResults.map(row=>{
    keys(row,['checkId','status','message','evidence','guidance','findingRefs']);
    const entry=packet.checklist.find(c=>c.checkId===row.checkId);
    check(CHECK_RESULTS.some(([status])=>status===row.status) && string(row.message,1000),'Invalid checklist outcome.');
    const evidence=citations(row.evidence,false),guidance=citations(row.guidance,true);
    check(evidence.every(ref=>entry.documentIds.includes(packet.items.find(i=>i.itemId===ref.itemId).documentId)) && guidance.every(ref=>entry.sourceDocumentIds.includes(packet.items.find(i=>i.itemId===ref.itemId).documentId)),'A check cites evidence outside its declared dependencies.');
    check(Array.isArray(row.findingRefs) && row.findingRefs.length<=120 && new Set(row.findingRefs).size===row.findingRefs.length,'Invalid checklist finding links.');
    const findingIds=row.findingRefs.map(ref=>{
      check(typeof ref==='string' && /^F[1-9][0-9]{0,2}$/.test(ref),'Use report-local finding references such as F1.');
      const finding=result.findings[Number(ref.slice(1))-1];check(finding,'A checklist finding reference is foreign.');return finding.id;
    });
    if(packet.heldCheckIds.includes(entry.checkId)) check(row.status==='unchecked','A held check must remain unchecked in this frozen batch.');
    if(row.status==='checked') {
      check(!['unknown','not_applicable'].includes(entry.applicability) && evidence.length>0,'A checked result requires known applicability and cited proposal evidence.');
      for(const id of entry.documentIds) check(evidence.some(ref=>packet.items.find(i=>i.itemId===ref.itemId).documentId===id),'A checked result omits a required document dependency.');
      for(const id of entry.sourceDocumentIds) check(guidance.some(ref=>packet.items.find(i=>i.itemId===ref.itemId).documentId===id),'A checked result omits required guidance.');
      check(!entry.sourceDocumentIds.length || packet.reviewContext.guidanceStatus==='provided','Missing or conflicting guidance cannot yield a checked source-dependent result.');
    }
    if(row.status==='not_applicable') check(entry.applicability==='not_applicable' && entry.basis,'Not applicable requires Lynn’s frozen applicability decision and basis.');
    if(['missing','unchecked','decision_needed'].includes(row.status)) check(findingIds.some(id=>result.findings.some(f=>f.id===id && ['question','coverage_gap'].includes(f.type))),'An incomplete checklist result must link its question or coverage gap.');
    return {checkId:row.checkId,status:row.status,message:row.message,evidence,guidance,findingIds};
  });
  return {...result,format:'juliet.findings.v3',reviewerRelease:RELEASE,
    ...Object.fromEntries(extra.filter(k=>k!=='checkResults').map(key=>[key,packet[key]])),
    assignedCheckIds:[...packet.assignedCheckIds],checkResults,
    evidenceProvenance:packet.items.map(item=>({itemId:item.itemId,...item.provenance}))};
}
