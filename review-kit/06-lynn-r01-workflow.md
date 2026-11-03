# Lynn's NIH R01 review workflow

Source: [November 3 meeting](https://app.notion.com/p/40d04d366f0181d0811cdd01ffb63ace) and its [underlying transcript](https://app.notion.com/p/40d04d366f018143915ce6753cb1782d), rechecked November 3, 2026. Sync State now says Complete. The visible transcript is still short relative to the listed 32.3-minute recording; the status alone does not establish full transcript coverage. This change implements only the visible process.

## Implemented browser behavior

After reading a pair, select **Use Lynn’s NIH R01 checklist for this case**. The general workflow remains available for other proposals. The checklist is optional and selected by the user, never inferred from sponsor initials or document contents.

The app shows extracted text and actual locations from Project and TU Year One without assuming cell addresses, salaries, rates or calculations. The checklist requires both named sheets (case-insensitive) and displays a clear message if either is absent. It does not guess a substitute sheet or silently claim that a different template was checked.

Before creating any redacted preview in this mode, the reviewer confirms the Cayuse pair and record check, gathering the applicable opportunity guidance, and verifying all salaries in Waveworks. The last name is the transcript's spelling and has not been independently confirmed. There are no system integrations, credential prompts, external calls or automated salary comparisons.

The reviewer enters the complete Project PI name and project title. Both must match standalone text cells on Project and have explicit **Blank cell** rules. A substring such as `ir` in `Mira Example` does not qualify. **Add PI and project title to redactions** selects Blank cell and supplies labels for occurrences elsewhere. These are manual selections, not automatic entity recognition. Variants need their own rules. Titles are explicitly requested because the name suggestions cannot reliably identify them.

The reviewer confirms that every personnel name on TU Year One has a **Blank cell** rule. This is a human assertion, not an automated completeness test. Editing rules or the PI/title entries clears that confirmation; changing any checklist input invalidates the preview and approvals. No preview is produced until the applicable checks pass. Submission status stays independent.

The meeting says to delete workbook identifiers. **Blank cell** now removes the contents and text type of each matching standalone cell on Project and TU Year One, retaining its coordinates and cell-level style. The result is a genuinely empty Excel cell, not a label or a formula returning an empty string. The change list explicitly shows `[blank cell]`. Rich-text and shared-string cells are supported; other references to a shared string and unused string storage are still sanitized by the ordinary redactor. Other sheets, metadata and the justification keep neutral replacements so identifying text does not survive elsewhere.

Blanking is explicit and limited to the two named worksheets. A selected term must occupy the whole text cell (apart from surrounding whitespace), using the same literal matching rules as redaction. Mixed-content cells are blocked instead of erasing their roles or other text. A formula or defined name that may depend on a cell being cleared also blocks the preview; ambiguous cross-sheet references require cleanup. Numeric cells and formulas are never selected for blanking, and the existing numeric-identifier and protected-field checks still run. If a real template mixes a name with a role, a reviewer must prepare a separate safe source copy before retrying; the app does not infer which surrounding content is disposable.

Salary confirmation precedes creation of either redacted file. Originals remain unchanged, and salaries are not auto-corrected. The broader Redact action still uses labels; Blank cell cannot be exported after disabling the checklist without explicitly changing those decisions.

## Privacy and evidence

Checklist values and typed identifiers stay in this case's memory and clear on close/reload. A separate explicit private backup adds a generic checklist-completion statement to its review record; it does not separately list entered PI/title values or salary data. Original documents in that backup retain the existing explicit opt-in. The handoff archive still contains exactly two redacted documents. No original documents, metadata or verification evidence are uploaded. Feedback remains a static mailto link with no case data.

The checklist is a workflow aid, not a security boundary: users can explicitly switch to the general workflow, which invalidates prior previews. No new federal rule or claim of compliance is introduced. Access settings and the desktop implementation remain unchanged; the shared intake template now includes the human checklist for desktop/manual use.

## Open questions

- Any requirements absent from the short visible transcript, despite the completed sync status.
- Confirm the salary system's name and what evidence or exceptions the salary check requires.
- Whether other workbook templates, year sheets, multiple PIs or multiple pairs need a variant of this checklist.
- Whether real templates have mixed-content name cells or formula dependencies requiring a separately reviewed adaptation.

No merge or deployment is part of this change.

Dependency checks reject quoted as well as unquoted 3-D sheet ranges (for example, `SUM('Project:TU Year One'!C3)`) before blanking. These references require a separately reviewed source copy.

## Validation

On November 3, 2026, the site build, Cloudflare packaging dry run, JavaScript syntax checks and whitespace checks passed. The fictional NIH R01 workflow passed in Chromium at 1280px and 390px widths, including blocked previews for incomplete checks, unselected identifiers and short substring inputs; actual exported blank PI/title/personnel cells; independently reopened Office files; preserved salary cells/formulas and original bytes; checklist reset; private-only completion snapshots; and zero HTTP requests while handling the case. The existing XLSX/PDF and XLSX/DOCX offline workflows also passed, including missing-sheet handling, the two-file handoff and opt-in private backup. All five PDF regressions and 37 Python tests passed; two native desktop UI tests were skipped because the environment has no display. Python coverage includes shared/rich text, hidden target sheets, mixed-content rejection, formula dependencies and numeric protections. Real Cayuse/Waveworks access, real proposal templates and the remaining recording are not verified by these tests.
