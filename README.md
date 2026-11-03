# Proposal Review

A local desktop pilot for inspecting a grant budget and its written justification before manual compliance review.

**Choose two files → review identifiers → inspect changes → approve local copies → hand off manually.**

## Run

Open **Proposal Review.pyw** with a Tk-enabled Python installation, or launch from this folder. Run `python3 -m proposal_review` on macOS or Linux, or `py -3 -m proposal_review` on Windows. Use Python 3.9 or later with Tk support. Run `python3 -m tkinter` (Windows: `py -3 -m tkinter`) to check the desktop runtime. The app uses only the Python standard library. An installer target will be selected once Lynn confirms her operating system.

1. Select an Excel budget (.xlsx) and Word justification (.docx). Original files are opened read-only.
2. Inspect the **Original content and locations** tab, including hidden sheets, metadata and comments. Suggestions are local heuristics for names, email, US-style phone numbers and SSNs. Add missed identifiers manually, including initials, single names, IDs and aliases. Remove false suggestions. Reuse the same neutral label for variants of one person. Rules match case-insensitive literal substrings (alphabetic terms of three characters or fewer match whole tokens); inspect overlaps and short terms carefully.
3. Inspect **Changes** and **Redacted content**. Select a row to read the full text. If a protected field matches, inspect the reported location. Remove a rule only if the match is genuinely harmless. Otherwise prepare a separate, safely edited source copy and start again.
4. Approve the inspected pair and select a destination. Each export creates a new folder containing Budget.xlsx and Justification.docx. Case data stays in memory until export. Cancel or close the app to discard the session. The app creates no case logs or intermediate files.
5. Open the copies locally to check layout, calculations, remaining identifiers and information needed for review. Use Lynn’s approved workspace only after permission for the specific materials has been confirmed.

## Supported files

The pilot handles ordinary text-based workbooks and Word documents. It preserves original package parts unless redaction or thumbnail removal requires a change. It checks hidden sheets, shared strings, rich text, document properties, Word comments, and headers and footers. It supports ordinary arithmetic and common numeric functions such as SUM and ROUND. Formulas with text literals, dynamic functions, or external references require source cleanup. It protects formulas, numeric cells and structural fields. Excel headers and footers containing confirmed identifiers require source cleanup. Office thumbnail previews are discarded.

Unsupported parts or features block the pair with a location. Examples include macros, images, embedded objects, external links, tracked changes, fields, legacy comment drawings, protected sheets, unsupported custom XML and scanned files. Most classic Excel notes include a legacy drawing. A workbook with those notes may require a sanitized source copy. Each input is limited to 64 MiB, compressed and expanded, and 2,000 package entries. Detection cannot establish that every identifying detail has been removed. The reviewer inspects both files.

## Review kit

- [Grant intake](review-kit/01-intake.md)
- [Reusable review instructions](review-kit/02-review-instructions.md)
- [Findings template](review-kit/03-findings.md)
- [Questions for Lynn, exercise answer key and pilot acceptance](review-kit/04-pilot.md)

## Test and rehearse

The app has no runtime dependencies beyond Python and Tk. For the test suite and exercise generator, install `requirements-test.txt` in a separate Python environment. Run `python -m unittest discover -v` from this folder. Run `python -m tests.exercises /path/to/new/exercises` to generate the five fictional practice cases in a new directory outside the repository. Compare a review of each case against the pilot answer key.
