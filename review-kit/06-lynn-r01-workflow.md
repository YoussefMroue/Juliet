# Lynn's NIH R01 review workflow

Source: [November 3 meeting](https://app.notion.com/p/40d04d366f0181d0811cdd01ffb63ace) and its [underlying transcript](https://app.notion.com/p/40d04d366f018143915ce6753cb1782d), read November 3, 2026. The recording is listed as 32.3 minutes, but the visible transcript is short and Sync State is Pending. This change implements only the visible process; it does not claim to cover the full recording.

## Implemented browser behavior

After reading a pair, select **Use Lynn’s NIH R01 checklist for this case**. The general workflow remains available for other proposals. The checklist is optional and selected by the user, never inferred from sponsor initials or document contents.

The app shows extracted text and actual locations from Project and TU Year One without assuming cell addresses, salaries, rates or calculations. The checklist requires both named sheets (case-insensitive) and displays a clear message if either is absent. It does not guess a substitute sheet or silently claim that a different template was checked.

Before creating any redacted preview in this mode, the reviewer confirms the Cayuse pair and record check, gathering the applicable opportunity guidance, and verifying all salaries in Waveworks. The last name is the transcript's spelling and has not been independently confirmed. There are no system integrations, credential prompts, external calls or automated salary comparisons.

The reviewer enters the Project PI name and project title. Both must be present in the extracted Project content and have explicit Redact rules. **Add PI and project title to redactions** reuses an existing rule where possible and supplies neutral labels for new rules. These are manual selections, not automatic entity recognition. Identical text is replaced throughout the inspected pair using the existing redactor. Variants need their own rules. Titles are explicitly requested because the existing name suggestions cannot reliably identify them.

The reviewer confirms that every personnel name on TU Year One has a redaction rule. This is a human assertion, not an automated completeness test. Editing rules or the PI/title entries clears that confirmation; changing any checklist input invalidates the preview and approvals. No preview is produced until the applicable checks pass. Submission status stays independent.

The meeting says to delete identifiers. This implementation uses the app's established neutral replacements on derived copies, preserving roles, salary values, formulas and original bytes. It also waits for salary confirmation before redacting either file, a conservative implementation of verifying salaries before personnel names are removed. It does not edit originals or auto-correct salaries. If literal blank cells are required, confirm that separately rather than silently changing the redactor.

## Privacy and evidence

Checklist values and typed identifiers stay in this case's memory and clear on close/reload. A separate explicit private backup adds a generic checklist-completion statement to its review record; it does not separately list entered PI/title values or salary data. Original documents in that backup retain the existing explicit opt-in. The handoff archive still contains exactly two redacted documents. No original documents, metadata or verification evidence are uploaded. Feedback remains a static mailto link with no case data.

The checklist is a workflow aid, not a security boundary: users can explicitly switch to the general workflow, which invalidates prior previews. No new federal rule or claim of compliance is introduced. Access settings and the desktop implementation remain unchanged; the shared intake template now includes the human checklist for desktop/manual use.

## Open questions

- Remaining requirements from the recording after transcription/sync completes.
- Confirm the salary system's name and what evidence or exceptions the salary check requires.
- Whether other workbook templates, year sheets, multiple PIs or multiple pairs need a variant of this checklist.
- Whether neutral replacement labels are sufficient or specific blank cells are required.

No merge or deployment is part of this change.

## Validation

On November 3, 2026, the site build, JavaScript syntax checks and whitespace checks passed. The new fictional NIH R01 workflow passed in Chromium at 1280px and 390px widths, including blocked previews for incomplete checks or unselected identifiers, actual exported PI/title/personnel removal, independently reopened Office files, preserved salary cells/formulas and original bytes, checklist reset, private-only completion snapshots and zero HTTP requests while handling the case. The existing XLSX/PDF and XLSX/DOCX offline workflows also passed, including missing-sheet handling, the two-file handoff and opt-in private backup. All five PDF regressions and 26 Python tests passed; two native desktop UI tests were skipped because the environment has no display. Real Cayuse/Waveworks access and the remaining recording are not verified by these tests.
