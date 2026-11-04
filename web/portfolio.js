// Directory handles and the active selection live only in this tab. Each journal
// entry has a unique filename so a stale or interrupted writer cannot replace history.
import {normalizeReviewContext, normalizePriorFindings, normalizeFollowups, REVIEW_OPTIONS, CHECKS} from './review-context.js';
import {normalizeChecklist} from './checklist.js';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ENTRY = new RegExp(`^(${UUID.source.slice(1, -1)})_(${UUID.source.slice(1, -1)})\\.json$`);
const STATUSES = ['Not set', 'Drafting', 'In review', 'Ready for submission', 'Submitted', 'Withdrawn'];
const CATEGORIES = ['Narrative', 'Budget', 'Budget justification', 'Personnel', 'Facilities', 'Subaward', 'Opportunity guidance', 'Institutional guidance', 'Validation report', 'Other attachment'];
const REQUIREMENTS = ['Required', 'Optional', 'Applicability unknown', 'Not applicable'];
const DISPOSITIONS = ['Open', 'Accepted', 'Declined', 'Deferred', 'Corrected', 'Verified'];
const LEGACY_DISPOSITIONS = [...DISPOSITIONS, 'Resolved'];
const FINDING_TYPES = ['objective_error', 'question', 'suggestion', 'coverage_gap'];
const MAX_ENTRY = 8 * 1024 * 1024;
const FOLDER = 'Juliet Portfolio';
const LOCK = 'juliet-portfolio-journal-v1';
const uuid = () => crypto.randomUUID();
const HEX = /^[a-f0-9]{64}$/;

export function activeVersion(doc) {
  return doc.activeVersionId === undefined ? doc.versions.at(-1) ?? null : doc.versions.find(v => v.id === doc.activeVersionId) ?? null;
}
function inventorySnapshot(proposal) {
  return proposal.documents.map(doc => ({id:doc.id,name:doc.name,category:doc.category,requirement:doc.requirement,source:doc.source,version:activeVersion(doc)}));
}
function manifest(proposal) {
  return {documents:inventorySnapshot(proposal),checklist:structuredClone(proposal.checklist ?? [])};
}
function same(a,b) { return JSON.stringify(a) === JSON.stringify(b); }
export function activeHolds(proposal) { return (proposal.holds ?? []).filter(h => !(proposal.holdClears ?? []).some(c => c.holdId === h.id)); }
export function needsRecheck(proposal, finding) {
  const review = [...proposal.reviews].reverse().find(r => r.reportId && !proposal.reports.find(p => p.reportId === r.reportId)?.historical && findingId(proposal.reports.find(p => p.reportId === r.reportId),r.index) === finding);
  if (review?.disposition !== 'Verified') return false;
  if(review.dependencies) {
    const docs=new Set(review.dependencies.documents.map(d=>d.id)), checks=new Set(review.dependencies.checklist.map(c=>c.checkId));
    return !same(review.dependencies,{documents:inventorySnapshot(proposal).filter(d=>docs.has(d.id)),checklist:proposal.checklist.filter(c=>checks.has(c.checkId))});
  }
  if (review.manifest) return !same(review.manifest,manifest(proposal));
  // Older verification records have no dependency set. Conservatively recheck after any active source change.
  const round = proposal.rounds.find(r => r.id === review.roundId);
  return !same(round.documents,inventorySnapshot(proposal));
}
export function currentCloseout(proposal) {
  const closeout = proposal.closeouts?.at(-1);
  if (!closeout || activeHolds(proposal).length || closeout.roundId !== proposal.rounds.at(-1)?.id || !same(closeout.manifest,manifest(proposal))) return null;
  if (!same(closeout.reportIds,proposal.reports.filter(r => !r.historical).map(r => r.reportId)) || !same(closeout.reviewIds,proposal.reviews.map(r => r.id))) return null;
  return closeout;
}
function packetReceipt(data, round, at) {
  requireValue(UUID.test(data.packetId) && HEX.test(data.digest),'Invalid packet identity or fingerprint.');
  const row={roundId:round.id,packetId:data.packetId,digest:data.digest,at};
  if(data.packetSetId !== undefined) {
    requireValue(round.workflowVersion === 3 && data.format === 'juliet.packet.v3' && data.reviewerRelease === '1.0.0','A v3 packet requires a v1 review round.');
    requireValue(UUID.test(data.packetSetId) && UUID.test(data.batchId) && HEX.test(data.manifestDigest) && Number.isInteger(data.batchIndex) && Number.isInteger(data.batchCount) && data.batchIndex > 0 && data.batchIndex <= data.batchCount && data.batchCount <= 300,'Invalid packet batch identity.');
    requireValue(Array.isArray(data.assignedCheckIds) && new Set(data.assignedCheckIds).size === data.assignedCheckIds.length && data.assignedCheckIds.every(id=>round.checklist.some(c=>c.checkId===id)),'Invalid assigned checklist checks.');
    requireValue(UUID.test(data.reportId),'Invalid expected report identity.');
    Object.assign(row,Object.fromEntries(['format','reviewerRelease','reportId','packetSetId','batchId','batchIndex','batchCount','manifestDigest','assignedCheckIds'].map(k=>[k,structuredClone(data[k])])));
  }
  return row;
}
function checkResults(round, packet, data, report) {
  requireValue(data.format === 'juliet.findings.v3' && data.reviewerRelease === '1.0.0','Invalid v3 report release.');
  for(const key of ['packetSetId','batchId','batchIndex','batchCount','manifestDigest','assignedCheckIds']) requireValue(same(data[key],packet[key]),'The report batch does not match its registered packet.');
  requireValue(Array.isArray(data.checkResults) && data.checkResults.length === packet.assignedCheckIds.length,'Each assigned checklist check needs a result.');
  const seen=new Set();
  const result=data.checkResults.map(row=>{
    requireValue(packet.assignedCheckIds.includes(row.checkId) && !seen.has(row.checkId),'Foreign or duplicate checklist result.');seen.add(row.checkId);
    const check=round.checklist.find(c=>c.checkId===row.checkId);
    const status=choice(row.status,['checked','missing','unchecked','decision_needed','not_applicable'],'check result');
    requireValue(Array.isArray(row.findingIds) && new Set(row.findingIds).size === row.findingIds.length && row.findingIds.every(id=>report.findings.some((f,i)=>findingId(report,i)===id)),'A checklist result links a foreign finding.');
    const evidence=citations(row.evidence),guidance=citations(row.guidance);
    for(const [refs,ids] of [[evidence,check.documentIds],[guidance,check.sourceDocumentIds]])for(const ref of refs)requireValue(report.coverage.reviewed.includes(ref.itemId) && report.locations?.some(l=>l.itemId===ref.itemId && ids.includes(l.documentId)),'A check citation is outside its reviewed dependency locations.');
    if(status==='checked') {
      requireValue(!['unknown','not_applicable'].includes(check.applicability) && evidence.length,'A checked result requires supported applicability and evidence.');
      for(const [refs,ids] of [[evidence,check.documentIds],[guidance,check.sourceDocumentIds]])for(const id of ids)requireValue(refs.some(ref=>report.locations.some(l=>l.itemId===ref.itemId && l.documentId===id)),'A checked result omits a declared dependency.');
      requireValue(!check.sourceDocumentIds.length || round.reviewContext.guidanceStatus==='provided','Missing or conflicting guidance cannot support a checked result.');
    }
    if(status==='not_applicable') requireValue(check.applicability==='not_applicable' && check.basis,'An inapplicable result needs the frozen applicability basis.');
    if(['missing','unchecked','decision_needed'].includes(status))requireValue(row.findingIds.length,'An incomplete check must link its unresolved finding.');
    if(round.heldCheckIds?.includes(check.checkId))requireValue(status==='unchecked','Held checks must remain unchecked.');
    return {checkId:row.checkId,status,message:limited(row.message,1000,'check result'),evidence,guidance,findingIds:[...row.findingIds]};
  });
  return {...Object.fromEntries(['format','reviewerRelease','packetSetId','batchId','batchIndex','batchCount','manifestDigest','assignedCheckIds'].map(k=>[k,structuredClone(data[k])])),checkResults:result};
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function limited(value, max, label, optional = false) {
  requireValue(typeof value === 'string' && value.length <= max && (optional || value.trim()), `Check ${label}.`);
  return value.trim();
}
function choice(value, options, label) {
  requireValue(options.includes(value), `Choose a valid ${label}.`);
  return value;
}
function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function deadline(value, zone) {
  if (!value && !zone) return ['', ''];
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) && dateOnly(value.slice(0, 10)), 'Enter a full local date and time for each deadline, or clear both fields.');
  zone = limited(zone, 80, 'deadline time zone');
  try { new Intl.DateTimeFormat('en', {timeZone: zone}); } catch { throw new Error('Enter a recognized time zone such as America/Chicago.'); }
  return [value, zone];
}
function details(input) {
  const [internalDue, internalZone] = deadline(input.internalDue, input.internalZone);
  const [sponsorDue, sponsorZone] = deadline(input.sponsorDue, input.sponsorZone);
  return {status: choice(input.status, STATUSES, 'status'), nextAction: limited(input.nextAction, 300, 'next action', true), internalDue, internalZone, sponsorDue, sponsorZone};
}
function citations(values) {
  requireValue(Array.isArray(values) && values.length <= 6, 'Invalid finding citations.');
  return values.map(ref => {
    requireValue(ref && typeof ref.itemId === 'string' && /^E[1-9][0-9]{0,5}$/.test(ref.itemId), 'Invalid evidence item ID.');
    limited(ref.quote, 300, 'cited quotation');
    return {itemId: ref.itemId, quote: ref.quote};
  });
}
function findings(values, round, reportId, followups) {
  const contextual = followups !== undefined;
  requireValue(Array.isArray(values) && values.length <= (contextual ? 120 : 30), 'Invalid report findings.');
  if (contextual) requireValue(round?.reviewContext, 'Contextual findings require a scoped review round.');
  const seen = new Set();
  const rows = values.map((row, index) => {
    const result = {type: choice(row.type, FINDING_TYPES, 'finding type'), message: limited(row.message, 1000, 'finding'), evidence: citations(row.evidence), guidance: citations(row.guidance)};
    if (!contextual) {
      requireValue(row.id === undefined && row.priorFindingId === undefined, 'Contextual findings require their follow-up record.');
      return result;
    }
    const prior = row.priorFindingId === null ? null : round.priorFindings.find(f => f.findingId === row.priorFindingId);
    requireValue(row.priorFindingId === null || prior, 'The prior finding is outside this proposal and round.');
    requireValue(row.id === (prior?.findingId ?? `${reportId}/F${index + 1}`) && !seen.has(row.id), 'Invalid, foreign or duplicated finding identity.');
    seen.add(row.id);
    requireValue(Array.isArray(row.gapIds) && new Set(row.gapIds).size === row.gapIds.length && row.gapIds.every(id => followups.some(gap => gap.id === id)), 'Invalid required follow-up reference.');
    requireValue(row.gapIds.every(id => {
      const gap = followups.find(g => g.id === id);
      return gap.priorFindingId === null || row.priorFindingId === gap.priorFindingId;
    }), 'A finding cannot claim another prior issue’s follow-up.');
    if (prior) requireValue(row.gapIds.some(id => followups.find(g => g.id === id)?.priorFindingId === prior.findingId), 'A carried finding must address its prior-issue follow-up.');
    return {...result, id: row.id, gapIds: [...row.gapIds], priorFindingId: row.priorFindingId,
      owner: limited(row.owner, 100, 'finding owner', true), nextAction: limited(row.nextAction, 300, 'finding next action'), calculation: limited(row.calculation, 500, 'calculation', true)};
  });
  if (contextual) for (const gap of followups) requireValue(rows.some(row => row.gapIds.includes(gap.id) && (gap.priorFindingId === null ? row.type === gap.type : row.priorFindingId === gap.priorFindingId)), 'A required follow-up is absent from the report.');
  return rows;
}
function followupsForRound(round, values) {
  requireValue(round?.reviewContext, 'Follow-ups require a scoped review round.');
  const rows = normalizeFollowups(values);
  for (const row of rows) {
    requireValue(row.documentId === null || round.documents.some(doc => doc.id === row.documentId), 'A follow-up refers to a foreign document.');
    requireValue(row.priorFindingId === null || round.priorFindings.some(f => f.findingId === row.priorFindingId), 'A follow-up refers to a foreign prior finding.');
  }
  return rows;
}
function findingId(report, index) { return report.findings[index].id ?? `${report.reportId}/F${index + 1}`; }
function latestDisposition(proposal, id) {
  for (const review of [...proposal.reviews].reverse()) {
    if (review.reportId === undefined) continue;
    const report = proposal.reports.find(r => r.reportId === review.reportId);
    if(report.historical) continue;
    if (findingId(report, review.index) === id) return review.disposition;
  }
  return 'Open';
}
export function unresolvedFindings(proposal, enforceLimit = true) {
  const latest = new Map();
  for (const report of proposal.reports.filter(r=>!r.historical)) report.findings.forEach((finding, index) => {
    const id = findingId(report, index), previous = latest.get(id);
    latest.set(id, {findingId: id, message: finding.message, type: finding.type,
      owner: finding.owner || previous?.owner || '', nextAction: finding.nextAction || previous?.nextAction || '', disposition: 'Open'});
  });
  for (const review of proposal.reviews) {
    if (review.reportId === undefined) continue;
    const report = proposal.reports.find(r => r.reportId === review.reportId);
    if(report.historical) continue;
    const row = latest.get(findingId(report, review.index));
    if (row) row.disposition = review.disposition;
  }
  for(const row of latest.values()) if(needsRecheck(proposal,row.findingId)) row.disposition='Needs recheck';
  const unresolved = [...latest.values()].filter(row => !['Declined', 'Rejected', 'Verified'].includes(row.disposition));
  return enforceLimit ? normalizePriorFindings(unresolved) : unresolved;
}
function verificationForRound(round, value) {
  requireValue(value && typeof value === 'object', 'Verified findings need a document version and location.');
  const doc = round.documents.find(d => d.id === value.documentId);
  requireValue(doc?.version && doc.version.id === value.versionId, 'Verification must cite a document version in this review round.');
  return {documentId: doc.id, versionId: doc.version.id, anchor: limited(value.anchor, 180, 'verification location')};
}
function coverage(value,allowEmpty=false) {
  const reviewed = value?.reviewed, unreviewed = value?.unreviewed;
  requireValue(Array.isArray(reviewed) && Array.isArray(unreviewed), 'Missing packet coverage.');
  const all = [...reviewed, ...unreviewed];
  requireValue((allowEmpty || all.length > 0) && all.length <= 30 && all.every(id => typeof id === 'string' && /^E[1-9][0-9]{0,5}$/.test(id)) && new Set(all).size === all.length, 'Invalid packet coverage.');
  return {reviewed, unreviewed};
}
function locations(round, covered, values) {
  requireValue(round && Array.isArray(values), 'Invalid report locations.');
  const ids = new Set([...covered.reviewed, ...covered.unreviewed]);
  requireValue(values.length === ids.size, 'Report locations must cover every packet item.');
  return values.map(ref => {
    requireValue(ref && ids.delete(ref.itemId), 'A report location is unknown or duplicated.');
    const doc = round.documents.find(d => d.id === ref.documentId);
    requireValue(doc?.version?.id && doc.version.id === ref.versionId, 'A source location does not match a document version in this round.');
    return {itemId: ref.itemId, documentId: doc.id, versionId: doc.version.id, anchor: limited(ref.anchor, 180, 'source location')};
  }).sort((a, b) => Number(a.itemId.slice(1)) - Number(b.itemId.slice(1)));
}
function apply(proposal, event) {
  const {proposalId, id, at, action, data} = event;
  requireValue(event.format === 1 && UUID.test(proposalId) && UUID.test(id) && typeof at === 'string' && Number.isFinite(Date.parse(at)) && data && typeof data === 'object', 'Invalid portfolio record.');
  requireValue(event.revision === (proposal?.revision ?? 0) + 1 && event.previous === (proposal?.head ?? null), 'Conflicting or incomplete portfolio history.');
  if (action === 'create') {
    requireValue(!proposal && typeof data.sponsor === 'string' && /^[A-Za-z][A-Za-z0-9]{0,19}$/.test(data.sponsor) && dateOnly(data.originalDate) && Number.isInteger(data.sequence) && data.sequence >= 1 && data.sequence <= 999, 'Check sponsor initials, original submission date and sequence.');
    const sponsor = data.sponsor.toUpperCase();
    const label = `${sponsor}-${data.originalDate}${data.sequence > 1 ? '-' + String(data.sequence).padStart(2, '0') : ''}`;
    proposal = {id: proposalId, sponsor, label, originalDate: data.originalDate, sequence: data.sequence, ...details(data), documents: [], rounds: [], reviews: [], packets: [], reports: [], checklist:[], holds:[], holdClears:[], closeouts:[]};
  } else {
    requireValue(proposal?.id === proposalId, 'Proposal identity does not match the selected record.');
    if (action === 'details') Object.assign(proposal, details(data));
    else if (action === 'requirement') {
      const category = choice(data.category, CATEGORIES, 'document category');
      const name = limited(data.name, 100, 'document label');
      const requirement = choice(data.requirement, REQUIREMENTS, 'requirement');
      const source = limited(data.source, 180, 'guidance reference', true);
      const existing = proposal.documents.find(doc => doc.id === data.documentId);
      if (existing) Object.assign(existing, {category, name, requirement, source});
      else {
        requireValue(data.documentId === id, 'This document belongs to a different proposal or no longer exists.');
        proposal.documents.push({id, category, name, requirement, source, versions: []});
      }
    } else if (action === 'version') {
      const doc = proposal.documents.find(item => item.id === data.documentId);
      requireValue(doc, 'Choose a document from this proposal.');
      const previous=activeVersion(doc);
      const version={id, number: doc.versions.length + 1, label: limited(data.label, 100, 'version label'), at};
      if(data.sha256 !== undefined) {
        requireValue(HEX.test(data.sha256) && Number.isInteger(data.size) && data.size>0 && data.size<=64*1024*1024,'Invalid source fingerprint or size.');
        Object.assign(version,{sha256:data.sha256,size:data.size,format:limited(data.format,20,'file format'),provenance:choice(data.provenance,['original','derivative','manual'],'source provenance')});
        requireValue(version.provenance!=='derivative' || doc.versions.some(v=>v.id===data.sourceVersionId),'A derivative must reference an existing source version of this document.');
        if(data.sourceVersionId !== undefined) {
          requireValue(version.provenance==='derivative' && doc.versions.some(v=>v.id===data.sourceVersionId),'A derivative must reference an existing version of this document.');
          version.sourceVersionId=data.sourceVersionId;
        }
        if(data.coverage !== undefined) {
          version.coverage=choice(data.coverage,['supported_text','partial','blocked'],'source extraction coverage');
          requireValue(Array.isArray(data.limitations) && data.limitations.length<=1000,'Too many source limitations.');
          version.limitations=data.limitations.map(row=>({location:limited(row.location,500,'limitation location',true),feature:limited(row.feature,200,'unsupported feature'),message:limited(row.message,1000,'source limitation')}));
        }
      }
      doc.versions.push(version);
      if(data.activate !== undefined) {
        requireValue(typeof data.activate==='boolean','Confirm active version selection.');
        doc.activeVersionId=data.activate?id:previous?.id ?? null;
      } else if(doc.activeVersionId !== undefined) doc.activeVersionId=previous?.id ?? null;
    } else if(action === 'active_version') {
      const doc=proposal.documents.find(d=>d.id===data.documentId);
      requireValue(doc && (data.versionId===null || doc.versions.some(v=>v.id===data.versionId)),'Choose a version from this document.');
      doc.activeVersionId=data.versionId;
    } else if(action === 'check') {
      const check=normalizeChecklist([{...data,checkId:data.checkId || id}],inventorySnapshot(proposal))[0];
      const existing=proposal.checklist.findIndex(c=>c.checkId===check.checkId);
      requireValue(existing>=0 || check.checkId===id,'This checklist check belongs to another proposal.');
      if(existing>=0)proposal.checklist[existing]=check;else proposal.checklist.push(check);
    } else if(action === 'hold') {
      const round=proposal.rounds.find(r=>r.id===data.roundId);
      requireValue(round,'Choose a review round from this proposal.');
      const scope=choice(data.scope,['whole','checks'],'hold scope');
      requireValue(Array.isArray(data.checkIds) && new Set(data.checkIds).size===data.checkIds.length && (scope==='whole'?data.checkIds.length===0:data.checkIds.length>0 && data.checkIds.every(id=>round.checklist?.some(c=>c.checkId===id))),'Select the affected frozen checklist checks.');
      proposal.holds.push({id,at,roundId:round.id,scope,checkIds:[...data.checkIds],reason:limited(data.reason,500,'hold reason'),owner:limited(data.owner,100,'hold owner'),nextAction:limited(data.nextAction,300,'hold next action')});
    } else if(action === 'hold_clear') {
      requireValue(activeHolds(proposal).some(h=>h.id===data.holdId),'Choose an active hold from this proposal.');
      proposal.holdClears.push({id,at,holdId:data.holdId,reason:limited(data.reason,500,'hold resolution and evidence')});
    } else if (action === 'round') {
      requireValue(proposal.documents.length, 'Add a document requirement before recording a round.');
      const round = {id, number: proposal.rounds.length + 1, at, label: limited(data.label, 100, 'round label'), documents: inventorySnapshot(proposal)};
      if (data.reviewContext !== undefined) {
        requireValue(data.activeVersionsConfirmed === true, 'Confirm that the listed latest versions are active for this round.');
        round.reviewContext = normalizeReviewContext(data.reviewContext);
        round.priorFindings = unresolvedFindings(proposal);
        round.activeVersionsConfirmed = true;
      }
      if(data.workflowVersion===3) {
        requireValue(round.reviewContext && proposal.checklist.length && data.checklistConfirmed===true,'Confirm the proposal checklist before freezing a v1 round.');
        round.reviewContext=normalizeReviewContext(data.reviewContext,{reviewOnly:true});
        round.workflowVersion=3;
        round.checklist=normalizeChecklist(proposal.checklist,round.documents);
        round.heldCheckIds=activeHolds(proposal).flatMap(h=>h.checkIds).filter((id,i,ids)=>ids.indexOf(id)===i);
      }
      proposal.rounds.push(round);
    } else if (action === 'review') {
      const round = proposal.rounds.find(round => round.id === data.roundId);
      requireValue(round, 'Choose a review round from this proposal.');
      const review = {id, at, roundId: data.roundId, disposition: choice(data.disposition, LEGACY_DISPOSITIONS, 'disposition'), note: limited(data.note, 500, 'review note')};
      if (data.reportId !== undefined) {
        const report = proposal.reports.find(r => r.reportId === data.reportId && r.roundId === data.roundId);
        requireValue(Number.isInteger(data.index) && report?.findings[data.index], 'Choose a finding from this review round.');
        Object.assign(review, {reportId: data.reportId, index: data.index});
        if (data.disposition === 'Verified') {
          review.verification = verificationForRound(round, data.verification);
          const document=proposal.documents.find(doc => doc.id === review.verification.documentId);
          const latest = document && activeVersion(document);
          const id = findingId(report, data.index);
          const latestReport = proposal.reports.findLast(r => !r.historical && r.findings.some((_, index) => findingId(r, index) === id));
          requireValue(!report.historical && latest?.id === review.verification.versionId && latestReport === report,
            'This finding or document has a newer version. Review the current round before verifying it.');
          if(round.workflowVersion===3 && data.captureManifest===true) {
            const checks=new Set((report.checkResults ?? []).filter(c=>c.findingIds.includes(id)).map(c=>c.checkId));
            if(checks.size) {
              const checklist=round.checklist.filter(c=>checks.has(c.checkId));
              const docs=new Set([review.verification.documentId,...checklist.flatMap(c=>[...c.documentIds,...c.sourceDocumentIds])]);
              const frozen={documents:round.documents.filter(d=>docs.has(d.id)),checklist};
              const active={documents:inventorySnapshot(proposal).filter(d=>docs.has(d.id)),checklist:proposal.checklist.filter(c=>checks.has(c.checkId))};
              requireValue(same(frozen,active),'A verification dependency changed after this round was frozen. Review the current evidence in a new round before verifying it.');
              review.dependencies=structuredClone(frozen);
            } else {
              requireValue(same(round.documents,inventorySnapshot(proposal)) && same(round.checklist,proposal.checklist),'The review evidence changed after this round was frozen. Record a current round before verifying it.');
            }
          }
          if(data.captureManifest===true) review.manifest=manifest(proposal);
        }
        else requireValue(data.verification === undefined, 'Verification evidence belongs to a Verified finding decision.');
      } else {
        requireValue(data.disposition !== 'Verified' && data.verification === undefined, 'Verify an individual finding with its document evidence.');
      }
      proposal.reviews.push(review);
    } else if(action==='closeout') {
      const round=proposal.rounds.at(-1);
      requireValue(round?.id===data.roundId && round.workflowVersion===3,'Closeout requires the current v1 round.');
      requireValue(!activeHolds(proposal).length,'Clear each active hold before recording closeout.');
      requireValue(same(round.documents,inventorySnapshot(proposal)) && same(round.checklist,proposal.checklist),'Active evidence or checks changed. Record a current round before closeout.');
      requireValue(Array.isArray(data.correctedFiles) && data.correctedFiles.every(ref=>round.documents.some(d=>d.id===ref.documentId && d.version?.id===ref.versionId)),'Corrected-file checks must refer to active versions.');
      requireValue(new Set(data.correctedFiles.map(r=>r.documentId)).size===data.correctedFiles.length && !(data.noCorrectionsRequired===true && data.correctedFiles.length),'Choose inspected corrected files or no corrections required, not both.');
      requireValue(data.noCorrectionsRequired===true || data.correctedFiles.length>0,'Confirm the corrected active files you inspected, or explicitly record no corrections required.');
      const currentReports=proposal.reports.filter(r=>!r.historical && r.roundId===round.id);
      const expected=proposal.packets.filter(p=>p.roundId===round.id && p.packetSetId);
      requireValue(expected.length>0 && expected.every(p=>currentReports.some(r=>r.reportId===p.reportId && r.packetId===p.packetId && r.packetSetId===p.packetSetId)),'Return every registered packet batch before closeout.');
      requireValue(round.checklist.every(c=>currentReports.some(r=>r.checkResults?.some(result=>result.checkId===c.checkId))),'Complete the checklist results before closeout; missing batches remain incomplete.');
      const decisions=new Map();
      for(const review of proposal.reviews) {
        const report=proposal.reports.find(r=>r.reportId===review.reportId);
        if(report && !report.historical) decisions.set(findingId(report,review.index),{review,report});
      }
      const corrections=[...decisions.values()].filter(({review})=>['Corrected','Verified'].includes(review.disposition));
      requireValue(!corrections.length || !data.noCorrectionsRequired,'Recorded corrections or verification decisions require corrected-file inspection acknowledgment.');
      for(const {review,report} of corrections) {
        const finding=report.findings[review.index], ids=new Set([review.verification?.documentId,...finding.evidence.map(ref=>report.locations?.find(l=>l.itemId===ref.itemId)?.documentId)].filter(Boolean));
        for(const docId of ids)requireValue(data.correctedFiles.some(ref=>ref.documentId===docId),'A corrected or verified finding still needs acknowledgment of its active document.');
      }
      const remaining=unresolvedFindings(proposal,false);
      requireValue(Array.isArray(data.remaining) && data.remaining.length===remaining.length && new Set(data.remaining.map(r=>r.findingId)).size===remaining.length && data.remaining.every(row=>remaining.some(f=>f.findingId===row.findingId)),'Record the routing impact of every remaining finding.');
      proposal.closeouts.push({id,at,roundId:round.id,manifest:manifest(proposal),reportIds:proposal.reports.filter(r=>!r.historical).map(r=>r.reportId),reviewIds:proposal.reviews.map(r=>r.id),correctedFiles:data.correctedFiles.map(({documentId,versionId})=>({documentId,versionId})),noCorrectionsRequired:data.noCorrectionsRequired===true,remaining:data.remaining.map(row=>({findingId:row.findingId,owner:limited(row.owner,100,'remaining issue owner'),impact:limited(row.impact,500,'remaining issue routing impact')})),readyForRouting:data.readyForRouting===true,reason:limited(data.reason,500,'closeout reason'),nextAction:limited(data.nextAction,300,'closeout next action')});
    } else if(action==='packet_set') {
      const round=proposal.rounds.find(r=>r.id===data.roundId);
      requireValue(round?.workflowVersion===3 && !activeHolds(proposal).some(h=>h.scope==='whole'),'Clear the whole-review hold before sealing packets.');
      requireValue(!proposal.packets.some(p=>p.roundId===round.id && p.packetSetId),'This round already has a sealed packet set. Use its saved packets or record a new round for another selection.');
      const held=activeHolds(proposal).flatMap(h=>h.checkIds).filter(id=>round.checklist.some(c=>c.checkId===id));
      requireValue(same([...new Set(held)].sort(),[...(round.heldCheckIds ?? [])].sort()),'The scoped holds changed. Freeze a new round so its packets preserve the correct held checks.');
      requireValue(same(round.documents,inventorySnapshot(proposal)) && same(round.checklist,proposal.checklist),'Active evidence or checks changed. Record a current round before sealing packets.');
      requireValue(Array.isArray(data.packets) && data.packets.length>0 && data.packets.length<=300,'Invalid packet set.');
      const rows=data.packets.map(p=>packetReceipt(p,round,at)), first=rows[0];
      requireValue(rows.every((p,i)=>p.packetSetId===first.packetSetId && p.manifestDigest===first.manifestDigest && p.batchCount===rows.length && p.batchIndex===i+1),'The packet set is incomplete or inconsistent.');
      requireValue(new Set(rows.map(p=>p.packetId)).size===rows.length && new Set(rows.map(p=>p.batchId)).size===rows.length && new Set(rows.map(p=>p.reportId)).size===rows.length && rows.every(p=>!proposal.packets.some(old=>old.packetId===p.packetId || old.packetSetId===p.packetSetId || old.reportId===p.reportId)),'A packet set identity is duplicated.');
      const assigned=rows.flatMap(p=>p.assignedCheckIds);
      requireValue(assigned.length===round.checklist.length && new Set(assigned).size===assigned.length && assigned.every(id=>round.checklist.some(c=>c.checkId===id)),'Packet batches must assign each frozen checklist check exactly once.');
      proposal.packets.push(...rows);
    } else if (action === 'packet' || action === 'report') {
      requireValue(proposal.rounds.some(round => round.id === data.roundId), 'Choose a review round from this proposal.');
      requireValue(typeof data.packetId === 'string' && UUID.test(data.packetId) && typeof data.digest === 'string' && /^[a-f0-9]{64}$/.test(data.digest), 'Invalid packet identity or fingerprint.');
      const packet = proposal.packets.find(p => p.packetId === data.packetId);
      if (action === 'packet') {
        requireValue(!activeHolds(proposal).some(h=>h.scope==='whole'),'Clear the whole-review hold before sealing packets.');
        requireValue(data.packetSetId===undefined,'Register v3 batches together as a complete packet set.');
        requireValue(!packet, 'Packet ID is already registered.');
        proposal.packets.push({roundId: data.roundId, packetId: data.packetId, digest: data.digest, at});
      } else {
        requireValue(packet?.roundId === data.roundId && packet.digest === data.digest, 'The packet does not match this proposal and round.');
        requireValue(typeof data.reportId === 'string' && UUID.test(data.reportId) && !proposal.reports.some(r => r.reportId === data.reportId), 'Invalid or reused report ID.');
        const round = proposal.rounds.find(r => r.id === data.roundId);
        const requiredFollowups = data.requiredFollowups === undefined ? undefined : followupsForRound(round, data.requiredFollowups);
        const report = {roundId: data.roundId, packetId: data.packetId, digest: data.digest, reportId: data.reportId, findings: findings(data.findings, round, data.reportId, requiredFollowups), coverage: coverage(data.coverage,Boolean(packet.packetSetId)), at};
        const closedCarry=report.findings.some(f=>f.priorFindingId && ['Declined','Rejected','Verified'].includes(latestDisposition(proposal,f.priorFindingId)) && !round.priorFindings.some(p=>p.findingId===f.priorFindingId && p.disposition==='Needs recheck'));
        if(data.historyMode===1) report.historical=round.id!==proposal.rounds.at(-1).id || !same(round.documents,inventorySnapshot(proposal)) || (round.workflowVersion===3 && !same(round.checklist,proposal.checklist)) || closedCarry;
        else requireValue(!closedCarry,'A prior finding was closed after this round was frozen. Record a current round before importing new evidence.');
        if (requiredFollowups !== undefined) report.requiredFollowups = requiredFollowups;
        if (data.locations !== undefined) report.locations = locations(round, report.coverage, data.locations);
        if(packet.packetSetId) {
          requireValue(data.reportId===packet.reportId,'The report does not match the registered expected report.');
          Object.assign(report,checkResults(round,packet,data,report));
          requireValue(Array.isArray(data.evidenceProvenance) && data.evidenceProvenance.length===report.locations?.length,'Missing evidence provenance.');
          const seen=new Set();
          report.evidenceProvenance=data.evidenceProvenance.map(row=>{requireValue(report.locations.some(l=>l.itemId===row.itemId) && !seen.has(row.itemId),'Invalid evidence provenance item.');seen.add(row.itemId);return {itemId:row.itemId,method:choice(row.method,['extracted','manual'],'evidence method'),note:limited(row.note,500,'evidence provenance note',true)};});
        }
        proposal.reports.push(report);
        if (requiredFollowups !== undefined) requireValue(unresolvedFindings(proposal, false).length <= 120,
          'This report would exceed 120 unresolved findings. Consolidate duplicate findings or record justified closure decisions before importing it.');
      }
    } else throw new Error('Unsupported portfolio record type.');
  }
  proposal.revision = event.revision;
  proposal.head = id;
  return proposal;
}

export async function openPortfolio(directory, locks = globalThis.navigator?.locks) {
  requireValue(locks?.request, 'This browser cannot safely coordinate portfolio edits. Use an approved browser with Web Locks support.');
  const folder = await directory.getDirectoryHandle(FOLDER, {create: true});
  async function list() {
    const histories = new Map();
    for await (const [filename, fileHandle] of folder.entries()) {
      const match = ENTRY.exec(filename);
      if (!match) {
        requireValue(!filename.toLowerCase().endsWith('.json'), 'Unrecognized portfolio record. Check the selected folder before editing.');
        continue;
      }
      try {
        const file = await fileHandle.getFile();
        requireValue(file.size <= MAX_ENTRY, 'Oversized entry');
        const record = JSON.parse(await file.text());
        requireValue(record.proposalId === match[1] && record.id === match[2], 'Record identity mismatch');
        if (!histories.has(match[1])) histories.set(match[1], []);
        histories.get(match[1]).push(record);
      } catch { throw new Error('A portfolio record is incomplete or has the wrong identity. Stop editing and reconcile this folder with an approved backup.'); }
    }
    const proposals = [...histories.values()].map(events => events.sort((a, b) => a.revision - b.revision).reduce(apply, null));
    requireValue(new Set(proposals.map(p => p.label)).size === proposals.length, 'Duplicate proposal labels in this folder. Reconcile the records before editing.');
    const packetIds = proposals.flatMap(p => p.packets.map(packet => packet.packetId));
    const reportIds = proposals.flatMap(p => p.reports.map(report => report.reportId));
    requireValue(new Set(packetIds).size === packetIds.length && new Set(reportIds).size === reportIds.length, 'A packet or report ID occurs across proposals. Reconcile this folder before editing.');
    return proposals.sort((a, b) => a.label.localeCompare(b.label));
  }
  async function commit(proposalId, expectedHead, action, fields, assertActive) {
    return locks.request(LOCK, async () => {
      const proposals = await list();
      const current = proposals.find(p => p.id === proposalId);
      assertActive?.();
      if(action==='packet_set' && current) {
        const existing=current.packets.filter(p=>p.packetSetId===fields.packets?.[0]?.packetSetId);
        if(existing.length) {
          const round=current.rounds.find(r=>r.id===fields.roundId);
          requireValue(round && existing.length===fields.packets.length && existing.every((p,i)=>same(p,packetReceipt(fields.packets[i],round,p.at))),'This packet set was already registered with different contents.');
          return current;
        }
      }
      if (action === 'packet' || action === 'report') {
        const isReport = action === 'report';
        const collection = isReport ? 'reports' : 'packets';
        const key = isReport ? 'reportId' : 'packetId';
        const owner = proposals.find(p => p[collection].some(entry => entry[key] === fields[key]));
        if (owner) {
          const existing = owner[collection].find(entry => entry[key] === fields[key]);
          requireValue(owner.id === proposalId && existing.roundId === fields.roundId && existing.packetId === fields.packetId && existing.digest === fields.digest, 'This packet or report ID belongs to another record.');
          if (isReport) {
            const round = owner.rounds.find(r => r.id === existing.roundId);
            const requiredFollowups = fields.requiredFollowups === undefined ? undefined : followupsForRound(round, fields.requiredFollowups);
            requireValue(JSON.stringify(existing.requiredFollowups) === JSON.stringify(requiredFollowups), 'This report ID was already used with different required follow-ups.');
            requireValue(JSON.stringify(existing.findings) === JSON.stringify(findings(fields.findings, round, fields.reportId, requiredFollowups)) && JSON.stringify(existing.coverage) === JSON.stringify(coverage(fields.coverage,Boolean(existing.packetSetId))), 'This report ID was already used with different findings or coverage.');
            if (fields.locations !== undefined) {
              const supplied = locations(owner.rounds.find(r => r.id === existing.roundId), existing.coverage, fields.locations);
              requireValue(!existing.locations || JSON.stringify(existing.locations) === JSON.stringify(supplied), 'This report ID was already used with different locations.');
            }
            if(existing.packetSetId) {
              const receipt=owner.packets.find(p=>p.packetId===existing.packetId);
              const normalized=checkResults(round,receipt,fields,existing);
              requireValue(Object.entries(normalized).every(([key,value])=>same(existing[key],value)) && same(existing.evidenceProvenance,fields.evidenceProvenance),'This report ID was already used with different checklist results or provenance.');
            }
          }
          return owner;  // Same import or registration is safe to retry.
        }
      }
      requireValue((current?.head ?? null) === expectedHead, 'This proposal changed in another view. Refresh the portfolio and review the latest record.');
      if((action==='create' || action==='details') && fields.status==='Ready for submission' && current?.status!=='Ready for submission') requireValue(currentCloseout(current ?? {})?.readyForRouting,'Record a current routing-ready closeout before changing status to Ready for submission.');
      const id = uuid();
      const detailFields = ['status', 'nextAction', 'internalDue', 'internalZone', 'sponsorDue', 'sponsorZone'];
      const allowed = {
        create: ['sponsor', 'originalDate', 'sequence', ...detailFields], details: detailFields,
        requirement: ['documentId', 'category', 'name', 'requirement', 'source'], version: ['documentId', 'label','sha256','size','format','provenance','sourceVersionId','activate','coverage','limitations'],
        active_version:['documentId','versionId'],
        check:['checkId','label','applicability','basis','sourceDocumentIds','documentIds','owner','nextAction'],
        hold:['roundId','scope','checkIds','reason','owner','nextAction'],hold_clear:['holdId','reason'],
        closeout:['roundId','correctedFiles','noCorrectionsRequired','remaining','readyForRouting','reason','nextAction'],
        round: ['label', 'reviewContext', 'activeVersionsConfirmed','workflowVersion','checklistConfirmed'], review: ['roundId', 'reportId', 'index', 'disposition', 'note', 'verification'],
        packet_set:['roundId','packets'],
        packet: ['roundId', 'packetId', 'digest'], report: ['roundId', 'packetId', 'digest', 'reportId','format','reviewerRelease','packetSetId','batchId','batchIndex','batchCount','manifestDigest','assignedCheckIds','checkResults','evidenceProvenance']
      };
      requireValue(Object.hasOwn(allowed, action), 'Unsupported portfolio action.');
      const data = Object.fromEntries(allowed[action].map(key => [key, fields[key]]));
      if (action === 'round' && fields.reviewContext !== undefined) data.reviewContext = normalizeReviewContext(fields.reviewContext);
      if (action === 'review' && fields.verification !== undefined) data.verification = verificationForRound(current?.rounds.find(r => r.id === data.roundId), fields.verification);
      if(action==='review' && fields.disposition==='Verified') data.captureManifest=true;
      if (action === 'report') {
        data.historyMode=1;
        const round = current?.rounds.find(r => r.id === data.roundId);
        if (fields.requiredFollowups !== undefined) data.requiredFollowups = followupsForRound(round, fields.requiredFollowups);
        data.findings = findings(fields.findings, round, data.reportId, data.requiredFollowups);
        const receipt=current?.packets.find(p=>p.packetId===data.packetId);
        data.coverage = coverage(fields.coverage,Boolean(receipt?.packetSetId));
        if (fields.locations !== undefined) data.locations = locations(current?.rounds.find(r => r.id === data.roundId), data.coverage, fields.locations);
        if(receipt?.packetSetId) {
          Object.assign(data,checkResults(round,receipt,fields,{...data,findings:data.findings}));
          requireValue(Array.isArray(fields.evidenceProvenance),'Missing evidence provenance.');
          data.evidenceProvenance=fields.evidenceProvenance.map(({itemId,method,note})=>({itemId,method,note}));
        }
      }
      if (action === 'requirement' && !data.documentId) data.documentId = id;
      if(action==='check' && !data.checkId) data.checkId=id;
      if(action==='check') Object.assign(data,normalizeChecklist([data],inventorySnapshot(current))[0]);
      if(action==='closeout') {
        requireValue(Array.isArray(data.correctedFiles) && Array.isArray(data.remaining),'Confirm corrected files and remaining issues.');
        data.correctedFiles=data.correctedFiles.map(({documentId,versionId})=>({documentId,versionId}));
        data.remaining=data.remaining.map(({findingId,owner,impact})=>({findingId,owner,impact}));
      }
      if(action==='version' && data.limitations !== undefined) {
        requireValue(Array.isArray(data.limitations),'Invalid source limitations.');
        data.limitations=data.limitations.map(({location,feature,message})=>({location,feature,message}));
      }
      if(action==='packet_set') {
        const round=current?.rounds.find(r=>r.id===data.roundId);
        requireValue(round && Array.isArray(data.packets),'Choose a review round and packet set.');
        data.packets=data.packets.map(p=>{const receipt=packetReceipt(p,round,'');delete receipt.at;delete receipt.roundId;return receipt;});
      }
      const event = {format: 1, proposalId, id, revision: (current?.revision ?? 0) + 1, previous: expectedHead, at: new Date().toISOString(), action, data};
      const updated = apply(current, event);
      if(action==='packet_set') {
        const others=proposals.filter(p=>p.id!==proposalId).flatMap(p=>p.packets);
        requireValue(data.packets.every(row=>!others.some(p=>p.packetId===row.packetId || p.packetSetId===row.packetSetId || p.reportId===row.reportId)),'A packet set belongs to another proposal.');
      }
      requireValue(!proposals.some(p => p.id !== proposalId && p.label === updated.label), 'That sponsor, date and sequence already identify a proposal. Choose another sequence.');
      const serialized = JSON.stringify(event);
      requireValue(new TextEncoder().encode(serialized).byteLength <= MAX_ENTRY,
        'This portfolio record exceeds 8 MiB. Narrow the report before saving; no journal entry was written.');
      const filename = `${proposalId}_${id}.json`;
      const file = await folder.getFileHandle(filename, {create: true});
      let stream;
      try {
        stream = await file.createWritable();
        await stream.write(serialized);
        assertActive?.();
        await stream.close();
      } catch (error) {
        // A failed close may already have committed. Keep any nonempty record for recovery.
        if (stream) try { await stream.abort(); } catch { /* already closed */ }
        if ((await file.getFile()).size === 0) await folder.removeEntry(filename);
        throw error;
      }
      return updated;
    });
  }
  return {list: () => locks.request(LOCK, {mode: 'shared'}, list), create: fields => commit(uuid(), null, 'create', fields), save: (proposal, action, fields, assertActive) => commit(proposal.id, proposal.head, action, fields, assertActive)};
}

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}
function control(tag, attrs, options) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node[key] = value;
  if (options) for (const [value, label] of options) node.add(new Option(label, value));
  return node;
}
function field(label, node) {
  const wrapper = element('label', label);
  wrapper.append(node);
  return wrapper;
}
const input = (name, type, attrs = {}) => control('input', {name, type, ...attrs});
const select = (name, options, value) => {
  const node = control('select', {name, required: true}, options.map(item => Array.isArray(item) ? item : [item, item]));
  if (value !== undefined) node.value = value;
  return node;
};
function dueText(value, zone) { return value ? `${value.replace('T', ' ')} ${zone}` : 'Not set'; }
function docState(doc) { const version=activeVersion(doc);return version ? `Active v${version.number} · ${version.label}` : doc.requirement === 'Required' ? 'Missing active version' : 'No active version'; }
function quantity(count, noun) { return count + ' ' + noun + (count === 1 ? '' : 's'); }
function deadlineFields(proposal = {}) {
  return ['internal', 'sponsor'].flatMap(prefix => {
    const label = prefix === 'internal' ? 'Internal' : 'Sponsor';
    return [field(`${label} deadline`, input(`${prefix}Due`, 'datetime-local', {value: proposal[`${prefix}Due`] || ''})), field(`${label} time zone`, input(`${prefix}Zone`, 'text', {value: proposal[`${prefix}Zone`] || '', maxLength: 80, placeholder: 'America/Chicago'}))];
  });
}
function statusFields(proposal = {}) {
  return [field('Proposal status', select('status', STATUSES, proposal.status || 'Not set')), field('Next action', input('nextAction', 'text', {value: proposal.nextAction || '', maxLength: 300})), ...deadlineFields(proposal)];
}

export function mountPortfolio(root, {onSelectProposal, onSelectRound, onContextChange,onPrepareDocument} = {}) {
  let store, proposals = [], selectedId = null, activeRound = null, busy = false,selectionGeneration=0,renderedSelection=null,restoreFocusElement=null;
  const panel = element('div');
  const feedback = element('p');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  root.append(panel, feedback);
  async function act(fn) {
    if (busy) return;
    busy = true;
    restoreFocusElement=document.activeElement;
    panel.inert = true;
    feedback.textContent = '';
    try { await fn(); }
    catch (error) { if (error?.name !== 'AbortError') feedback.textContent = error?.message || 'Could not update the local portfolio.'; }
    finally { panel.inert = false; busy = false;restoreFocusElement=null; }
  }
  function button(label, fn, secondary = false) {
    const btn = element('button', label, secondary ? 'button-secondary' : undefined);
    btn.type = 'button';
    btn.addEventListener('click', () => act(fn));
    return btn;
  }
  function form(title, fields, submit, fn) {
    const node = element('form');
    const group = element('fieldset');
    const grid = element('div', undefined, 'field-grid');
    grid.append(...fields);
    group.append(element('legend', title), grid, element('button', submit));
    node.append(group);
    node.addEventListener('submit', event => {
      event.preventDefault();
      const fields = Object.fromEntries(new FormData(node));
      act(() => fn(fields));
    });
    return node;
  }
  function fold(label, ...children) {
    const node = element('details');
    node.append(element('summary', label), ...children);
    return node;
  }
  function closeRound() {
    if (activeRound) {
      activeRound = null;
      onSelectRound?.(null);
    }
  }
  function clearContext() {
    selectionGeneration++;
    closeRound();
    onContextChange?.();
  }
  async function refresh() {
    const selectedStore = store;
    const data = await selectedStore.list();
    if (store !== selectedStore) return;
    if (activeRound && data.find(p => p.id === selectedId)?.head !== activeRound.proposal.head) closeRound();
    if (selectedId && !data.some(p => p.id === selectedId)) {
      clearContext();
      selectedId = null;
    }
    proposals = data;
    render();
  }
  function changeSelection(id) {
    if (selectedId !== id) clearContext();
    selectedId = id;
  }
  function close() {
    clearContext();
    store = undefined;
    selectedId = null;
    proposals = [];
    render();
  }
  async function chooseFolder() {
    const handle = await window.showDirectoryPicker({mode: 'readwrite', id: 'juliet-portfolio'});
    const opened = await openPortfolio(handle);
    const data = await opened.list();
    clearContext();
    store = opened;
    proposals = data;
    selectedId = null;
    render();
  }
  async function update(proposal, action, fields) {
    await store.save(proposal, action, fields);
    await refresh();
    feedback.textContent = 'Saved to the selected local folder.';
  }
  function openRound(proposal, round) {
    clearContext();
    const selectedStore = store;
    const binding = {proposal};
    activeRound = binding;
    function assertActive() {
      requireValue(activeRound === binding && store === selectedStore && selectedId === proposal.id, 'This review round is no longer selected. Open it again before saving.');
    }
    async function save(action, data) {
      assertActive();
      const updated = await selectedStore.save(binding.proposal, action, {...data, roundId: round.id}, assertActive);
      assertActive();
      binding.proposal = updated;
      await refresh();
      return updated;
    }
    onSelectRound({
      proposalId: proposal.id, proposalLabel: proposal.label, roundId: round.id, roundNumber: round.number,
      documents: structuredClone(round.documents),
      reviewContext: round.reviewContext ? structuredClone(round.reviewContext) : undefined,
      priorFindings: structuredClone(round.priorFindings ?? []),
      workflowVersion:round.workflowVersion, checklist:structuredClone(round.checklist ?? []),
      heldCheckIds:structuredClone(round.heldCheckIds ?? []),
      get wholeReviewHeld(){return activeHolds(binding.proposal).some(h=>h.scope==='whole');},
      get packets() { return structuredClone(binding.proposal.packets.filter(p => p.roundId === round.id)); },
      registerPacket: packet => save('packet', packet),
      registerPacketSet: packets => save('packet_set',{packets}),
      recordReport: report => save('report', report)
    });
  }
  function requirementForm(proposal, doc) {
    return form(doc ? 'Edit requirement' : 'Add a document requirement', [
      field('Document category', select('category', CATEGORIES, doc?.category)),
      field('Document label', input('name', 'text', {required: true, maxLength: 100, value: doc?.name || '', placeholder: 'Research strategy or Subaward A budget'})),
      field('Applicability', select('requirement', REQUIREMENTS, doc?.requirement || 'Applicability unknown')),
      field('Guidance reference', input('source', 'text', {maxLength: 180, value: doc?.source || '', placeholder: 'Opportunity amendment 1, section IV'}))
    ], doc ? 'Save requirement' : 'Add requirement', data => update(proposal, 'requirement', {...data, documentId: doc?.id}));
  }
  function inventory(proposal) {
    const section = element('section');
    section.append(element('h3', 'Document inventory'), element('p', 'Record each applicable component, including a separate entry for each subaward attachment. Use neutral labels. Recording a version saves metadata only.'));
    for (const doc of proposal.documents) {
      const card = element('article', undefined, 'proposal-card');
      card.append(element('h4', doc.name), element('p', `${doc.category} · ${doc.requirement} · ${docState(doc)}`));
      if (doc.source) card.append(element('p', `Guidance: ${doc.source}`));
      const history = element('ul');
      card.dataset.key='document-'+doc.id;
      for (const version of doc.versions) history.append(element('li', `v${version.number} · ${version.label} · ${version.at}${version.id===activeVersion(doc)?.id?' · Active':''}${version.sha256?' · '+version.provenance+' · SHA-256 '+version.sha256:''}`));
      if(onPrepareDocument) card.append(button('Inspect local file for '+doc.name,()=>{
        closeRound();const generation=selectionGeneration,selectedStore=store;
        const binding={proposal};
        const assertActive=()=>requireValue(generation===selectionGeneration && store===selectedStore && selectedId===proposal.id,'This proposal is no longer selected. Open the document again.');
        return onPrepareDocument({proposalId:proposal.id,proposalLabel:proposal.label,documentId:doc.id,document:structuredClone(doc),assertActive,registerVersion:async fields=>{
          assertActive();const updated=await selectedStore.save(binding.proposal,'version',{...fields,documentId:doc.id},assertActive);binding.proposal=updated;await refresh();assertActive();return {proposal:updated,version:updated.documents.find(d=>d.id===doc.id).versions.at(-1)};
        }});
      }));
      const selection=doc.versions.length ? form('Choose active version',[field('Active document version',select('versionId',[['','No active version'],...doc.versions.map(v=>[v.id,`v${v.number} · ${v.label}`])],activeVersion(doc)?.id || ''))],'Set active version',data=>update(proposal,'active_version',{documentId:doc.id,versionId:data.versionId || null})) : element('p','Record or inspect a version first.');
      selection.querySelector('select')?.removeAttribute('required');
      card.append(fold('Versions and requirement details', history, selection,form('Record a version', [field('Version label', input('label', 'text', {required: true, maxLength: 100, placeholder: 'Revision 2'})),field('Use this as the active version',input('activate','checkbox'))], 'Record version', data => update(proposal, 'version', {...data,activate:data.activate==='on', documentId: doc.id})), requirementForm(proposal, doc)));
      section.append(card);
    }
    if (!proposal.documents.length) section.append(element('p', 'No document requirements recorded.'));
    section.append(fold('Add a requirement', requirementForm(proposal)));
    return section;
  }
  function reportsView(proposal, round) {
    const result = element('div');
    for (const packet of proposal.packets.filter(p => p.roundId === round.id)) {
      const count = proposal.reports.filter(report => report.packetId === packet.packetId).length;
      result.append(fold('Registered packet ' + packet.packetId, element('p', packet.at + ' · ' + (count ? quantity(count, 'report') + ' returned' : 'Awaiting a returned report')), element('p', 'SHA-256 ' + packet.digest)));
    }
    for (const report of proposal.reports.filter(r => r.roundId === round.id)) {
      const content = element('div');
      if(report.historical) content.append(element('p','Historical report — current evidence not checked. These findings do not change the active review.'));
      if(report.checkResults) {
        const table=element('table'),head=element('tr');['Check','Result','Evidence and findings'].forEach(t=>head.append(element('th',t)));table.append(head);
        for(const row of report.checkResults){const tr=element('tr');tr.append(element('td',round.checklist.find(c=>c.checkId===row.checkId)?.label || row.checkId),element('td',({checked:'Checked within scope',missing:'Missing',unchecked:'Unchecked',decision_needed:'Decision needed',not_applicable:'Not applicable'})[row.status]),element('td',row.message+(row.findingIds.length?' · '+row.findingIds.join(', '):'')));table.append(tr);}content.append(table);
      }
      function source(itemId) {
        const ref = report.locations?.find(r => r.itemId === itemId);
        if (!ref) return itemId;
        const doc = round.documents.find(d => d.id === ref.documentId);
        return `${itemId} · ${doc.name} · v${doc.version.number} (${doc.version.label}) · ${ref.anchor}`;
      }
      for (const [title, ids] of [['Reviewed evidence items', report.coverage.reviewed], ['Unreviewed evidence items', report.coverage.unreviewed]]) {
        content.append(element('p', title + (ids.length ? '' : ': None')));
        if (ids.length) {
          const list = element('ul');
          ids.forEach(id => list.append(element('li', source(id))));
          content.append(list);
        }
      }
      if (!report.locations) content.append(element('p', 'Open the registered packet to look up the source locations for these item IDs.'));
      if (report.requiredFollowups?.length) {
        const gaps = element('ul');
        for (const gap of report.requiredFollowups) gaps.append(element('li', `${gap.id} · ${gap.message} Next action: ${gap.nextAction}`));
        content.append(fold('Required follow-ups from the packet', gaps));
      }
      if (!report.findings.length) content.append(element('p', 'No findings recorded in this report.'));
      report.findings.forEach((finding, index) => {
        const item = element('article');
        item.dataset.key='finding-'+findingId(report,index);
        item.append(element('h5', 'Finding ' + (index + 1) + ' · ' + finding.type.replaceAll('_', ' ')), element('p', finding.message));
        item.append(element('p', 'Finding ID ' + findingId(report, index)));
        if(needsRecheck(proposal,findingId(report,index))) item.append(element('p','Needs recheck — earlier verification remains in history, but active evidence changed.'));
        if (finding.nextAction) item.append(element('p', `Next action: ${finding.nextAction} · Owner: ${finding.owner || 'Unassigned'}`));
        if (finding.calculation) item.append(element('p', 'Reported calculation: ' + finding.calculation));
        if (finding.priorFindingId) item.append(element('p', 'Carried from an earlier round; a new report is not a verification decision.'));
        for (const [label, refs] of [['Evidence', finding.evidence], ['Guidance', finding.guidance]]) {
          for (const ref of refs) item.append(element('p', label + ' · ' + source(ref.itemId) + ': ' + ref.quote));
        }
        const verificationDocs = [['', 'Choose a reviewed document version'], ...round.documents.filter(doc => doc.version).map(doc => [doc.id, `${doc.name} · v${doc.version.number} (${doc.version.label})`])];
        const verification = fold('Verification evidence (required only for Verified)',
          field('Verified document version', select('verificationDocument', verificationDocs)),
          field('Verified location', input('verificationAnchor', 'text', {maxLength: 180, placeholder: 'Page, section or sheet and cells'})));
        verification.querySelector('select').required = false;
        if(!report.historical) item.append(fold('Record a finding decision', element('p', 'Corrected records a reported change. Verified records your check of a current document version, including affected totals or documents. Neither changes proposal status.'), form('Finding disposition', [field('Decision', select('disposition', DISPOSITIONS)), field('Decision note', input('note', 'text', {required: true, maxLength: 500})), verification], 'Save decision', data => {
          const version = round.documents.find(doc => doc.id === data.verificationDocument)?.version;
          return update(proposal, 'review', {disposition: data.disposition, note: data.note, roundId: round.id, reportId: report.reportId, index,
            ...(data.disposition === 'Verified' ? {verification: {documentId: data.verificationDocument, versionId: version?.id, anchor: data.verificationAnchor}} : {})});
        })));
        content.append(item);
      });
      const reportView=fold('Report ' + report.reportId, element('p', 'Packet ' + report.packetId + ' · ' + report.at), content);reportView.dataset.key='report-'+report.reportId;result.append(reportView);
    }
    return result;
  }
  function checklistView(proposal) {
    const section=element('section');section.append(element('h3','Proposal checklist'),element('p','Confirm requirements, applicability and governing sources for this proposal. A checked result means only its stated scope was examined.'));
    function editor(check) {
      const dependencies=element('fieldset');dependencies.append(element('legend','Evidence documents and governing sources'));
      for(const doc of proposal.documents) {
        dependencies.append(field(doc.name,input('doc_'+doc.id,'checkbox',{checked:check?.documentIds.includes(doc.id) || false})));
        if(['Opportunity guidance','Institutional guidance'].includes(doc.category)) dependencies.append(field(doc.name+' is governing guidance',input('source_'+doc.id,'checkbox',{checked:check?.sourceDocumentIds.includes(doc.id) || false})));
      }
      return form(check?'Edit checklist check':'Add checklist check',[
        field('Check requirement',input('label','text',{required:true,maxLength:300,value:check?.label || ''})),
        field('Check applicability',select('applicability',[['required','Required'],['optional','Optional'],['unknown','Unknown'],['not_applicable','Not applicable']],check?.applicability || 'unknown')),
        field('Requirement and applicability basis',control('textarea',{name:'basis',maxLength:500,value:check?.basis || '',placeholder:'Source edition, section or page; record unknowns explicitly.'})),dependencies,
        field('Check owner',input('owner','text',{maxLength:100,value:check?.owner || ''})),field('Check next action',input('nextAction','text',{maxLength:300,value:check?.nextAction || ''}))
      ],check?'Save checklist check':'Add checklist check',data=>update(proposal,'check',{checkId:check?.checkId,label:data.label,applicability:data.applicability,basis:data.basis,owner:data.owner,nextAction:data.nextAction,documentIds:proposal.documents.filter(d=>data['doc_'+d.id]==='on').map(d=>d.id),sourceDocumentIds:proposal.documents.filter(d=>data['source_'+d.id]==='on').map(d=>d.id)}));
    }
    for(const check of proposal.checklist) {
      const card=fold(check.label,element('p',`${check.applicability} · ${check.basis || 'Basis not recorded'}`),editor(check));card.dataset.key='check-'+check.checkId;section.append(card);
    }
    section.append(fold('Add checklist check',editor()));return section;
  }
  function lifecycleView(proposal) {
    const section=element('section');section.append(element('h3','Review holds and closeout'));
    const current=proposal.rounds.at(-1);
    for(const hold of activeHolds(proposal)) {
      const card=fold(hold.scope==='whole'?'Whole review on hold':'Selected checks on hold',element('p',`${hold.reason} · Owner: ${hold.owner} · Next action: ${hold.nextAction}`),form('Clear this hold',[field('Resolution and evidence',input('reason','text',{required:true,maxLength:500}))],'Clear hold',data=>update(proposal,'hold_clear',{holdId:hold.id,...data})));card.dataset.key='hold-'+hold.id;section.append(card);
    }
    if(current) {
      const checks=element('fieldset');checks.append(element('legend','Affected checks (for a scoped hold)'));
      for(const check of current.checklist ?? []) checks.append(field(check.label,input('held_'+check.checkId,'checkbox')));
      section.append(fold('Place a review hold',form('New hold',[
        field('Hold scope',select('scope',[['checks','Selected checks'],['whole','Whole review']])),checks,
        field('Hold reason',input('reason','text',{required:true,maxLength:500})),field('Hold owner',input('owner','text',{required:true,maxLength:100})),field('Hold next action',input('nextAction','text',{required:true,maxLength:300}))
      ],'Record hold',data=>update(proposal,'hold',{roundId:current.id,scope:data.scope,checkIds:data.scope==='whole'?[]:(current.checklist ?? []).filter(c=>data['held_'+c.checkId]==='on').map(c=>c.checkId),reason:data.reason,owner:data.owner,nextAction:data.nextAction}))));
    }
    const closeout=currentCloseout(proposal);
    if(proposal.closeouts.length) section.append(element('p',closeout ? (closeout.readyForRouting?'Current closeout: Lynn recorded ready for routing.':'Current closeout: review closed; routing readiness not recorded.') : 'Earlier closeout is outdated. Review changed evidence, findings or decisions and record a new closeout.'));
    for(const prior of proposal.closeouts) section.append(fold('Closeout '+prior.at,element('p',`${prior.readyForRouting?'Ready for routing':'Review closed'} · ${prior.reason} · Next action: ${prior.nextAction}`)));
    if(current?.workflowVersion===3) {
      const corrected=element('fieldset');corrected.append(element('legend','Corrected active files I personally inspected'));
      for(const doc of current.documents.filter(d=>d.version)) corrected.append(field(`${doc.name} · ${doc.version.label}`,input('seen_'+doc.id,'checkbox')));
      const remaining=unresolvedFindings(proposal,false), impact=element('div');
      for(const finding of remaining) impact.append(element('p',finding.message),field('Routing impact for '+finding.findingId,input('impact_'+finding.findingId,'text',{required:true,maxLength:500})),field('Owner for '+finding.findingId,input('owner_'+finding.findingId,'text',{required:true,maxLength:100,value:finding.owner})));
      section.append(fold('Record corrected-file closeout',element('p','Confirm the active corrections you inspected and address each remaining issue. This is your review record, not institutional approval; it sends nothing and does not change status.'),form('Closeout',[
        corrected,field('No corrections were required',input('noCorrectionsRequired','checkbox')),impact,
        field('I judge this review ready for institutional routing',input('readyForRouting','checkbox')),
        field('Closeout decision and reason',input('reason','text',{required:true,maxLength:500})),field('Closeout next action',input('nextAction','text',{required:true,maxLength:300}))
      ],'Save closeout',data=>update(proposal,'closeout',{roundId:current.id,correctedFiles:current.documents.filter(d=>d.version && data['seen_'+d.id]==='on').map(d=>({documentId:d.id,versionId:d.version.id})),noCorrectionsRequired:data.noCorrectionsRequired==='on',remaining:remaining.map(f=>({findingId:f.findingId,impact:data['impact_'+f.findingId],owner:data['owner_'+f.findingId]})),readyForRouting:data.readyForRouting==='on',reason:data.reason,nextAction:data.nextAction}))));
    }
    return section;
  }
  function contextFields() {
    const checks = element('fieldset');
    checks.append(element('legend', 'Requested checks'));
    for (const [value, label] of CHECKS) checks.append(field(label, input('check_' + value, 'checkbox', {checked: value !== 'narrative'})));
    return [
      field('Review lane', select('lane', REVIEW_OPTIONS.lane, 'package')),
      field('Review purpose', select('purpose', REVIEW_OPTIONS.purpose, 'initial')),
      field('Opportunity and edition', input('opportunity', 'text', {maxLength: 180, placeholder: 'Sponsor, program, mechanism, notice ID and dated edition; leave blank if unknown'})),
      field('Review scope', control('textarea', {name: 'scope', required: true, maxLength: 1000, placeholder: 'Requested deliverable, questions, exclusions and how broadly to recheck revisions'})),
      checks,
      field('Guidance state', select('guidanceStatus', REVIEW_OPTIONS.guidanceStatus, 'missing')),
      fold('Owners and evidence limits',
        field('Next-action owner', input('owner', 'text', {maxLength: 100, placeholder: 'Role, not a personal name'})),
        field('Review next action', input('nextAction', 'text', {maxLength: 300})),
        field('Calculation evidence', select('calculationEvidence', REVIEW_OPTIONS.calculationEvidence, 'not_checked')),
        field('Calculation evidence note', control('textarea', {name: 'calculationNote', maxLength: 500, placeholder: 'Required when calculations were checked: method, ranges, version, dependencies and limits. This record is not proof of recalculation.'})),
        field('Narrative permission', select('narrativePermission', REVIEW_OPTIONS.narrativePermission, 'not_requested')))
    ];
  }
  function contextView(round) {
    const context = round.reviewContext;
    const label = (key, value) => REVIEW_OPTIONS[key].find(option => option[0] === value)?.[1] || value;
    const content = element('div');
    content.append(element('p', `${label('lane', context.lane)} · ${label('purpose', context.purpose)}`),
      element('p', 'Opportunity: ' + (context.opportunity || 'Unknown')),
      element('p', 'Scope: ' + context.scope),
      element('p', 'Checks: ' + context.requestedChecks.map(value => CHECKS.find(option => option[0] === value)?.[1] || value).join(', ')),
      element('p', 'Guidance: ' + label('guidanceStatus', context.guidanceStatus)),
      element('p', `Next action: ${context.nextAction || 'Not recorded'} · Owner: ${context.owner || 'Unassigned'}`),
      element('p', `User-reported calculation evidence: ${label('calculationEvidence', context.calculationEvidence)}${context.calculationNote ? ' · ' + context.calculationNote : ''}`),
      element('p', 'Narrative permission: ' + label('narrativePermission', context.narrativePermission)),
      element('p', context.handling==='fictional_only'?'Handling: fictional rehearsal.':'Handling: real proposal evidence. Local processing, external transmission and support access have separate permission requirements; this record does not establish institutional authorization.'),
      element('p', 'The user confirmed that the listed versions were active when this round was created.'));
    if (round.priorFindings.length) {
      const list = element('ul');
      for (const finding of round.priorFindings) list.append(element('li', `${finding.findingId} · ${finding.disposition} · ${finding.message} · Owner: ${finding.owner || 'Unassigned'} · Next action: ${finding.nextAction || 'Not recorded'}`));
      content.append(element('h4', 'Unresolved findings carried into this round'), list);
    } else content.append(element('p', 'No unresolved earlier findings were recorded when this round was created.'));
    return fold('Frozen review context', content);
  }
  function rounds(proposal) {
    const section = element('section');
    section.append(element('h3', 'Review rounds'), element('p', 'A round freezes the current document inventory, version labels and missing items. Documents remain in their approved storage location.'));
    for (const round of [...proposal.rounds].reverse()) {
      const docs = element('ul');
      for (const doc of round.documents) docs.append(element('li', `${doc.name} · ${doc.requirement} · ${doc.version ? 'v' + doc.version.number + ' · ' + doc.version.label : doc.requirement === 'Required' ? 'Missing' : 'No version recorded'}${doc.source ? ' · ' + doc.source : ''}`));
      const history = element('ul');
      for (const review of proposal.reviews.filter(review => review.roundId === round.id)) {
        const target = review.reportId ? 'Report ' + review.reportId + ', finding ' + (review.index + 1) + ' · ' : '';
        const disposition = review.disposition === 'Resolved' ? 'Resolved (legacy; verification not established)' : review.disposition;
        const verified = review.verification ? ` · Checked ${round.documents.find(d => d.id === review.verification.documentId).name} · ${review.verification.versionId} · ${review.verification.anchor}` : '';
        history.append(element('li', target + `${disposition} · ${review.note} · ${review.at}${verified}`));
      }
      const roundCard = fold(`Round ${round.number} · ${round.label}`, element('p', `${round.at} · ${round.id}`), docs);
      roundCard.dataset.key='round-'+round.id;
      if (round.reviewContext) roundCard.append(contextView(round));
      else roundCard.append(element('p', 'This historical round has no review scope. Existing reports remain available; record a new scoped round to prepare another packet.'));
      if (onSelectRound) roundCard.append(button('Review this round', () => openRound(proposal, round)));
      roundCard.append(reportsView(proposal, round), element('h4', 'Review history'), history, form('Record a review note', [field('Disposition', select('disposition', DISPOSITIONS.filter(d => d !== 'Verified'))), field('Brief note', input('note', 'text', {required: true, maxLength: 500}))], 'Save review note', data => update(proposal, 'review', {...data, roundId: round.id})));
      section.append(roundCard);
    }
    if (!proposal.rounds.length) section.append(element('p', 'No round snapshots recorded.'));
    if (proposal.documents.length) section.append(fold('Record an inventory snapshot',
      element('p', 'A round freezes this proposal’s review scope, selected active versions, checklist and unresolved findings. Confirm revision scope and dependencies in the review scope. Earlier versions remain in history.'),
      form('New immutable round', [field('Round label', input('label', 'text', {required: true, maxLength: 100})), ...contextFields(),
        field('Material',select('handling',REVIEW_OPTIONS.handling,'real_proposal')),
        field('I confirmed the selected active versions for this round.', input('activeVersionsConfirmed', 'checkbox', {required: true})),field('I confirmed this proposal checklist, applicability and review scope.',input('checklistConfirmed','checkbox',{required:true}))], 'Record snapshot', data => {
        const context = Object.fromEntries(['lane', 'purpose', 'opportunity', 'scope', 'guidanceStatus', 'owner', 'nextAction', 'calculationEvidence', 'calculationNote', 'narrativePermission'].map(key => [key, data[key]]));
        context.requestedChecks = CHECKS.filter(([key]) => data['check_' + key] === 'on').map(([key]) => key);
        context.handling = data.handling;
        return update(proposal, 'round', {label: data.label, reviewContext: normalizeReviewContext(context,{reviewOnly:true}),workflowVersion:3,checklistConfirmed:data.checklistConfirmed==='on', activeVersionsConfirmed: data.activeVersionsConfirmed === 'on'});
      })));
    return section;
  }
  function render() {
    const sameSelection=selectedId===renderedSelection;
    function controlKey(node) {
      if(!node || !panel.contains(node)) return null;
      const parts=[];
      for(let parent=node;parent && parent!==panel;parent=parent.parentElement) {
        if(parent.dataset.key)parts.unshift(parent.dataset.key);
        else if(parent.tagName==='DETAILS')parts.unshift('fold:'+parent.querySelector(':scope > summary')?.textContent);
        else if(parent.tagName==='FORM')parts.unshift('form:'+parent.querySelector('legend')?.textContent);
      }
      return parts.join('/')+'/'+node.tagName+':'+(node.name || (node.tagName==='DETAILS'?node.querySelector(':scope > summary')?.textContent:node.textContent));
    }
    const openKeys=sameSelection?new Set([...panel.querySelectorAll('details[open]')].map(controlKey)):new Set();
    const focusKey=sameSelection?controlKey(restoreFocusElement || document.activeElement):null;
    const scroll=sameSelection?globalThis.scrollY:0;
    const restore=()=>{
      renderedSelection=selectedId;
      for(const detail of panel.querySelectorAll('details'))if(openKeys.has(controlKey(detail)))detail.open=true;
      if(focusKey) {
        const match=[...panel.querySelectorAll('button,input,select,textarea,summary')].find(n=>controlKey(n)===focusKey);
        const target=match || panel.querySelector('h2');
        if(target) {if(!match)target.tabIndex=-1;requestAnimationFrame(()=>{target.focus({preventScroll:true});globalThis.scrollTo?.(0,scroll);});}
      }
    };
    panel.dataset.view = store ? 'dashboard' : 'landing';
    panel.replaceChildren();
    if (!store) {
      panel.append(element('h2', 'Local proposal portfolio'), element('p', 'Choose a restricted, institution-approved folder on your managed device. Juliet keeps its metadata journal in a Juliet Portfolio subfolder. Anyone with folder access can read proposal metadata and review notes.'), element('p', 'Use one device and browser profile for edits. Keep this folder outside shared or automatically synced locations.'));
      if (typeof window.showDirectoryPicker !== 'function' || !navigator.locks) panel.append(element('p', 'Folder access requires an approved browser with directory selection and Web Locks, such as desktop Edge or Chrome. The existing preparation workflow remains available.'));
      else panel.append(button('Open portfolio folder', chooseFolder));
      restore();return;
    }
    const active = proposals.filter(p => !['Submitted', 'Withdrawn'].includes(p.status)).length;
    panel.append(element('h2', 'Proposal dashboard'), element('p', `${active} active · ${proposals.length} total`), button('Refresh portfolio', refresh, true), button('Close portfolio', close, true));
    const cards = element('div', undefined, 'field-grid');
    for (const p of proposals) {
      const card = element('article', undefined, 'proposal-card');
      const missing = p.documents.filter(d => d.requirement === 'Required' && !activeVersion(d)).length;
      card.append(element('h3', p.label), element('p', `${p.status} · ${quantity(p.documents.length, 'document')} · ${missing} required missing · ${quantity(p.rounds.length, 'round')}`), element('p', `Internal: ${dueText(p.internalDue, p.internalZone)}`), element('p', `Sponsor: ${dueText(p.sponsorDue, p.sponsorZone)}`), element('p', `Next action: ${p.nextAction || 'Not set'}`), button(`Open ${p.label}`, () => { changeSelection(p.id); render(); }, true));
      const rechecks=unresolvedFindings(p,false).filter(f=>f.disposition==='Needs recheck').length;
      card.append(element('p',`${quantity(activeHolds(p).length,'active hold')} · ${quantity(rechecks,'finding needing recheck')}${p.closeouts.length && !currentCloseout(p)?' · Closeout outdated':''}`));
      cards.append(card);
    }
    panel.append(cards, fold('Create a proposal', form('New proposal', [field('Sponsor initials', input('sponsor', 'text', {required: true, pattern: '[A-Za-z][A-Za-z0-9]{0,19}', maxLength: 20})), field('Original submission date', input('originalDate', 'date', {required: true})), field('Proposal sequence', input('sequence', 'number', {value: '1', min: '1', max: '999', required: true})), ...statusFields()], 'Create proposal', async data => {
      const proposal = await store.create({...data, sequence: Number(data.sequence)});
      changeSelection(proposal.id);
      await refresh();
      feedback.textContent = `Created ${proposal.label}.`;
    })));
    const p = proposals.find(p => p.id === selectedId);
    if (!p) {restore();return;}
    panel.append(element('h2', `${p.label} workspace`), element('p', `Proposal ID ${p.id}`));
    if (onSelectProposal) panel.append(button('Prepare budget and justification', () => {
      closeRound();
      return onSelectProposal({id: p.id, label: p.label, sponsor: p.sponsor, originalDate: p.originalDate, sequence: p.sequence, revision: p.revision, status: p.status});
    }));
    panel.append(fold('Update status, deadlines or next action', form('Proposal details', statusFields(p), 'Save proposal details', data => update(p, 'details', data))), inventory(p),checklistView(p), rounds(p),lifecycleView(p));
    restore();
  }
  render();
  return {refresh: () => store ? act(refresh) : Promise.resolve(), closeRound};
}
