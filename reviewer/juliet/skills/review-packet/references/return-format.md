# Findings file for release 1.0.0

Use this contract for `juliet.packet.v3` with reviewerRelease `1.0.0`. Preserve older packet identities using [v1](return-format-v1.md) or [v2](return-format-v2.md). Return one JSON code block, with exactly the following top-level keys. Copy identity values and both digests from the packet; numbers remain numbers.

```json
{
  "format": "juliet.findings.v3",
  "reviewerRelease": "1.0.0",
  "proposalId": "<copy>",
  "roundId": "<copy>",
  "packetId": "<copy>",
  "reportId": "<copy>",
  "digest": "<copy>",
  "packetSetId": "<copy>",
  "batchId": "<copy>",
  "batchIndex": 1,
  "batchCount": 1,
  "manifestDigest": "<copy>",
  "coverage": {"reviewed": [], "unreviewed": []},
  "findings": [],
  "checkResults": []
}
```

Every item ID occurs exactly once across coverage.reviewed and coverage.unreviewed. Reviewed means the selected evidence was considered, not that every requested check passed. An unreviewed item requires a coverage_gap finding. Missing files have no item ID; never invent a quotation.

## Findings

Return at most 120 findings. Each has exactly these fields:

```json
{
  "type": "coverage_gap",
  "message": "The applicable indirect-cost agreement was not supplied; the base remains unchecked.",
  "evidence": [],
  "guidance": [],
  "gapIds": [],
  "priorFindingId": null,
  "owner": "",
  "nextAction": "Supply the applicable dated agreement and base exclusions.",
  "calculation": ""
}
```

| Field | Contract |
| --- | --- |
| type | objective_error, question, coverage_gap or suggestion. Suggestions are cited judgment-based process observations, never drafting, scientific or wording improvements. |
| message | 1–1,000 characters; supported issue, affected check and impact. |
| evidence, guidance | Up to six citations each. Each citation has exactly itemId and quote. Quote 1–300 characters copied exactly from a reviewed item's text. Guidance must be an Opportunity guidance or Institutional guidance item. |
| gapIds | Unique IDs copied from this batch's requiredFollowups, or [] for an additional issue. |
| priorFindingId | null for a new issue; otherwise the exact prior findingId. Carry each prior issue once, linked to its corresponding gap ID. |
| owner | Supplied role, up to 100 characters, or empty string when unknown. |
| nextAction | 1–300 characters; correction, missing input or human decision. |
| calculation | Empty string or up to 500 characters explaining cited inputs, operation, result and discrepancy. Never evidence of workbook execution. |

Every requiredFollowups entry must occur in findings. An ordinary gap requires its specified type. A gap linked to a priorFindingId may use any justified type but must carry both that prior ID and gap ID. Combine related gaps when their type and next action match: one absent opportunity can carry several G IDs in one coverage_gap finding. Keep distinct documents or different corrective actions separate; do not combine distinct prior findings. Preserve remaining dependencies after partial correction.

An objective error needs proposal evidence and applicable governing guidance, two distinct proposal locations, or a reproducible arithmetic calculation. The arithmetic alternative does not support a policy conclusion. Conflicting documents establish a mismatch, not which is right. A suggestion requires proposal evidence and explicit judgment. Questions and coverage gaps may lack citations when the evidence is absent.

## Checklist results

Return every assignedCheckIds entry exactly once; do not return checks assigned to another batch. Each result has exactly:

```json
{
  "checkId": "<copy assigned check ID>",
  "status": "unchecked",
  "message": "The base could not be checked without the applicable agreement.",
  "evidence": [],
  "guidance": [],
  "findingRefs": ["F1"]
}
```

- status: checked, missing, unchecked, decision_needed or not_applicable. Use the readable labels Checked within scope, Missing, Unchecked, Decision needed and Not applicable in the summary.
- message: 1–1,000 characters describing the scope actually checked and limitations.
- evidence/guidance: exact citations in the same shape as findings. Cite only this check's declared documentIds/sourceDocumentIds, respectively.
- findingRefs: unique report-local references F1, F2, etc., meaning positions in the findings array, up to 120. These are not item IDs or stable historical IDs. Multiple rows may reference the same finding. For a prior issue, its finding still occupies an F position in this report.
- checked requires known applicable scope, cited proposal evidence for every document dependency, and cited guidance for every source dependency. Source-dependent checks cannot be checked while guidance is missing/conflicting. Checked can link to an error: it means the examination occurred, not a clean pass.
- missing, unchecked and decision_needed each require at least one finding reference explaining the limitation or decision. A held check is unchecked. Unknown applicability remains decision_needed.
- not_applicable requires the frozen not_applicable decision and nonempty basis; do not infer it independently.

The importer assigns stable finding IDs. Do not add id, verification, disposition, status-change, approval or submission fields. Local validation checks identity and quotations, not whether the reasoning is sound. Lynn decides findings and closeout after inspecting the active files.
