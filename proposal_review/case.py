"""A review session keeps originals, rules and inspected copies in memory."""
import re
import shutil
import tempfile
from collections import Counter
from pathlib import Path

from .office import Blocked, LIMIT, OfficeFile
from .pdf import PdfFile

CANDIDATES = [
    ('Email', re.compile(r'[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}')),
    ('ID', re.compile(r'\b\d{3}-\d{2}-\d{4}\b')),
    ('Phone', re.compile(r'(?<!\d)(?:\+1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)')),
    ('Person', re.compile(r'\b(?:Dr\.\s+)?[A-Z][a-z\'’-]+(?: [A-Z][a-z\'’-]+){1,2}\b')),
]


def candidate_terms(files):
    found = {}
    counts = Counter()
    for office in files:
        for _, field in office.fields:
            for kind, pattern in CANDIDATES:
                for m in pattern.finditer(field.value):
                    term = m.group()
                    if term.lower() not in found:
                        counts[kind] += 1
                        found[term.lower()] = (term, f'{kind} {counts[kind]:02}')
    return list(found.values())


def normalize(rules):
    aliases = {}
    for term, label in rules:
        term, label = term.strip(), label.strip()
        if not term or not label:
            raise Blocked('Enter both an identifier and a neutral replacement.')
        if term.lower() in aliases and aliases[term.lower()] != label:
            raise Blocked('One identifier has two different replacements.')
        aliases[term.lower()] = label
    # Longest first handles a full name and its separately entered surname.
    labels = {}
    alternatives = []
    for index, term in enumerate(sorted(aliases, key=len, reverse=True)):
        literal = re.escape(term)
        if term.isalpha() and len(term) <= 3:
            literal = r'(?<!\w)' + literal + r'(?!\w)'
        group = f'term{index}'
        labels[group] = aliases[term]
        alternatives.append(f'(?P<{group}>{literal})')
    return labels, re.compile('|'.join(alternatives), re.I) if alternatives else None


class Case:
    def __init__(self, budget, justification):
        self.files = []
        self.originals = []
        self.filenames = []
        justification = Path(justification)
        kind = 'pdf' if justification.suffix.lower() == '.pdf' else 'docx'
        for path, kind in [(Path(budget),'xlsx'), (justification,kind)]:
            if path.suffix.lower() != '.'+kind:
                raise Blocked(f'Expected a .{kind} file.')
            with path.open('rb') as source:
                data = source.read(LIMIT+1)
            self.files.append(PdfFile(data) if kind == 'pdf' else OfficeFile(data, kind))
            self.originals.append(data)
            self.filenames.append(path.name)

    def inspect(self, rules):
        aliases, pattern = normalize(rules)
        results = []
        changes = []
        for original, source in zip(self.originals, self.files):
            if source.kind == 'pdf':
                result, edits = source.inspect(original, aliases, pattern)
                results.append(result)
                changes.extend(edits)
                continue
            copy = OfficeFile(original, source.kind)
            for part, field in copy.fields:
                before = field.value
                matches = list(pattern.finditer(before)) if pattern else []
                if not matches:
                    continue
                if not field.editable:
                    copy.stop(field.location+' — match in a formula, value or protected field. Prepare a safe source copy.')
                field.replace(matches, aliases)
                copy.dirty.add(part)
                changes.append((copy.label, field.location, before, field.value))
            result = copy.write()
            checked = OfficeFile(result, copy.kind)
            checked.verify(pattern)
            results.append((result, checked))
        return results, changes


def export_pair(folder, results):
    """An exclusively created directory protects existing exports and originals."""
    if [office.kind for _, office in results] not in (['xlsx','docx'], ['xlsx','pdf']):
        raise Blocked('Inspect both files before export.')
    dest = Path(tempfile.mkdtemp(prefix='review-', dir=folder))
    try:
        for name, (data, _) in zip(('Budget.xlsx','Justification.'+results[1][1].kind), results):
            with (dest/name).open('xb') as f:
                f.write(data)
    except BaseException:
        shutil.rmtree(dest)
        raise
    return dest
