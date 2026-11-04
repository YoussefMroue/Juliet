import {sealPacket, verifyPacket, verifyReport} from './packet.js';
import {requiredFollowups, REVIEW_OPTIONS} from './review-context.js';

function node(tag, text) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}
function label(title, control) {
  const el = node('label', title);
  el.append(control);
  return el;
}
function picker(title) {
  const input = node('input');
  input.type = 'file';
  input.accept = '.json,application/json';
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
  link.download = 'Juliet-packet-' + packet.packetId + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
}
export function showRoundExchange(host, context) {
  host.replaceChildren();
  host.hidden = !context;
  if (!context) return;
  const section = node('div');
  host.append(section);
  const current = () => section.parentNode === host && !host.hidden;
  const status = node('p');
  status.setAttribute('role', 'status');
  function button(text, action) {
    const el = node('button', text);
    el.type = 'button';
    el.addEventListener('click', async () => {
      if (!current() || section.inert) return;
      section.inert = true;
      status.textContent = '';
      try { await action(); } catch (error) { status.textContent = error.message || 'The operation could not be completed.'; }
      finally { section.inert = false; }
    });
    return el;
  }
  section.append(node('h3', 'Fictional packet rehearsal'), node('p', context.proposalLabel + ' · Round ' + context.roundNumber),
    node('p','Only use invented material here. The download includes the round scope, complete inventory labels, prior findings, follow-ups and selected excerpts. Check all of them before sharing. Source files remain on your device.'));
  if(context.reviewContext) {
    const c=context.reviewContext;
    section.append(node('p',REVIEW_OPTIONS.lane.find(([v])=>v===c.lane)[1]+' · '+REVIEW_OPTIONS.purpose.find(([v])=>v===c.purpose)[1]),
      node('p','Opportunity and edition: '+(c.opportunity || 'Unknown')),node('p','Scope: '+c.scope),
      node('p','Requested checks: '+c.requestedChecks.join(', ')),node('p','Guidance: '+c.guidanceStatus),
      node('p','Calculation evidence (user-recorded): '+c.calculationEvidence+' · '+(c.calculationNote || 'No calculation evidence recorded.')),
      node('p','Narrative permission: '+c.narrativePermission+' · Next action owner: '+(c.owner || 'Unassigned')+' · '+c.nextAction));
    const inventory=node('ul');
    for(const doc of context.documents) inventory.append(node('li',`${doc.name} · ${doc.category} · ${doc.requirement} · ${doc.version ? doc.version.label : 'No version'} · ${doc.source || 'No guidance reference'}`));
    section.append(node('h4','Frozen inventory included in the packet'),inventory);
    for(const f of context.priorFindings ?? []) section.append(node('p',`Prior ${f.findingId} · ${f.disposition} · ${f.message} · ${f.owner || 'Unassigned'} · ${f.nextAction}`));
  } else section.append(node('p','This legacy round has no frozen review scope. Import its existing packet below, or record a new round to prepare a scoped packet.'));
  const docs = node('select');
  for (const doc of context.documents.filter(d => d.version)) {
    const option = node('option', doc.name + ' · v' + doc.version.number);
    option.value = doc.id;
    docs.append(option);
  }
  const anchor = node('input'); anchor.maxLength = 180;
  const excerpt = node('textarea'); excerpt.maxLength = 6000;
  const rows = node('ol');
  const followups = node('div');
  const entries = [];
  let approvedPacket = null;
  const consent = node('input'); consent.type = 'checkbox';
  const save = button('Register and download fictional packet', async () => {
    if (!consent.checked || !entries.length || anchor.value.trim() || excerpt.value.trim()) throw Error('Finish adding excerpts, then approve the displayed packet.');
    const packet = await sealPacket(context, entries);
    if (!current()) return;
    await context.registerPacket({packetId:packet.packetId, digest:packet.digest});
    if (!current()) return;
    reset();
    p.input.value = '';
    r.input.value = '';
    approvedPacket = packet;
    download(packet);
    consent.checked = false;
    status.textContent = 'Packet ' + packet.packetId + ' registered. Keep the downloaded file to verify its findings.';
  });
  function renderEntries() {
    rows.replaceChildren();
    entries.forEach((entry, i) => {
      const li = node('li');
      const doc = context.documents.find(d => d.id === entry.documentId);
      li.append(node('strong', 'E' + (i+1) + ' · ' + doc.name + ' · ' + entry.anchor),node('p',entry.text),
        button('Remove excerpt', () => {entries.splice(i,1); renderEntries();}));
      rows.append(li);
    });
    followups.replaceChildren();
    if(context.reviewContext) {
      const items=entries.map(e=>({...e,category:context.documents.find(d=>d.id===e.documentId).category}));
      followups.append(node('h4','Follow-ups required in the returned report'));
      for(const gap of requiredFollowups(context.reviewContext,context.documents,items,context.priorFindings ?? [])) followups.append(node('p',`${gap.id} · ${gap.message} Next action: ${gap.nextAction}`));
    }
    consent.checked = false;
  }
  const add = button('Add excerpt', () => {
    if (!docs.value || !anchor.value.trim() || !excerpt.value.trim() || entries.length >= 30) throw Error('Select a versioned document, enter a location and enter its fictional text. Up to 30 excerpts are allowed.');
    entries.push({documentId:docs.value, anchor:anchor.value, text:excerpt.value});
    anchor.value = ''; excerpt.value = ''; renderEntries(); anchor.focus();
  });
  if (docs.options.length && context.reviewContext) {
    section.append(label('Document version',docs), label('Page, paragraph or sheet and cell',anchor),
      label('Fictional excerpt',excerpt),add,rows,followups,label('I reviewed the scope, inventory, prior findings and excerpts and confirm all material is fictional.',consent),
      node('p','Check each excerpt against its named document version and location before registering the packet.'),save);
  } else if(context.reviewContext) section.append(node('p','Record a document version and freeze a new round to prepare an excerpt packet.'));
  renderEntries();
  const p = picker('Original registered fictional packet');
  const r = picker('Returned findings JSON');
  const preview = node('div');
  let pending = null;
  const reset = () => { pending = null; preview.replaceChildren(); accept.hidden = true; };
  const accept = button('Save verified report to this round', async () => {
    if (!pending) throw Error('Check the report before saving it.');
    await context.recordReport(pending);
    reset(); status.textContent = 'Report recorded. Review each finding and record your decision in the round history.';
  });
  accept.hidden = true;
  p.input.addEventListener('change',reset); r.input.addEventListener('change',reset);
  const validate = button('Check packet and report', async () => {
    reset();
    const source = p.input.files.length ? await readFile(p.input, true) : approvedPacket;
    if (!source) throw Error('Choose the registered packet used by the reviewer.');
    const packet = await verifyPacket(context, source);
    const report = verifyReport(packet, await readFile(r.input));
    if (!current()) return;
    preview.append(node('p','Packet ' + packet.packetId + ' · Report ' + report.reportId),
      node('p',report.coverage.reviewed.length + ' excerpts reviewed · ' + report.coverage.unreviewed.length + ' unreviewed.'));
    for (const f of report.findings) {
      preview.append(node('p',f.type + ' · ' + f.message));
      if(f.id) preview.append(node('p',`${f.id} · Owner: ${f.owner || 'Unassigned'} · Next action: ${f.nextAction}`));
      if(f.calculation) preview.append(node('p','Calculation to verify: '+f.calculation));
      for (const [label, refs] of [['Proposal evidence', f.evidence], ['Guidance', f.guidance]]) {
        for (const ref of refs) {
          const item = packet.items.find(i => i.itemId === ref.itemId);
          const doc = context.documents.find(d => d.id === item.documentId);
          preview.append(node('p',[label, ref.itemId, doc.name, doc.version.label, item.anchor, ref.quote].join(' · ')));
        }
      }
    }
    for(const gap of report.requiredFollowups ?? []) preview.append(node('p',`Required follow-up ${gap.id}: ${gap.message} Next action: ${gap.nextAction}`));
    pending = report; accept.hidden = false;
    status.textContent = 'Packet identity and quotations match. Check the reasoning before saving.';
  });
  section.append(node('h4','Return findings'),node('p','Use a fresh review chat for this packet. Return here with the original packet and the findings JSON.'),
    p.label,r.label,validate,preview,accept,status);
}
