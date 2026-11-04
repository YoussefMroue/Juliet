// Directory handles and the active selection live only in this tab. Each journal
// entry has a unique filename so a stale or interrupted writer cannot replace history.
import {normalizeReviewContext, normalizePriorFindings, normalizeFollowups, REVIEW_OPTIONS, CHECKS} from './review-context.js';
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
    if (findingId(report, review.index) === id) return review.disposition;
  }
  return 'Open';
}
function unresolvedFindings(proposal, enforceLimit = true) {
  const latest = new Map();
  for (const report of proposal.reports) report.findings.forEach((finding, index) => {
    const id = findingId(report, index), previous = latest.get(id);
    latest.set(id, {findingId: id, message: finding.message, type: finding.type,
      owner: finding.owner || previous?.owner || '', nextAction: finding.nextAction || previous?.nextAction || '', disposition: 'Open'});
  });
  for (const review of proposal.reviews) {
    if (review.reportId === undefined) continue;
    const report = proposal.reports.find(r => r.reportId === review.reportId);
    const row = latest.get(findingId(report, review.index));
    if (row) row.disposition = review.disposition;
  }
  const unresolved = [...latest.values()].filter(row => !['Declined', 'Rejected', 'Verified'].includes(row.disposition));
  return enforceLimit ? normalizePriorFindings(unresolved) : unresolved;
}
function verificationForRound(round, value) {
  requireValue(value && typeof value === 'object', 'Verified findings need a document version and location.');
  const doc = round.documents.find(d => d.id === value.documentId);
  requireValue(doc?.version && doc.version.id === value.versionId, 'Verification must cite a document version in this review round.');
  return {documentId: doc.id, versionId: doc.version.id, anchor: limited(value.anchor, 180, 'verification location')};
}
function coverage(value) {
  const reviewed = value?.reviewed, unreviewed = value?.unreviewed;
  requireValue(Array.isArray(reviewed) && Array.isArray(unreviewed), 'Missing packet coverage.');
  const all = [...reviewed, ...unreviewed];
  requireValue(all.length > 0 && all.length <= 30 && all.every(id => typeof id === 'string' && /^E[1-9][0-9]{0,5}$/.test(id)) && new Set(all).size === all.length, 'Invalid packet coverage.');
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
    proposal = {id: proposalId, sponsor, label, originalDate: data.originalDate, sequence: data.sequence, ...details(data), documents: [], rounds: [], reviews: [], packets: [], reports: []};
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
      doc.versions.push({id, number: doc.versions.length + 1, label: limited(data.label, 100, 'version label'), at});
    } else if (action === 'round') {
      requireValue(proposal.documents.length, 'Add a document requirement before recording a round.');
      const round = {id, number: proposal.rounds.length + 1, at, label: limited(data.label, 100, 'round label'), documents: proposal.documents.map(doc => ({id: doc.id, name: doc.name, category: doc.category, requirement: doc.requirement, source: doc.source, version: doc.versions.at(-1) ?? null}))};
      if (data.reviewContext !== undefined) {
        requireValue(data.activeVersionsConfirmed === true, 'Confirm that the listed latest versions are active for this round.');
        round.reviewContext = normalizeReviewContext(data.reviewContext);
        round.priorFindings = unresolvedFindings(proposal);
        round.activeVersionsConfirmed = true;
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
          const latest = proposal.documents.find(doc => doc.id === review.verification.documentId)?.versions.at(-1);
          const id = findingId(report, data.index);
          const latestReport = proposal.reports.findLast(r => r.findings.some((_, index) => findingId(r, index) === id));
          requireValue(latest?.id === review.verification.versionId && latestReport === report,
            'This finding or document has a newer version. Review the current round before verifying it.');
        }
        else requireValue(data.verification === undefined, 'Verification evidence belongs to a Verified finding decision.');
      } else {
        requireValue(data.disposition !== 'Verified' && data.verification === undefined, 'Verify an individual finding with its document evidence.');
      }
      proposal.reviews.push(review);
    } else if (action === 'packet' || action === 'report') {
      requireValue(proposal.rounds.some(round => round.id === data.roundId), 'Choose a review round from this proposal.');
      requireValue(typeof data.packetId === 'string' && UUID.test(data.packetId) && typeof data.digest === 'string' && /^[a-f0-9]{64}$/.test(data.digest), 'Invalid packet identity or fingerprint.');
      const packet = proposal.packets.find(p => p.packetId === data.packetId);
      if (action === 'packet') {
        requireValue(!packet, 'Packet ID is already registered.');
        proposal.packets.push({roundId: data.roundId, packetId: data.packetId, digest: data.digest, at});
      } else {
        requireValue(packet?.roundId === data.roundId && packet.digest === data.digest, 'The packet does not match this proposal and round.');
        requireValue(typeof data.reportId === 'string' && UUID.test(data.reportId) && !proposal.reports.some(r => r.reportId === data.reportId), 'Invalid or reused report ID.');
        const round = proposal.rounds.find(r => r.id === data.roundId);
        const requiredFollowups = data.requiredFollowups === undefined ? undefined : followupsForRound(round, data.requiredFollowups);
        const report = {roundId: data.roundId, packetId: data.packetId, digest: data.digest, reportId: data.reportId, findings: findings(data.findings, round, data.reportId, requiredFollowups), coverage: coverage(data.coverage), at};
        requireValue(report.findings.every(f => !f.priorFindingId || !['Declined', 'Rejected', 'Verified'].includes(latestDisposition(proposal, f.priorFindingId))),
          'A prior finding was closed after this round was frozen. Record a current round before importing new evidence.');
        if (requiredFollowups !== undefined) report.requiredFollowups = requiredFollowups;
        if (data.locations !== undefined) report.locations = locations(round, report.coverage, data.locations);
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
            requireValue(JSON.stringify(existing.findings) === JSON.stringify(findings(fields.findings, round, fields.reportId, requiredFollowups)) && JSON.stringify(existing.coverage) === JSON.stringify(coverage(fields.coverage)), 'This report ID was already used with different findings or coverage.');
            if (fields.locations !== undefined) {
              const supplied = locations(owner.rounds.find(r => r.id === existing.roundId), existing.coverage, fields.locations);
              requireValue(!existing.locations || JSON.stringify(existing.locations) === JSON.stringify(supplied), 'This report ID was already used with different locations.');
            }
          }
          return owner;  // Same import or registration is safe to retry.
        }
      }
      requireValue((current?.head ?? null) === expectedHead, 'This proposal changed in another view. Refresh the portfolio and review the latest record.');
      const id = uuid();
      const detailFields = ['status', 'nextAction', 'internalDue', 'internalZone', 'sponsorDue', 'sponsorZone'];
      const allowed = {
        create: ['sponsor', 'originalDate', 'sequence', ...detailFields], details: detailFields,
        requirement: ['documentId', 'category', 'name', 'requirement', 'source'], version: ['documentId', 'label'],
        round: ['label', 'reviewContext', 'activeVersionsConfirmed'], review: ['roundId', 'reportId', 'index', 'disposition', 'note', 'verification'],
        packet: ['roundId', 'packetId', 'digest'], report: ['roundId', 'packetId', 'digest', 'reportId']
      };
      requireValue(Object.hasOwn(allowed, action), 'Unsupported portfolio action.');
      const data = Object.fromEntries(allowed[action].map(key => [key, fields[key]]));
      if (action === 'round' && fields.reviewContext !== undefined) data.reviewContext = normalizeReviewContext(fields.reviewContext);
      if (action === 'review' && fields.verification !== undefined) data.verification = verificationForRound(current?.rounds.find(r => r.id === data.roundId), fields.verification);
      if (action === 'report') {
        const round = current?.rounds.find(r => r.id === data.roundId);
        if (fields.requiredFollowups !== undefined) data.requiredFollowups = followupsForRound(round, fields.requiredFollowups);
        data.findings = findings(fields.findings, round, data.reportId, data.requiredFollowups);
        data.coverage = coverage(fields.coverage);
        if (fields.locations !== undefined) data.locations = locations(current?.rounds.find(r => r.id === data.roundId), data.coverage, fields.locations);
      }
      if (action === 'requirement' && !data.documentId) data.documentId = id;
      const event = {format: 1, proposalId, id, revision: (current?.revision ?? 0) + 1, previous: expectedHead, at: new Date().toISOString(), action, data};
      const updated = apply(current, event);
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
function docState(doc) { return doc.versions.length ? `v${doc.versions.at(-1).number} · ${doc.versions.at(-1).label}` : doc.requirement === 'Required' ? 'Missing' : 'No version recorded'; }
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

export function mountPortfolio(root, {onSelectProposal, onSelectRound, onContextChange} = {}) {
  let store, proposals = [], selectedId = null, activeRound = null, busy = false;
  const panel = element('div');
  const feedback = element('p');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  root.append(panel, feedback);
  async function act(fn) {
    if (busy) return;
    busy = true;
    panel.inert = true;
    feedback.textContent = '';
    try { await fn(); }
    catch (error) { if (error?.name !== 'AbortError') feedback.textContent = error?.message || 'Could not update the local portfolio.'; }
    finally { panel.inert = false; busy = false; }
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
      get packets() { return structuredClone(binding.proposal.packets.filter(p => p.roundId === round.id)); },
      registerPacket: packet => save('packet', packet),
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
      for (const version of doc.versions) history.append(element('li', `v${version.number} · ${version.label} · ${version.at}`));
      card.append(fold('Versions and requirement details', history, form('Record a version', [field('Version label', input('label', 'text', {required: true, maxLength: 100, placeholder: 'Revision 2'}))], 'Record version', data => update(proposal, 'version', {...data, documentId: doc.id})), requirementForm(proposal, doc)));
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
        item.append(element('h5', 'Finding ' + (index + 1) + ' · ' + finding.type.replaceAll('_', ' ')), element('p', finding.message));
        item.append(element('p', 'Finding ID ' + findingId(report, index)));
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
        item.append(fold('Record a finding decision', element('p', 'Corrected records a reported change. Verified records your check of a current document version, including affected totals or documents. Neither changes proposal status.'), form('Finding disposition', [field('Decision', select('disposition', DISPOSITIONS)), field('Decision note', input('note', 'text', {required: true, maxLength: 500})), verification], 'Save decision', data => {
          const version = round.documents.find(doc => doc.id === data.verificationDocument)?.version;
          return update(proposal, 'review', {disposition: data.disposition, note: data.note, roundId: round.id, reportId: report.reportId, index,
            ...(data.disposition === 'Verified' ? {verification: {documentId: data.verificationDocument, versionId: version?.id, anchor: data.verificationAnchor}} : {})});
        })));
        content.append(item);
      });
      result.append(fold('Report ' + report.reportId, element('p', 'Packet ' + report.packetId + ' · ' + report.at), content));
    }
    return result;
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
      element('p', 'Handling: fictional rehearsal only. Real-data authorization is not established by this record.'),
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
      if (round.reviewContext) roundCard.append(contextView(round));
      else roundCard.append(element('p', 'This historical round has no review scope. Existing reports remain available; record a new scoped round to prepare another packet.'));
      if (onSelectRound) roundCard.append(button('Review this round', () => openRound(proposal, round)));
      roundCard.append(reportsView(proposal, round), element('h4', 'Review history'), history, form('Record a review note', [field('Disposition', select('disposition', DISPOSITIONS.filter(d => d !== 'Verified'))), field('Brief note', input('note', 'text', {required: true, maxLength: 500}))], 'Save review note', data => update(proposal, 'review', {...data, roundId: round.id})));
      section.append(roundCard);
    }
    if (!proposal.rounds.length) section.append(element('p', 'No round snapshots recorded.'));
    if (proposal.documents.length) section.append(fold('Record an inventory snapshot',
      element('p', 'Use fictional details for this rehearsal. A round freezes the review scope, current inventory and unresolved findings from this proposal. Confirm the latest recorded version of each document is the intended active version; record a corrected version label first if needed. Earlier versions remain in history.'),
      form('New immutable round', [field('Round label', input('label', 'text', {required: true, maxLength: 100})), ...contextFields(),
        field('I confirmed the listed latest versions are active for this round.', input('activeVersionsConfirmed', 'checkbox', {required: true}))], 'Record snapshot', data => {
        const context = Object.fromEntries(['lane', 'purpose', 'opportunity', 'scope', 'guidanceStatus', 'owner', 'nextAction', 'calculationEvidence', 'calculationNote', 'narrativePermission'].map(key => [key, data[key]]));
        context.requestedChecks = CHECKS.filter(([key]) => data['check_' + key] === 'on').map(([key]) => key);
        context.handling = 'fictional_only';
        return update(proposal, 'round', {label: data.label, reviewContext: normalizeReviewContext(context), activeVersionsConfirmed: data.activeVersionsConfirmed === 'on'});
      })));
    return section;
  }
  function render() {
    panel.dataset.view = store ? 'dashboard' : 'landing';
    panel.replaceChildren();
    if (!store) {
      panel.append(element('h2', 'Local proposal portfolio'), element('p', 'Choose a restricted, institution-approved folder on your managed device. Juliet keeps its metadata journal in a Juliet Portfolio subfolder. Anyone with folder access can read proposal metadata and review notes.'), element('p', 'Use one device and browser profile for edits. Keep this folder outside shared or automatically synced locations.'));
      if (typeof window.showDirectoryPicker !== 'function' || !navigator.locks) panel.append(element('p', 'Folder access requires an approved browser with directory selection and Web Locks, such as desktop Edge or Chrome. The existing preparation workflow remains available.'));
      else panel.append(button('Open portfolio folder', chooseFolder));
      return;
    }
    const active = proposals.filter(p => !['Submitted', 'Withdrawn'].includes(p.status)).length;
    panel.append(element('h2', 'Proposal dashboard'), element('p', `${active} active · ${proposals.length} total`), button('Refresh portfolio', refresh, true), button('Close portfolio', close, true));
    const cards = element('div', undefined, 'field-grid');
    for (const p of proposals) {
      const card = element('article', undefined, 'proposal-card');
      const missing = p.documents.filter(d => d.requirement === 'Required' && !d.versions.length).length;
      card.append(element('h3', p.label), element('p', `${p.status} · ${quantity(p.documents.length, 'document')} · ${missing} required missing · ${quantity(p.rounds.length, 'round')}`), element('p', `Internal: ${dueText(p.internalDue, p.internalZone)}`), element('p', `Sponsor: ${dueText(p.sponsorDue, p.sponsorZone)}`), element('p', `Next action: ${p.nextAction || 'Not set'}`), button(`Open ${p.label}`, () => { changeSelection(p.id); render(); }, true));
      cards.append(card);
    }
    panel.append(cards, fold('Create a proposal', form('New proposal', [field('Sponsor initials', input('sponsor', 'text', {required: true, pattern: '[A-Za-z][A-Za-z0-9]{0,19}', maxLength: 20})), field('Original submission date', input('originalDate', 'date', {required: true})), field('Proposal sequence', input('sequence', 'number', {value: '1', min: '1', max: '999', required: true})), ...statusFields()], 'Create proposal', async data => {
      const proposal = await store.create({...data, sequence: Number(data.sequence)});
      changeSelection(proposal.id);
      await refresh();
      feedback.textContent = `Created ${proposal.label}.`;
    })));
    const p = proposals.find(p => p.id === selectedId);
    if (!p) return;
    panel.append(element('h2', `${p.label} workspace`), element('p', `Proposal ID ${p.id}`));
    if (onSelectProposal) panel.append(button('Prepare budget and justification', () => {
      closeRound();
      return onSelectProposal({id: p.id, label: p.label, sponsor: p.sponsor, originalDate: p.originalDate, sequence: p.sequence, revision: p.revision, status: p.status});
    }));
    panel.append(fold('Update status, deadlines or next action', form('Proposal details', statusFields(p), 'Save proposal details', data => update(p, 'details', data))), inventory(p), rounds(p));
  }
  render();
  return {refresh: () => store ? act(refresh) : Promise.resolve(), closeRound};
}
