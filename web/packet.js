// The digest binds the selected excerpt text and its provenance. It is not a signature.
export const RELEASE = '0.1.0';
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
function header(context, body) {
  check(UUID.test(body.proposalId) && UUID.test(body.roundId) && context.proposalId === body.proposalId &&
    context.roundId === body.roundId, 'This file belongs to another proposal or review round.');
  check(UUID.test(body.packetId) && UUID.test(body.reportId) && body.reviewerRelease === RELEASE,
    'Unknown reviewer release or invalid packet identity.');
}
// Reconstruct fields in a fixed order so JSON formatting and input property order do not affect the digest.
function packetBody(context, packet) {
  header(context, packet);
  check(packet.format === 'juliet.packet.v1' && packet.material === 'fictional-excerpts',
    'Only fictional excerpt packets are supported by this release.');
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
  return {format:'juliet.packet.v1', material:'fictional-excerpts', reviewerRelease:RELEASE,
    proposalId:packet.proposalId, roundId:packet.roundId, packetId:packet.packetId, reportId:packet.reportId, items};
}
async function digest(body) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2,'0')).join('');
}
export async function sealPacket(context, excerpts) {
  const items = excerpts.map(({documentId, anchor, text}, index) => {
    const doc = context.documents.find(d => d.id === documentId);
    check(doc?.version, 'Choose a versioned document from this review round.');
    return {itemId:'E' + (index+1), documentId, versionId:doc.version.id, category:doc.category,
      anchor:anchor.trim(), text:text.trim()};
  });
  const body = packetBody(context, {format:'juliet.packet.v1', material:'fictional-excerpts', reviewerRelease:RELEASE,
    proposalId:context.proposalId, roundId:context.roundId, packetId:crypto.randomUUID(), reportId:crypto.randomUUID(), items});
  return {...body, digest:await digest(body)};
}
export async function verifyPacket(context, packet) {
  keys(packet, ['format','material','reviewerRelease','proposalId','roundId','packetId','reportId','items','digest']);
  const body = packetBody(context, packet);
  check(HEX.test(packet.digest) && await digest(body) === packet.digest, 'The packet contents or digest have changed.');
  check(context.packets.some(p => p.packetId === body.packetId && p.digest === packet.digest),
    'This packet was not registered in the selected round.');
  return {...body, digest:packet.digest};
}
export function verifyReport(packet, report) {
  keys(report, ['format','reviewerRelease','proposalId','roundId','packetId','reportId','digest','coverage','findings']);
  header(packet, report);
  check(report.format === 'juliet.findings.v1' && report.packetId === packet.packetId &&
    report.digest === packet.digest && report.reportId === packet.reportId, 'The report does not match this sealed packet.');
  keys(report.coverage, ['reviewed','unreviewed']);
  const {reviewed, unreviewed} = report.coverage;
  check(Array.isArray(reviewed) && Array.isArray(unreviewed) &&
    sameIds([...reviewed, ...unreviewed].sort(), packet.items.map(i => i.itemId).sort()),
    'Coverage must list each packet excerpt exactly once.');
  check(Array.isArray(report.findings) && report.findings.length <= 30, 'Return at most thirty findings.');
  function citations(refs, role) {
    check(Array.isArray(refs) && refs.length <= 6, 'A finding can cite up to six excerpts per evidence field.');
    return refs.map(ref => {
      keys(ref, ['itemId','quote']);
      const item = packet.items.find(i => i.itemId === ref.itemId);
      check(item && reviewed.includes(item.itemId) && string(ref.quote, 300) && item.text.includes(ref.quote),
        'A citation is missing from its reviewed excerpt or the quotation does not match.');
      if (role === 'guidance') check(item.category === 'Opportunity guidance', 'A rule citation must reference supplied guidance.');
      return {itemId:ref.itemId, quote:ref.quote};
    });
  }
  const findings = report.findings.map(finding => {
    keys(finding, ['type','message','evidence','guidance']);
    check(kinds.includes(finding.type) && string(finding.message, 1000), 'Unknown finding type or invalid message.');
    const evidence = citations(finding.evidence, 'evidence');
    const guidance = citations(finding.guidance, 'guidance');
    if (['objective_error','suggestion'].includes(finding.type)) {
      check(evidence.some(ref => packet.items.find(item => item.itemId === ref.itemId).category !== 'Opportunity guidance'),
        'Corrections and suggestions must cite proposal evidence.');
    }
    if (finding.type === 'objective_error') {
      const locations = new Set(evidence.map(ref => packet.items.find(item => item.itemId === ref.itemId))
        .filter(item => item.category !== 'Opportunity guidance')
        .map(item => JSON.stringify([item.documentId, item.versionId, item.anchor.trim().toLowerCase().replace(/\s+/g, ' ')])));
      check(guidance.length || locations.size >= 2,
        'An objective error requires cited guidance or two distinct proposal locations.');
    }
    return {type:finding.type, message:finding.message, evidence, guidance};
  });
  check(!unreviewed.length || findings.some(f => f.type === 'coverage_gap'), 'Describe any unreviewed excerpts as a coverage gap.');
  const locations = packet.items.map(({itemId, documentId, versionId, anchor}) => ({itemId, documentId, versionId, anchor}));
  return {packetId:packet.packetId, digest:packet.digest, reportId:report.reportId, locations,
    coverage:{reviewed:[...reviewed], unreviewed:[...unreviewed]}, findings};
}
