import {normalizeReviewContext, normalizePriorFindings, requiredFollowups, GUIDANCE} from './review-context.js';
// The digest binds the selected excerpt text and its provenance. It is not a signature.
export const RELEASE = '0.2.0';
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
  check(UUID.test(body.packetId) && UUID.test(body.reportId) && ['0.1.0', RELEASE].includes(body.reviewerRelease),
    'Unknown reviewer release or invalid packet identity.');
}
// Reconstruct fields in a fixed order so JSON formatting and input property order do not affect the digest.
function packetBody(context, packet) {
  header(context, packet);
  const legacy=packet.format==='juliet.packet.v1' && packet.reviewerRelease==='0.1.0';
  check((legacy || (packet.format==='juliet.packet.v2' && packet.reviewerRelease===RELEASE)) && packet.material === 'fictional-excerpts',
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
  const body = packetBody(context, {format:'juliet.packet.v2', material:'fictional-excerpts', reviewerRelease:RELEASE,
    proposalId:context.proposalId, roundId:context.roundId, packetId:crypto.randomUUID(), reportId:crypto.randomUUID(),
    reviewContext, inventory, priorFindings, requiredFollowups:requiredFollowups(reviewContext,context.documents,items,priorFindings), items});
  return {...body, digest:await digest(body)};
}
export async function verifyPacket(context, packet) {
  keys(packet, ['format','material','reviewerRelease','proposalId','roundId','packetId','reportId',...(packet.format==='juliet.packet.v2' ? ['reviewContext','inventory','priorFindings','requiredFollowups'] : []),'items','digest']);
  const body = packetBody(context, packet);
  check(HEX.test(packet.digest) && await digest(body) === packet.digest, 'The packet contents or digest have changed.');
  check(context.packets.some(p => p.packetId === body.packetId && p.digest === packet.digest),
    'This packet was not registered in the selected round.');
  return {...body, digest:packet.digest};
}
export function verifyReport(packet, report) {
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
