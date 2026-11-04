// Round metadata is local, user-supplied context, never evidence of authorization.
export const REVIEW_OPTIONS = {
  lane: [['package','Full proposal package'],['budget','Budget and justification'],['focused','Focused question or drafting']],
  purpose: [['initial','Initial review'],['revision','Review revisions'],['drafting','Prepare or draft'],['policy','Resolve a policy question']],
  guidanceStatus: [['missing','Missing or not verified'],['provided','Applicable guidance supplied'],['conflicting','Conflicting instructions']],
  calculationEvidence: [['not_checked','Not checked'],['saved_values','Saved values inspected'],['formulas','Formulas inspected'],['independent','Independent calculation'],['excel','Excel recalculation recorded']],
  narrativePermission: [['not_requested','Not requested'],['comments_only','Comments only'],['suggested_edits','Suggested wording permitted']],
  handling: [['fictional_only','Fictional rehearsal only']]
};
export const CHECKS = [['completeness','Completeness'],['calculations','Calculations'],['compliance','Compliance with supplied guidance'],['consistency','Cross-document consistency'],['narrative','Narrative quality']];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const FINDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/F[1-9][0-9]{0,2}$/;
export const GUIDANCE = ['Opportunity guidance','Institutional guidance'];
function check(ok, message) { if (!ok) throw Error(message); }
function exact(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value,k)), 'Review context fields do not match the expected format.');
}
function text(value, max, required = false) {
  check(typeof value === 'string' && value.length <= max && (!required || value.trim()), 'Review context contains missing or oversized text.');
  return value.trim();
}
export function normalizeReviewContext(value) {
  exact(value,['lane','purpose','opportunity','scope','requestedChecks','guidanceStatus','owner','nextAction','calculationEvidence','calculationNote','narrativePermission','handling']);
  for (const [key,options] of Object.entries(REVIEW_OPTIONS)) check(options.some(([v]) => value[key] === v), 'Choose a valid review ' + key + '.');
  check(Array.isArray(value.requestedChecks) && value.requestedChecks.length > 0 && new Set(value.requestedChecks).size === value.requestedChecks.length && value.requestedChecks.every(c => CHECKS.some(([id])=>id===c)), 'Select the checks requested for this round.');
  check(!value.requestedChecks.includes('narrative') || value.narrativePermission !== 'not_requested', 'Specify the permitted narrative feedback before requesting it.');
  return {lane:value.lane,purpose:value.purpose,opportunity:text(value.opportunity,180),scope:text(value.scope,1000,true),
    requestedChecks:CHECKS.map(([id])=>id).filter(id=>value.requestedChecks.includes(id)),guidanceStatus:value.guidanceStatus,
    owner:text(value.owner,100),nextAction:text(value.nextAction,300),calculationEvidence:value.calculationEvidence,
    calculationNote:text(value.calculationNote,500,value.calculationEvidence!=='not_checked'),narrativePermission:value.narrativePermission,handling:value.handling};
}
export function normalizePriorFindings(values) {
  check(Array.isArray(values) && values.length<=120,'A round supports up to 120 unresolved prior findings.');
  const seen=new Set();
  return values.map(row=>{
    exact(row,['findingId','message','type','owner','nextAction','disposition']);
    check(FINDING_ID.test(row.findingId) && !seen.has(row.findingId),'Invalid or duplicated prior finding identity.'); seen.add(row.findingId);
    check(['objective_error','question','suggestion','coverage_gap'].includes(row.type),'Invalid prior finding type.');
    return {findingId:row.findingId,message:text(row.message,1000,true),type:row.type,owner:text(row.owner,100),nextAction:text(row.nextAction,300),disposition:text(row.disposition,30,true)};
  });
}
export function normalizeFollowups(values) {
  check(Array.isArray(values) && values.length<=300,'Too many required follow-ups for one packet. Narrow this review round.');
  return values.map((row,index)=>{
    exact(row,['id','type','documentId','priorFindingId','message','nextAction']);
    check(row.id==='G'+(index+1) && ['coverage_gap','question'].includes(row.type) && (row.documentId===null || UUID.test(row.documentId)) && (row.priorFindingId===null || FINDING_ID.test(row.priorFindingId)), 'Invalid required follow-up identity.');
    return {id:row.id,type:row.type,documentId:row.documentId,priorFindingId:row.priorFindingId,message:text(row.message,1000,true),nextAction:text(row.nextAction,300,true)};
  });
}
export function requiredFollowups(context,documents,items,priorFindings=[]) {
  const c=normalizeReviewContext(context), rows=[];
  const add=(type,message,nextAction,documentId=null,priorFindingId=null)=>rows.push({id:'G'+(rows.length+1),type,documentId,priorFindingId,message,nextAction});
  const checks=c.requestedChecks, hasCategory=category=>items.some(i=>i.category===category);
  if (c.guidanceStatus==='conflicting') add('question','The round records conflicting instructions. Affected compliance determinations remain unresolved.','Cite both sources, identify the affected check and request a human resolution.');
  if (checks.includes('compliance') || checks.includes('completeness')) {
    if (!c.opportunity) add('coverage_gap','The opportunity identifier and dated edition are unknown. Applicable package and compliance requirements remain unchecked.','Identify the governing opportunity and edition for this proposal.');
    if (c.guidanceStatus!=='conflicting' && (c.guidanceStatus==='missing' || !hasCategory('Opportunity guidance'))) add('coverage_gap','Applicable opportunity guidance is missing, unverified or absent from this packet. Caps, allowability and package compliance remain unchecked.','Supply the applicable opportunity text and amendments; continue independent checks.');
  }
  for (const doc of documents) {
    if (doc.requirement==='Not applicable') continue;
    if (doc.requirement==='Required' && (!doc.version || !items.some(i=>i.documentId===doc.id))) add('coverage_gap',`${doc.name}: ${doc.version ? 'no excerpt supplied; recording a version is not proof of review' : 'no version recorded'}.`,'Provide the required material or record the review limitation.',doc.id);
    if (checks.includes('completeness') && doc.requirement==='Applicability unknown') add('question',`${doc.name}: applicability remains unknown.`,'Identify the governing requirement and have Lynn confirm applicability.',doc.id);
  }
  if(c.lane==='budget') for(const category of ['Budget','Budget justification']) {
    if(!hasCategory(category) && !rows.some(r=>documents.find(d=>d.id===r.documentId)?.category===category)) add('coverage_gap',`${category} evidence is absent from this budget review.`,'Supply a matched active version or keep this reconciliation unchecked.');
  }
  if(c.lane==='package' && checks.includes('completeness') && !hasCategory('Validation report') && !rows.some(r=>documents.find(d=>d.id===r.documentId)?.category==='Validation report')) add('coverage_gap','No validation report for the tested package is supplied. Package validation remains unchecked.','Provide validation output tied to the active package and distinguish errors from warnings.');
  if(checks.includes('calculations') && ['not_checked','saved_values','formulas'].includes(c.calculationEvidence)) add('coverage_gap','Independent calculation and Excel recalculation are not recorded for this round. Saved values or formula inspection do not establish recalculated results.','Recompute supported inputs; record scope, dependencies and any separate Excel run without refreshing external links automatically.');
  for(const prior of normalizePriorFindings(priorFindings)) add('question',`Prior finding ${prior.findingId} remains ${prior.disposition}: ${prior.message}`.slice(0,1000),prior.nextAction || 'Recheck the active version and return evidence for Lynn’s decision; do not close or duplicate this issue.',null,prior.findingId);
  return normalizeFollowups(rows);
}
