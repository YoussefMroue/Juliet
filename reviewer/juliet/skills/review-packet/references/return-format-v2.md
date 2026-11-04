# Findings file for release 0.2.0

Use this format only for `juliet.packet.v2` with reviewerRelease `0.2.0`. For a v1 packet use [the legacy format](return-format-v1.md) unchanged.

Return one JSON code block for Lynn to save as a UTF-8 `.json` file and import locally. Use exactly these top-level keys and copy all identity values and the digest from the packet:

```json
{
  "format": "juliet.findings.v2",
  "reviewerRelease": "0.2.0",
  "proposalId": "<copy from packet>",
  "roundId": "<copy from packet>",
  "packetId": "<copy from packet>",
  "reportId": "<copy from packet>",
  "digest": "<copy from packet>",
  "coverage": {"reviewed": [], "unreviewed": []},
  "findings": []
}
```

Put every supplied item ID in exactly one coverage list. `reviewed` means the excerpt was considered; it does not certify the whole document or every requested check. Unreadable or withheld excerpts require a coverage_gap finding. Missing documents have no item ID: never invent an excerpt or quotation for them.

Return at most 120 findings. Each finding has exactly these fields:

```json
{
  "type": "coverage_gap",
  "message": "The governing opportunity was not supplied, so the affected compliance checks remain unchecked.",
  "evidence": [],
  "guidance": [],
  "gapIds": ["<copy the applicable G ID>"],
  "priorFindingId": null,
  "owner": "<supplied responsible role, or empty string if unknown>",
  "nextAction": "Supply the applicable opportunity edition and amendments for the next review.",
  "calculation": ""
}
```

| Field | Contract |
| --- | --- |
| type | `objective_error`, `question`, `suggestion` or `coverage_gap`. |
| message | 1–1,000 characters; name the issue, affected check and supported impact. |
| evidence, guidance | Arrays with at most six citations each. Each citation contains exactly `itemId` and `quote`. Copy 1–300 characters exactly from a reviewed item's text. Guidance must come from `Opportunity guidance` or `Institutional guidance` items. |
| gapIds | Unique IDs copied from requiredFollowups, or an empty array for an additional finding. Never invent a gap ID. |
| priorFindingId | `null` for a new issue; otherwise copy the exact stable findingId from priorFindings. Link a prior issue only once and include its corresponding requiredFollowups ID. |
| owner | Supplied responsible role, at most 100 characters; empty string when unknown. Do not invent a person or assign institutional authority. |
| nextAction | 1–300 characters. State the requested correction, missing input or human decision. |
| calculation | Empty string unless numerical reasoning is needed; otherwise at most 500 characters showing cited inputs, operation, result, reported value and difference. This is a reasoning explanation, not evidence of an Excel run. |

Every requiredFollowups entry must be represented in findings. Ordinary followups require the specified `question` or `coverage_gap` type. A followup with a priorFindingId can use any justified finding type, but its G ID and priorFindingId must occur together. Combine related gaps only when the same finding type and next action accurately describe them. Do not combine distinct prior issues. Empty findings are appropriate only when there are no mandatory followups, no unreviewed items and no additional supported findings.

An objective error needs proposal evidence and either applicable governing guidance, two distinct proposal locations or an explicit arithmetic calculation. The arithmetic route is only for reproducible mathematics using the cited inputs; it does not authorize an unsupported policy conclusion. When only conflicting documents establish a mismatch, say which values disagree without deciding which is authoritative. A suggestion needs proposal evidence and must be labeled as judgment. Questions and coverage gaps can have no citations when the needed evidence is absent.

The local importer assigns new stable finding IDs and preserves linked prior IDs. Do not add `id`, verification, disposition, status, submitted, approval or other fields to the returned JSON. Import checks identity and exact quotations; Lynn still checks whether the quotation supports the reasoning and whether the action is appropriate.
