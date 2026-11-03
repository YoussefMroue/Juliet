# Proposal Review

Inspect a grant budget and its justification in the private browser app or the original desktop pilot.

**Choose two files → review identifiers → inspect changes → approve local copies → hand off manually.**

## Browser app

Open **https://review.ymroue.com** and sign in. Once the app says it is ready, documents can be selected and processed offline. Choose one Excel budget and one Word or selectable-text PDF. Review the locations, choose which identifiers to replace, then inspect the approved copies. PDFs with scans, signatures, embedded objects or unsupported layouts require source cleanup.

**Download approved files** saves `Approved-files.zip` with exactly two files, `Budget.xlsx` and `Justification.docx` or `Justification.pdf`. Open both locally before handing them off to the approved reviewer.

For internal recordkeeping, expand **Private backup with original files**, confirm that the backup should include both originals, and save it in the restricted proposal folder. This separate archive contains both document pairs, the review kit and the record with source filenames. Only the private backup uses the per-project round counter. On a different device or profile, enter the appropriate next round number. Use the proposal sequence field for separate submissions from the same sponsor on the same day.

The browser entry point is `web/app.js`. Pyodide runs the Python Office inspector in the tab through `web/bridge.py`. For PDFs, `web/pdf.js` uses MuPDF to remove matched page content and builds a new document from rendered pages, selectable text and replacement labels. `web/gateway.js` verifies the sign-in token and allowed email before serving any site asset. The Worker accepts GET and HEAD only. The app has no document upload endpoint or server-side case storage.

Build with `npm ci` and `npm run build`. Run `npm run check:cloudflare` for a deployment dry run. The production gateway requires the configured Access issuer, application audience and a private `REVIEW_EMAILS` binding. Protect the custom domain with the matching Access policy. Public Workers and preview hostnames are disabled. A developer can exercise the local browser app with `node web/test.mjs <synthetic-fixture-directory> <temporary-output-directory>` after installing Playwright Chromium, or set `PLAYWRIGHT_CHANNEL=chrome` to use an installed Chrome. The ZIP checks use Python 3 (`PYTHON` can specify the executable). The input directory must contain the fictional input.xlsx and input.docx from tests/exercises.py and input.pdf from tests/test_pdf.py.

### Submission status and guidelines

After inspecting a pair, set its **Submission status** yourself. It is separate from redaction approval, compliance and sponsor receipt. It stays only in the open case and clears on close/reload; it does not sync to another tab or device. An explicitly requested private backup includes a status snapshot in `Review record.txt`. The two-file handoff never includes status. The existing private-round counter still stores the proposal ID and last round in this browser profile.

The **Guidelines** tab offers three official reference links for manual review, with check dates and applicability notes. The app does not apply them as automated compliance rules. The list works offline; opening a link visits the publisher in a new tab. Supply each proposal's solicitation, amendments, relevant notices and confirmed Tulane requirements separately.

See the [secure organization plan](review-kit/05-organization-plan.md) for the proposed local workflow, source research and remaining decisions. This feature adds no backend or automatic document storage.

## Windows 11 pilot

Clone the repository into a local folder on Lynn’s Windows 11 desktop. From the cloned folder, use her approved Python 3.10 or newer with Tk. In PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-pdf.txt
.\.venv\Scripts\python.exe -m proposal_review
```

For future launches, use the last command. Create or select a proposal in the app. **Open project inbox** opens its local drop folder. All project records live under `Local cases` inside the clone and are excluded from Git. The app works offline after setup. The external review workspace still needs confirmation before handoff.

**Optional executable build.** Use an approved Windows build computer with an interactive desktop and a Tk-enabled Python 3.12 matching the target architecture. From the repository root in PowerShell, use a project-local environment:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-test.txt PyInstaller==6.22.3
.\.venv\Scripts\python.exe windows/build.py
```

The builder runs the tests, including the desktop workflow, before creating the self-contained folder in `dist/Proposal Review`. Keep the entire folder together. On a representative Windows 11 machine, run the packaged executable as a standard user and complete the included practice run in Excel and Word. Apply the company’s signing and distribution requirements once confirmed. [Windows build requirements](https://pyinstaller.org/en/stable/index.html)

For development with an existing Python and Tk installation, run `py -3 -m proposal_review` on Windows or `python3 -m proposal_review` on macOS or Linux.

## Desktop proposal and review folders

Enter the sponsor initials and the original submission date. For example, NIH and November 3, 2026 create **NIH-2026-11-03**. A second proposal from NIH on that date gets **NIH-2026-11-03-02**. An optional title helps distinguish them in the picker. Open the same project for revisions. Each approval saves a new numbered round. **Open saved round** opens its documents in the file manager.

```text
Local cases/
  NIH-2026-11-03/
    Inbox/
    Reviews/
      Round-00001/
        Review record.txt       Proposal, approval time and original filenames
        01 Sources/             Exact local copies of the inputs inspected
        02 Guidance/            Put the solicitation, amendments and rules here
        03 Redacted/            Approved budget and justification for handoff
        04 Review/              Intake, review instructions and findings for this round
      Round-00002/
```

Keep reviewer edits, responses and the final disposition in that round’s **04 Review** folder. Open the next round for a revised submission. A canceled inspection creates no round.

## Review a pair of files in the desktop pilot

1. Select an Excel budget (.xlsx) and Word justification (.docx) or selectable-text PDF justification (.pdf). Original files are opened read-only.
2. Inspect the **Original content and locations** tab, including hidden sheets, metadata and comments. Suggestions are local heuristics for names, email, US-style phone numbers and SSNs. Redact full names and other obvious personal identifiers, such as a personal email address, phone number or employee ID. Keep job roles, salary and effort available for review unless the specific text identifies someone. Add missed identifiers manually. Choose **Redact term** or **Keep selected** for every suggestion. Reuse the same neutral label for variants of one person. Rules match case-insensitive literal substrings (alphabetic terms of three characters or fewer match whole tokens); inspect overlaps and short terms carefully.
3. Inspect **Changes** and **Redacted content**. Select a row to read the full text. If a protected field matches, inspect the reported location. Remove a rule only if the match is genuinely harmless. Otherwise prepare a separate, safely edited source copy and start again.
4. Approve saving the round. Its **03 Redacted** folder holds Budget.xlsx and Justification.docx or Justification.pdf. The original pair is archived separately under **01 Sources**. Cancel or close before approval to discard the in-memory inspection.
5. Open the copies locally to check layout, calculations, remaining identifiers and information needed for review. Use Lynn’s approved workspace only after permission for the specific materials has been confirmed.

## Supported files

For PDFs, the export preserves page dimensions and the visible layout, renders each sanitized page at 144 dpi, and adds a verified selectable text layer. Original metadata and embedded resources are discarded. Inspect the **Redacted PDF pages** tab before approving. Use horizontal selectable text in standard, unembedded Helvetica, Courier or Times fonts. A page may include one simple horizontal divider. Drawings (including IDs made of strokes), symbol-art rows, images, custom fonts or mappings, and interactive content require a cleaned source. If a PDF is blocked, use the original Word justification when it is available.

The pilot handles ordinary text-based workbooks and Word documents. It preserves original package parts unless redaction or thumbnail removal requires a change. It checks hidden sheets, shared strings, rich text, document properties, Word comments, and headers and footers. It supports ordinary arithmetic and common numeric functions such as SUM and ROUND. Defined names must refer to a local cell or range. Named expressions, conditional or validation formulas, external references and custom formats that can disguise identifiers require source cleanup. Use an approved source copy to remove the sensitive value or replace unsupported formulas with verified values. It protects formulas, numeric cells and structural fields. Excel headers and footers containing confirmed identifiers require source cleanup. Office thumbnail previews are discarded.

Unsupported parts or features block the pair with a location. Examples include macros, images, embedded objects, external links, tracked changes, fields, legacy comment drawings, protected sheets, unsupported custom XML and scanned files. Most classic Excel notes include a legacy drawing. A workbook with those notes may require a sanitized source copy. Each input is limited to 64 MiB, compressed and expanded, and 2,000 package entries. Detection cannot establish that every identifying detail has been removed. The reviewer inspects both files.

## Review kit

- [Grant intake](review-kit/01-intake.md)
- [Reusable review instructions](review-kit/02-review-instructions.md)
- [Findings template](review-kit/03-findings.md)
- [Pilot questions, exercise answer key and acceptance](review-kit/04-pilot.md)
- [Proposal organization plan and submission status](review-kit/05-organization-plan.md)

## Test and rehearse

Word and Excel use Python and Tk. PDF support uses the dependency listed in `requirements-pdf.txt`. For the test suite and exercise generator, install `requirements-test.txt` in a separate Python environment. Run `python -m unittest discover -v` from this folder. For the browser PDF regressions, run `npm run build` followed by `node --test web/pdf.test.mjs`. Run `python -m tests.exercises /path/to/new/exercises` to generate the five fictional practice cases in a new directory outside the repository. Compare a review of each case against the pilot answer key.
