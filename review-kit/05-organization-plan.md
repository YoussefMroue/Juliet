# Proposal organization and submission status

Design reviewed against the browser and desktop implementation on November 3, 2026. This is a local organization plan, not a new storage service or a change to access permissions.

## Retain the existing structure

Use sponsor initials, original submission date and proposal sequence as the stable ID. `NIH-2026-11-03` and `NIH-2026-11-03-02` are different proposals. Revisions retain the original ID and date. Avoid investigator names, proposal titles or findings in folder names.

Desktop projects already contain an Inbox and immutable numbered review rounds. Browser private backups follow the same round layout:

```text
NIH-2026-11-03/
  Inbox/                         Desktop intake; private originals
  Reviews/
    Round-00001/
      Review record.txt          Private provenance and export snapshot
      01 Sources/                Exact original pair
      02 Guidance/               Applicable solicitation and source evidence
      03 Redacted/               Approved pair
      04 Review/                 Intake, findings and reviewer disposition
    Round-00002/                 Revised pair; preserve earlier evidence
```

One round contains one budget/justification pair. Multiple subawards or document pairs need a separate design decision. The browser does not create an inbox on disk, import backups or maintain a project library.

## Recommended handling

1. Choose an institution-approved, restricted folder on a managed device. Confirm device encryption, approved backups, authorized readers and retention requirements with the responsible office. The app and ZIP format do not enforce these controls or encrypt archives. Do not change permissions or enable personal cloud sync for this feature.
2. Check the folder before assigning a proposal sequence. Preserve source documents unchanged. Keep revisions separate and inspect the exact pair for the next round.
3. Save a private backup only when deliberately retaining originals and provenance. Check the download destination: Downloads may be synced or shared. Move the archive to the approved location. Treat extracted copies, archives and duplicates as sensitive records under the same retention process. Ordinary deletion does not guarantee secure erasure.
4. Check the next unused round on disk. Desktop saving allocates rounds without replacing an existing round. Browser counters and locks coordinate the same origin/browser profile only. A download start does not prove a file was retained. On a new device, cleared profile or concurrent work on another device, enter the next unused round explicitly and reconcile locally; never overwrite an earlier round when extracting.
5. Put the governing solicitation, amendments, agency notices and confirmed institutional guidance in `02 Guidance`. Record publisher URL, edition, effective and retrieval dates, relevant sections, applicability and unresolved conflicts in the intake. A current web page is not a frozen record of what governed an earlier submission. Record whether ceilings cover direct or total costs, one period or the full award.
6. Keep findings, responses and reviewer disposition in `04 Review`. Record revised evidence in a new round. Submission status is an operational note, separate from redaction approval and compliance findings.
7. Hand off only the inspected, approved pair through the approved destination. `Approved-files.zip` must contain exactly `Budget.xlsx` and `Justification.docx` or `Justification.pdf`. Never send the private backup as a handoff. Redaction does not by itself authorize sharing; contextual identifiers may remain.

## Browser status behavior

After inspecting a pair, the user can select **Not set**, **Drafting**, **Ready for submission**, **Submitted** or **Withdrawn**. Every transition is manual, including correction back to Not set. Status belongs to the active proposal ID; it does not submit files or verify receipt. Inspection, redaction, approval and export never change it automatically.

Status stays in memory while the case is open, including across Proposal/Guidelines tab switches. Closing or reloading clears it. It is not stored in localStorage, sessionStorage, IndexedDB, cookies or a server; it does not sync across tabs, profiles or devices. The only saved status is a text snapshot in an explicitly requested private backup's review record. Previous backups remain unchanged. There is no backup import: re-enter status in a later session. This avoids silent persistence of additional proposal metadata. Desktop status behavior is unchanged.

The existing browser private-export counter persists the proposal ID and last round in localStorage. It is not anonymous, encrypted or an authoritative registry. Handoff-only use creates no counter. This feature adds no stored identifiers, filenames, document contents or status to browser storage. Clearing site data removes counters but not downloads.

Alternatives considered: a persistent browser case registry exposes more metadata to the profile and still lacks dependable cross-device state; a backend requires a separate authorization, retention and access design. Neither is introduced. Use the restricted folder and private records as the durable record. A future opt-in local status record can be designed after institution-specific retention and device-sharing requirements are confirmed.

## Starter guidelines and applicability

The meeting [transcript](https://app.notion.com/p/40d04d366f01809ead36c0d1b95fc470) calls for solicitation-specific ceilings, allowable costs and budget justifications plus Tulane rules supplied by the reviewer. It names NIH as an example, not a particular federal regulation. The [review kit](https://app.notion.com/p/40d04d366f0181659948e87329786515), [pilot decisions](https://app.notion.com/p/40d04d366f01811b9120d5e0bcae7b9e) and [walkthrough](https://app.notion.com/p/40d04d366f01811391b8c7dc46b9d9b4) support preserving round evidence and separating the handoff from private originals.

The tab offers three research starting points, not rules the app executes:

| Official source | Checked November 3, 2026 | Scope |
| --- | --- | --- |
| [2 CFR Part 200, Subpart E](https://www.ecfr.gov/current/title-2/subtitle-A/chapter-II/part-200/subpart-E) | Title 2 current through October 30, 2026; last amended August 17, 2026 | Cost principles; confirm applicability and exceptions under § 200.401 and agency terms. §§ 200.403–200.405 concern allowability, reasonableness and allocation. eCFR is authoritative but not the official legal edition. |
| [NIH Application Guide](https://grants.nih.gov/grants-process/write-application/how-to-apply-application-guide) | SF424 (R&R) Version I for due dates on/after January 25, 2025; general instructions updated December 2025 | Select by activity code and due date and read with the opportunity and applicable notices. |
| [NIH Develop Your Budget](https://grants.nih.gov/grants-process/write-application/advice-on-application-sections/develop-your-budget) | Living publisher page, checked on the date above | Budget and justification preparation tips; not a replacement for application instructions. No example ceiling, salary cap or rate is encoded as a rule. |

NIH's [application guidance](https://grants.nih.gov/grants-process/write-application) places NIH Guide notices ahead of opportunity-specific instructions, then general application instructions. Do not generalize this ordering to all sponsors. Record unresolved conflicts for human resolution. Confirm Tulane requirements and rates separately.

The tab states that the app does not perform compliance determinations. Displaying it and setting status make no network requests. Source links open a publisher page in a new tab only on user action, without referrer or opener access. There is no automatic guidance update service. When expanding the list, verify official sources, applicability and dates, and update the visible check date.

## Acceptance and remaining decisions

Browser tests cover keyboard tabs, a narrow phone viewport, status retention across tabs, unchanged status through inspection/export, both approval guards, snapshots in two private rounds, original-byte integrity, exactly two handoff entries, no additional browser persistence, reset/isolation for another proposal, and zero HTTP requests during offline handling. Existing Office/PDF and desktop-project tests remain required.

Pending: the fuller sponsor list, Tulane requirements and exceptions, approved storage/retention and external review destination, and whether a round needs multiple pairs. None is guessed. A phone can review the feature branch, but this feature does not synchronize cases or deploy the app.

Validation on November 3, 2026: site build and JavaScript syntax checks passed; Python discovery ran 28 tests (26 passed, two native desktop UI tests skipped because no display was available); all five browser PDF regressions passed; the offline XLSX/PDF and XLSX/DOCX workflows passed, including the assertions above. The DOCX workflow used a 390-pixel viewport. Cloudflare packaging dry run passed; no deployment was performed. npm and Wrangler needed writable cache/config paths under `/tmp`; no dependency versions were changed.
