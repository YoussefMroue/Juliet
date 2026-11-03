"""Explicit blank cells for Lynn's workbook, after the ordinary privacy checks."""
import re

from .case import Case, normalize
from .office import OfficeFile, Blocked, S, R, children_text, elements

SHEETS = {'project', 'tu year one'}
ADDRESS = r'\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}'
SHEET = r"(?:'(?:[^']|'')*'|[A-Za-z_][\w.]*)"
REFERENCE = re.compile(
    rf'(?<![\w.])(?:(?P<sheet>{SHEET})!)?'
    rf'(?P<area>{ADDRESS}(?::{ADDRESS})?|\$?[A-Za-z]{{1,3}}:\$?[A-Za-z]{{1,3}}|\$?[1-9][0-9]*:\$?[1-9][0-9]*)(?![\w.])')


def worksheets(book):
    for sheet in elements(book.roots['xl/workbook.xml'], S, 'sheet'):
        part = book.links['xl/workbook.xml'][sheet.getAttributeNS(R, 'id')]
        yield sheet.getAttribute('name'), part, book.roots[part]


def text_value(book, cell):
    if elements(cell, S, 'f'):
        return None  # Formula cells are never blanked.
    kind = cell.getAttribute('t')
    if kind == 'inlineStr':
        root = cell
    elif kind == 's':
        index = int(''.join(n.data for n in children_text(elements(cell, S, 'v')[0])))
        root = elements(book.roots['xl/sharedStrings.xml'], S, 'si')[index]
    else:
        return None  # Numeric and other protected cell types stay protected.
    return ''.join(n.data for t in elements(root, S, 't') for n in children_text(t))


def coordinates(address):
    match = re.fullmatch(r'([A-Z]+)([0-9]+)', address.replace('$', '').upper())
    if not match:
        raise Blocked('Invalid cell address; prepare a safe source copy.')
    return column_number(match[1]), int(match[2])


def column_number(letters):
    value = 0
    for letter in letters.upper():
        value = value * 26 + ord(letter) - ord('A') + 1
    return value


def protect_dependencies(book, plan):
    targets = [(sheet.lower(), coordinates(address)) for sheet, _, address, _ in plan]
    expressions = [(name, ''.join(n.data for n in children_text(f)))
                   for name, _, root in worksheets(book) for f in elements(root, S, 'f')]
    # A defined name may be used indirectly by another formula. Reject any that
    # includes a target, even if the current workbook does not use it yet.
    expressions += [(None, ''.join(n.data for n in children_text(f)))
                    for f in elements(book.roots['xl/workbook.xml'], S, 'definedName')]
    for current_sheet, expression in expressions:
        if re.search(rf':{SHEET}!', expression):
            raise Blocked('Blank cells cannot be checked against a cross-sheet range; prepare a safe source copy.')
        matches = list(REFERENCE.finditer(expression))
        remainder = REFERENCE.sub('', expression)
        if '!' in remainder or ':' in remainder:
            # Excel permits spaces around range operators. Until those ranges
            # are parsed completely, checking only their endpoints is unsafe.
            raise Blocked('Blank cells cannot be checked against this sheet reference or range; prepare a safe source copy.')
        for match in matches:
            sheet = match['sheet']
            sheet = sheet[1:-1].replace("''", "'") if sheet and sheet.startswith("'") else sheet
            if sheet and ':' in sheet:
                raise Blocked('Blank cells cannot be checked against a cross-sheet range; prepare a safe source copy.')
            sheet = (sheet or current_sheet or '').lower()
            area = match['area'].replace('$', '').upper()
            start, _, end = area.partition(':')
            end = end or start
            if start.isalpha() and end.isalpha():
                low, high = sorted([column_number(start), column_number(end)])
                contains = lambda col, row: low <= col <= high
            elif start.isdigit() and end.isdigit():
                low, high = sorted([int(start), int(end)])
                contains = lambda col, row: low <= row <= high
            else:
                a, b = coordinates(start), coordinates(end)
                contains = lambda col, row: min(a[0], b[0]) <= col <= max(a[0], b[0]) and min(a[1], b[1]) <= row <= max(a[1], b[1])
            if any((not sheet or sheet == target_sheet) and contains(*point) for target_sheet, point in targets):
                raise Blocked('A formula or defined name may depend on a selected blank cell; prepare a safe source copy.')


def inspect_budget(data, rules, blank_terms, project_terms=()):
    """Blank explicitly selected standalone text, never whole mixed-content cells.

    Normal replacement labels still apply to other sheets, metadata and shared
    string storage, so deleting a cell cannot leave a recoverable identifier.
    """
    rules = list(rules)
    _, pattern = normalize(rules)
    terms = {term.strip().lower() for term in blank_terms}
    if not terms or not terms <= {term.strip().lower() for term, _ in rules}:
        raise Blocked('Every Blank cell identifier must also have a neutral replacement for other occurrences.')
    aliases, blanks = normalize([(term, term) for term in terms])
    source = OfficeFile(data, 'xlsx')
    found, project_found, plan, seen_sheets = set(), set(), [], set()
    for sheet, part, root in worksheets(source):
        if sheet.lower() not in SHEETS:
            continue
        if sheet.lower() in seen_sheets:
            raise Blocked('Duplicate worksheet names; prepare a safe source copy.')
        seen_sheets.add(sheet.lower())
        seen_cells = set()
        for cell in elements(root, S, 'c'):
            address = cell.getAttribute('r')
            if address in seen_cells:
                raise Blocked('Duplicate cell addresses; prepare a safe source copy.')
            seen_cells.add(address)
            value = text_value(source, cell)
            if value is None or not blanks.search(value):
                continue
            match = blanks.fullmatch(value.strip())
            if not match:
                raise Blocked(f'{sheet}!{address} — a Blank cell identifier shares a cell with other text; prepare a safe source copy.')
            term = aliases[match.lastgroup]
            found.add(term)
            if sheet.lower() == 'project':
                project_found.add(term)
            plan.append((sheet, part, address, value))
    if seen_sheets != SHEETS:
        raise Blocked('Blank cell mode requires Project and TU Year One sheets.')
    if found != terms:
        raise Blocked('A Blank cell identifier was not found as standalone text on Project or TU Year One.')
    if not {term.strip().lower() for term in project_terms} <= project_found:
        raise Blocked('The PI name and project title must each occupy a standalone text cell on Project.')
    protect_dependencies(source, plan)
    # Keep all existing numeric, protected-field and residual checks intact.
    case = Case.__new__(Case)
    case.originals, case.files = [data], [source]
    cleared = {(part, address) for _, part, address, _ in plan}
    results, changes = case.inspect(rules, omit_replacement_cells=cleared)
    _, edited = results[0]
    for _, part, address, original in plan:
        cell, = [c for c in elements(edited.roots[part], S, 'c') if c.getAttribute('r') == address]
        for node in list(cell.childNodes):
            cell.removeChild(node)
        if cell.hasAttribute('t'):
            cell.removeAttribute('t')
        edited.dirty.add(part)
        changes.append(('Budget', edited.cell_location(part, address), original, ''))
    strings = edited.roots.get('xl/sharedStrings.xml')
    if strings and strings.documentElement.hasAttribute('count'):
        count = sum(c.getAttribute('t') == 's' for _, _, root in worksheets(edited) for c in elements(root, S, 'c'))
        strings.documentElement.setAttribute('count', str(count))
        edited.dirty.add('xl/sharedStrings.xml')
    result = edited.write()
    checked = OfficeFile(result, 'xlsx')
    checked.verify(pattern)
    return result, changes, checked
