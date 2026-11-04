// A checklist records the user's intended checks; it is not governing guidance.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CHECK_RESULTS = [
  ['checked', 'Checked within scope'], ['missing', 'Missing'], ['unchecked', 'Unchecked'],
  ['decision_needed', 'Decision needed'], ['not_applicable', 'Not applicable']
];
function requireValue(ok, message) { if (!ok) throw Error(message); }
function text(value, max, required=false) {
  requireValue(typeof value==='string' && value.length<=max && (!required || value.trim()), 'Check checklist text and limits.');
  return value.trim();
}
export function normalizeChecklist(rows, documents) {
  requireValue(Array.isArray(rows) && rows.length>0 && rows.length<=300, 'Confirm between one and 300 checklist checks for this round.');
  const seen=new Set();
  return rows.map(row=>{
    const fields=['checkId','label','applicability','basis','sourceDocumentIds','documentIds','owner','nextAction'];
    requireValue(row && Object.keys(row).length===fields.length && fields.every(k=>Object.hasOwn(row,k)), 'Checklist fields do not match the expected format.');
    requireValue(UUID.test(row.checkId) && !seen.has(row.checkId), 'A checklist identity is invalid or duplicated.');
    seen.add(row.checkId);
    requireValue(['required','optional','unknown','not_applicable'].includes(row.applicability), 'Choose checklist applicability.');
    function dependencies(values, guidance) {
      requireValue(Array.isArray(values) && values.length<=6 && new Set(values).size===values.length, 'A check supports up to six distinct documents per evidence field.');
      return values.map(id=>{
        const doc=documents.find(d=>d.id===id);
        requireValue(UUID.test(id) && doc && (!guidance || ['Opportunity guidance','Institutional guidance'].includes(doc.category)), 'A checklist dependency refers to a foreign document or non-guidance source.');
        return id;
      });
    }
    return {checkId:row.checkId,label:text(row.label,300,true),applicability:row.applicability,
      basis:text(row.basis,500,row.applicability==='not_applicable'),
      sourceDocumentIds:dependencies(row.sourceDocumentIds,true),documentIds:dependencies(row.documentIds,false),
      owner:text(row.owner,100),nextAction:text(row.nextAction,300)};
  });
}
