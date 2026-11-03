# Proposal Review

A local desktop pilot for inspecting a grant budget and its written justification before manual compliance review.

**Choose two files → review identifiers → inspect changes → approve local copies → hand off manually.**

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

## Proposal and review folders

Each proposal has a short title, a unique local ID, and optional proposal reference and sponsor. Open the same project for revisions. Each approval saves a new numbered round. **Open saved round** opens its documents in the file manager.

```text
Local cases/
  P-<id>-<title>/
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

## Review a pair of files

1. Select an Excel budget (.xlsx) and Word justification (.docx) or selectable-text PDF justification (.pdf). Original files are opened read-only.
2. Inspect the **Original content and locations** tab, including hidden sheets, metadata and comments. Suggestions are local heuristics for names, email, US-style phone numbers and SSNs. Redact full names and other obvious personal identifiers, such as a personal email address, phone number or employee ID. Keep job roles, salary and effort available for review unless the specific text identifies someone. Add missed identifiers manually. Choose **Redact term** or **Keep selected** for every suggestion. Reuse the same neutral label for variants of one person. Rules match case-insensitive literal substrings (alphabetic terms of three characters or fewer match whole tokens); inspect overlaps and short terms carefully.
3. Inspect **Changes** and **Redacted content**. Select a row to read the full text. If a protected field matches, inspect the reported location. Remove a rule only if the match is genuinely harmless. Otherwise prepare a separate, safely edited source copy and start again.
4. Approve saving the round. Its **03 Redacted** folder holds Budget.xlsx and Justification.docx or Justification.pdf. The original pair is archived separately under **01 Sources**. Cancel or close before approval to discard the in-memory inspection.
5. Open the copies locally to check layout, calculations, remaining identifiers and information needed for review. Use Lynn’s approved workspace only after permission for the specific materials has been confirmed.

## Supported files

For PDFs, the export preserves page dimensions and the visible layout, renders each sanitized page at 144 dpi, and adds a verified selectable text layer. Original metadata and embedded resources are discarded. Inspect the **Redacted PDF pages** tab before approving. Scans, pages containing images or freehand drawings, interactive elements, non-horizontal text and difficult-to-verify text layouts block export with a reason.

The pilot handles ordinary text-based workbooks and Word documents. It preserves original package parts unless redaction or thumbnail removal requires a change. It checks hidden sheets, shared strings, rich text, document properties, Word comments, and headers and footers. It supports ordinary arithmetic and common numeric functions such as SUM and ROUND. Formulas with text literals, dynamic functions, or external references require source cleanup. It protects formulas, numeric cells and structural fields. Excel headers and footers containing confirmed identifiers require source cleanup. Office thumbnail previews are discarded.

Unsupported parts or features block the pair with a location. Examples include macros, images, embedded objects, external links, tracked changes, fields, legacy comment drawings, protected sheets, unsupported custom XML and scanned files. Most classic Excel notes include a legacy drawing. A workbook with those notes may require a sanitized source copy. Each input is limited to 64 MiB, compressed and expanded, and 2,000 package entries. Detection cannot establish that every identifying detail has been removed. The reviewer inspects both files.

## Review kit

- [Grant intake](review-kit/01-intake.md)
- [Reusable review instructions](review-kit/02-review-instructions.md)
- [Findings template](review-kit/03-findings.md)
- [Pilot questions, exercise answer key and acceptance](review-kit/04-pilot.md)

## Test and rehearse

Word and Excel use Python and Tk. PDF support uses the dependency listed in `requirements-pdf.txt`. For the test suite and exercise generator, install `requirements-test.txt` in a separate Python environment. Run `python -m unittest discover -v` from this folder. Run `python -m tests.exercises /path/to/new/exercises` to generate the five fictional practice cases in a new directory outside the repository. Compare a review of each case against the pilot answer key.
