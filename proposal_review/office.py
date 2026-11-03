"""Local, in-memory inspection of a deliberately limited set of Office packages."""
import io
import posixpath
import re
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
from xml.dom import Node, minidom
from xml.parsers.expat import ExpatError

S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PR = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
LIMIT = 64 * 1024 * 1024
COMMON = r'(?:\[Content_Types\]\.xml|_rels/\.rels|docProps/(?:app|core)\.xml)'
EXCEL = (r'xl/(?:workbook|styles|sharedStrings|theme/theme\d+|worksheets/sheet\d+|'
         r'(?:comments/)?comment[s]?\d+)\.xml|xl/(?:_rels/workbook|worksheets/_rels/sheet\d+)\.xml\.rels')
WORD = (r'word/(?:document|settings|styles|stylesWithEffects|numbering|fontTable|webSettings|'
        r'header\d+|footer\d+|comments|footnotes|endnotes|theme/theme\d+)\.xml|'
        r'customXml/(?:item1|itemProps1)\.xml|customXml/_rels/item1\.xml\.rels|'
        r'word/_rels/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml\.rels')
OFFICE_TYPES = {'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
                'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'}
# Restrict custom formats to ordinary budget amounts. Other masks can display an
# identifier assembled from digits and literals that never appear together in XML.
BUDGET_FORMAT = re.compile(r'(?:[$€£]|"[$€£]")?(?:#,##0|0)(?:\.0{1,6})?%?')
BUILTIN_FORMAT_IDS = {str(i) for i in (*range(23), *range(37, 50))}
# These display dates, times, fractions or exponents. Excel's locale and
# calendar settings can change the result independently of the stored number.
UNMODELLED_FORMAT_IDS = {str(i) for i in (*range(11, 23), *range(45, 49))}
CELL_REF = r'\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}'
LOCAL_RANGE = re.compile(rf'{CELL_REF}(?::{CELL_REF})?')
SHEET_REF = re.compile(r"""(?:[A-Za-z_][\w.]*|'(?:[^'\[\]:*?/\\\x00-\x1f]|'')+')""")
# These features can contain independent renderings, hidden text, or identifiers
# assembled at display time. Never silently flatten them.
UNSUPPORTED = set(('AlternateContent altChunk drawing pict object fldSimple fldChar instrText '
                   'delText ins del moveFrom moveTo sdt customXml extLst rPh sheetProtection '
                   'workbookProtection externalReference oleObject control legacyDrawing '
                   'smartTag subDoc binData graphic graphicData txbxContent hyperlink '
                   'dataBinding attachedTemplate docVars mailMerge saveThroughXslt').split())


class Blocked(ValueError):
    pass


def elements(root, ns, tag):
    return list(root.getElementsByTagNameNS(ns, tag))


def children_text(el):
    return [n for n in el.childNodes if n.nodeType in (Node.TEXT_NODE, Node.CDATA_SECTION_NODE)]


def descendants_text(el):
    nodes = []
    for child in el.childNodes:
        if child.nodeType in (Node.TEXT_NODE, Node.CDATA_SECTION_NODE):
            nodes.append(child)
        elif child.nodeType == Node.ELEMENT_NODE:
            nodes.extend(descendants_text(child))
    return nodes


@dataclass
class Field:
    location: str
    nodes: list
    editable: bool = True
    numeric: bool = False

    @property
    def value(self):
        return ''.join(n.nodeValue for n in self.nodes)

    def replace(self, matches, aliases):
        # Work backwards so offsets in the original rich text remain valid.
        offsets = []
        start = 0
        for node in self.nodes:
            end = start + len(node.nodeValue)
            offsets.append((node, start, end))
            start = end
        for match in reversed(matches):
            for node, start, end in offsets:
                if max(start, match.start()) >= min(end, match.end()):
                    continue
                a, b = max(0, match.start()-start), min(end, match.end())-start
                label = aliases[match.lastgroup] if start <= match.start() < end else ''
                node.nodeValue = node.nodeValue[:a] + label + node.nodeValue[b:]


class OfficeFile:
    def __init__(self, data, kind):
        self.kind = kind
        self.label = 'Budget' if kind == 'xlsx' else 'Justification'
        self.parts = {}
        self.roots = {}
        self.fields = []
        self.dirty = set()
        self.omitted = set()
        if len(data) > LIMIT:
            self.stop('file exceeds 64 MiB')
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                members = archive.infolist()
                if len(members) > 2000 or sum(i.file_size for i in members) > LIMIT:
                    self.stop('package exceeds inspection limits')
                seen = set()
                for info in members:
                    name = info.filename
                    if name.casefold() in seen:
                        self.stop(name + ' — duplicate package part')
                    seen.add(name.casefold())
                    if info.is_dir():
                        continue
                    if re.fullmatch(r'docProps/thumbnail\.(?:jpeg|jpg|png)', name):
                        self.omitted.add(name)
                        continue
                    if not re.fullmatch(COMMON+'|'+(EXCEL if kind == 'xlsx' else WORD), name):
                        self.stop(name + ' — unsupported package part')
                    raw = archive.read(info)
                    # Only UTF-8 XML is supported. Disallow DTDs before parsing.
                    xml = raw.decode('utf-8-sig')
                    if re.search(r'_x[0-9A-Fa-f]{4}_', xml):
                        self.stop(name + ' — encoded Office text needs source cleanup')
                    if '\x00' in xml or re.search(r'<!DOCTYPE|<!ENTITY|<!--|<\?(?!xml\s)', xml, re.I):
                        self.stop(name + ' — unsupported XML declaration or annotation')
                    encoding = re.match(r'''<\?xml[^?]*encoding\s*=\s*["']([^"']+)''', xml, re.I)
                    if encoding and encoding[1].lower() not in ('utf-8', 'utf8', 'us-ascii'):
                        self.stop(name + ' — unsupported XML encoding')
                    root = minidom.parseString(raw)
                    for el in root.getElementsByTagName('*'):
                        if el.localName == 'workbookProtection' and not el.attributes.length:
                            continue
                        if el.localName in UNSUPPORTED:
                            self.stop(f'{name} — unsupported {el.localName}')
                    if name.startswith('customXml/') and not name.endswith('.rels'):
                        self._check_bibliography(name, root)
                    self.parts[name] = raw
                    self.roots[name] = root
            self._validate()
            self._index()
        except (zipfile.BadZipFile, KeyError, ExpatError, UnicodeError, RuntimeError,
                NotImplementedError, RecursionError, IndexError) as exc:
            self.stop(f'{locals().get("name", "package")} — unreadable or unsupported Office data ({type(exc).__name__})')

    def stop(self, reason):
        raise Blocked(f'{self.label}: {reason}')

    def _check_excel_features(self, sheet_names):
        custom_ids = set()
        self.unmodelled_format = None
        self.has_percentage_format = False
        self.uncached_formatted_formula = None
        styles = self.roots.get('xl/styles.xml')
        if styles:
            for fmt in elements(styles, S, 'numFmt'):
                identifier = fmt.getAttribute('numFmtId')
                if (not re.fullmatch(r'[0-9]{1,5}', identifier) or
                        not BUDGET_FORMAT.fullmatch(fmt.getAttribute('formatCode'))):
                    self.stop('xl/styles.xml — unsupported custom number format; use a safe source copy')
                custom_ids.add(identifier)
                if identifier in UNMODELLED_FORMAT_IDS:
                    self.unmodelled_format = identifier
                self.has_percentage_format |= (identifier in ('9', '10') or
                                               fmt.getAttribute('formatCode').endswith('%'))
            for xf in elements(styles, S, 'xf'):
                identifier = xf.getAttribute('numFmtId') or '0'
                if identifier not in BUILTIN_FORMAT_IDS and identifier not in custom_ids:
                    self.stop('xl/styles.xml — unknown number format')
                if identifier in UNMODELLED_FORMAT_IDS:
                    self.unmodelled_format = identifier
                self.has_percentage_format |= identifier in ('9', '10')

        for part, doc in self.roots.items():
            for el in doc.getElementsByTagName('*'):
                tag = el.localName
                if tag in ('xf', 'numFmt') and (part != 'xl/styles.xml' or el.namespaceURI != S):
                    self.stop(part + ' — unexpected number-format definition')
                if tag == 'definedName':
                    expression = ''.join(n.data for n in children_text(el))
                    sheet, sep, address = expression.rpartition('!')
                    local_sheet = sheet[1:-1].replace("''", "'") if sheet.startswith("'") else sheet
                    if (el.namespaceURI != S or
                            len(el.childNodes) != len(children_text(el)) or
                            (sep and (not SHEET_REF.fullmatch(sheet) or local_sheet.casefold() not in sheet_names)) or
                            not LOCAL_RANGE.fullmatch(address) or
                            any(el.hasAttribute(flag) for flag in
                                ('function', 'vbProcedure', 'xlm', 'functionGroupId', 'shortcutKey'))):
                        self.stop(part + ' — defined name must be a plain local cell or range')
                if (tag in ('formula', 'formula1', 'formula2') or
                        (tag == 'cfvo' and el.getAttribute('type') == 'formula')):
                    self.stop(part + ' — validation or conditional-format formula requires source cleanup')

    def _check_bibliography(self, name, doc):
        bib = 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography'
        store = 'http://schemas.openxmlformats.org/officeDocument/2006/customXml'
        tags = [(el.namespaceURI, el.localName) for el in doc.getElementsByTagName('*')]
        expected = [(bib, 'Sources')] if name.endswith('/item1.xml') else [
            (store, 'datastoreItem'), (store, 'schemaRefs'), (store, 'schemaRef')]
        if tags != expected or any(n.data.strip() for n in descendants_text(doc.documentElement)):
            self.stop(name + ' — only an empty bibliography is supported')
        for el in doc.getElementsByTagName('*'):
            for a in el.attributes.values():
                if a.namespaceURI == 'http://www.w3.org/2000/xmlns/':
                    continue
                safe = ((a.localName == 'StyleName' and a.value == 'APA') or
                        (a.localName == 'SelectedStyle' and a.value == '/APA.XSL') or
                        (a.localName == 'uri' and a.value == bib) or
                        (a.localName == 'itemID' and re.fullmatch(r'\{[0-9A-Fa-f-]{36}\}', a.value)))
                if not safe:
                    self.stop(name + ' — unsupported bibliography attribute')

    def _validate(self):
        main = 'xl/workbook.xml' if self.kind == 'xlsx' else 'word/document.xml'
        main_ns, main_tag = (S, 'workbook') if self.kind == 'xlsx' else (W, 'document')
        root = self.roots[main].documentElement
        if root.namespaceURI != main_ns or root.localName != main_tag:
            self.stop(main + ' — unexpected main document')
        types = self.roots['[Content_Types].xml']
        overrides = elements(types, CT, 'Override')
        if not any(n.getAttribute('PartName') == '/'+main and
                   n.getAttribute('ContentType') == OFFICE_TYPES[self.kind] for n in overrides):
            self.stop('unsupported document type')
        for n in overrides:
            if n.getAttribute('PartName').lstrip('/') in self.omitted:
                n.parentNode.removeChild(n)
                self.dirty.add('[Content_Types].xml')
        self.links = {}
        for part, doc in self.roots.items():
            if not part.endswith('.rels'):
                continue
            base, _, filename = part.rpartition('_rels/')
            owner = base + filename[:-5]
            links = {}
            for rel in elements(doc, PR, 'Relationship'):
                target = rel.getAttribute('Target')
                if rel.getAttribute('TargetMode') == 'External' or re.search(r'[:%\\?#]', target):
                    self.stop(f'{part} — external or unsupported relationship')
                dest = posixpath.normpath(posixpath.join(base, target)).lstrip('/')
                if dest in self.omitted and rel.getAttribute('Type').endswith('/thumbnail'):
                    rel.parentNode.removeChild(rel)
                    self.dirty.add(part)
                    continue
                if dest not in self.parts:
                    self.stop(f'{part} — broken relationship to {dest}')
                rid = rel.getAttribute('Id')
                if rid in links:
                    self.stop(part + ' — duplicate relationship ID')
                links[rid] = dest
            self.links[owner] = links
        if main not in self.links.get('', {}).values():
            self.stop('missing main document relationship')

    def _index(self):
        shared = defaultdict(list)
        sheet_names = {}
        if self.kind == 'xlsx':
            book = 'xl/workbook.xml'
            self._check_excel_features({sh.getAttribute('name').casefold()
                                        for sh in elements(self.roots[book], S, 'sheet')})
            for sh in elements(self.roots[book], S, 'sheet'):
                path = self.links.get(book, {}).get(sh.getAttributeNS(R, 'id'))
                if path is None or not re.fullmatch(r'xl/worksheets/sheet\d+\.xml', path):
                    self.stop(book + ' — sheet relationship missing')
                label = sh.getAttribute('name')
                state = sh.getAttribute('state')
                sheet_names[path] = label + (f' ({state})' if state and state != 'visible' else '')
                self.fields.append((book, Field('Sheet name', [sh.getAttributeNode('name')], False)))
        for part, title in sheet_names.items():
            # Column and conditional formats can apply without an explicit cell style.
            inherited_style = (any(col.hasAttribute('style') for col in elements(self.roots[part], S, 'col'))
                               or bool(elements(self.roots[part], S, 'conditionalFormatting')))
            for cell in elements(self.roots[part], S, 'c'):
                loc = f'{title}!{cell.getAttribute("r")}'
                kind = cell.getAttribute('t')
                formulas = elements(cell, S, 'f')
                for f in formulas:
                    formula = ''.join(n.data for n in children_text(f))
                    calls = re.findall(r'([A-Za-z_][\w.]*)\s*\(', formula)
                    numeric_calls = {'SUM','AVERAGE','MIN','MAX','ROUND','ROUNDUP','ROUNDDOWN',
                                     'ABS','IF','COUNT','SUMIF','SUMIFS','COUNTIF','COUNTIFS'}
                    if (any(c in formula for c in '"&[]|') or
                            f.getAttribute('t') not in ('', 'normal') or
                            any(call.upper() not in numeric_calls for call in calls)):
                        self.stop(loc + ' formula — unsupported expression or dynamic content')
                    self.add(part, loc+' formula', children_text(f), False)
                vals = elements(cell, S, 'v')
                if (formulas and (cell.hasAttribute('s') or cell.parentNode.hasAttribute('s') or inherited_style)
                        and not any(children_text(v) for v in vals)):
                    self.uncached_formatted_formula = loc
                if kind == 's':
                    index = ''.join(n.data for n in children_text(vals[0])) if len(vals) == 1 else ''
                    if not re.fullmatch(r'0|[1-9][0-9]{0,8}', index):
                        self.stop(loc + ' — invalid shared string reference')
                    shared[index].append(loc)
                elif kind == 'inlineStr':
                    self.rich(part, loc, cell, S)
                else:
                    for v in vals:
                        self.add(part, loc, children_text(v), False, numeric=kind in ('', 'n'))
        if shared:
            strings = self.roots.get('xl/sharedStrings.xml')
            size = len(elements(strings, S, 'si')) if strings else 0
            for index, locations in shared.items():
                if int(index) >= size:
                    self.stop(locations[0] + ' — shared text cannot be located')
        for part, root in self.roots.items():
            if part == 'xl/sharedStrings.xml':
                for i, item in enumerate(elements(root, S, 'si')):
                    self.rich(part, ', '.join(shared[str(i)]) or f'Unused shared string {i}', item, S)
            if part.startswith('xl/'):
                for item in elements(root, S, 'comment'):
                    self.rich(part, f'{part} comment {item.getAttribute("ref")}', item, S)
                for tag in ('author','oddHeader','evenHeader','firstHeader','oddFooter','evenFooter','firstFooter','definedName'):
                    for el in elements(root, S, tag):
                        self.add(part, f'{sheet_names.get(part,part)} / {tag}', children_text(el), tag=='author')
            if part.startswith('word/'):
                for i, para in enumerate(elements(root, W, 'p'), 1):
                    self.rich(part, f'{part} ¶{i}', para, W)
                for i, comment in enumerate(elements(root, W, 'comment'), 1):
                    for attr in ('author', 'initials'):
                        node = comment.getAttributeNodeNS(W, attr)
                        if node:
                            self.add(part, f'{part} comment {i} / {attr}', [node])
            if part.startswith('docProps/'):
                for el in root.getElementsByTagName('*'):
                    if not any(n.nodeType == Node.ELEMENT_NODE for n in el.childNodes):
                        self.add(part, f'{part} / {el.localName}', children_text(el),
                                 el.localName in ('creator','lastModifiedBy','title','subject','description',
                                                  'keywords','category','Company','Manager'))

        # Surface remaining textual values in otherwise supported parts as protected
        # fields. This includes metadata vectors and spreadsheet validation rules.
        indexed = {id(node) for _, field in self.fields for node in field.nodes}
        for part, root in self.roots.items():
            for el in root.getElementsByTagName('*'):
                nodes = [n for n in children_text(el) if id(n) not in indexed]
                self.add(part, f'{part} / {el.tagName}', nodes, False)
                if el.localName in ('bookmarkStart', 'docVar', 'numFmt', 'definedName'):
                    for a in el.attributes.values():
                        if a.localName in ('name', 'val', 'formatCode'):
                            self.add(part, f'{part} / {el.tagName} / {a.name}', [a], False)

    def rich(self, part, location, el, namespace):
        nodes = []
        has_separator = False
        for child in el.getElementsByTagName('*'):
            if child.namespaceURI != namespace:
                continue
            if child.localName == 't':
                nodes.extend(children_text(child))
            elif namespace == W and child.localName in ('tab', 'br', 'cr'):
                nodes.append(el.ownerDocument.createTextNode(' '))
                has_separator = True
        # A match in a paragraph with layout controls needs human source cleanup.
        self.add(part, location, nodes, not has_separator)

    def add(self, part, location, nodes, editable=True, numeric=False):
        if nodes and any(n.nodeValue.strip() for n in nodes):
            self.fields.append((part, Field(location, nodes, editable, numeric)))

    def check_numeric_identifiers(self, rules):
        # The same identifier may appear once as text and elsewhere as a number.
        # Compare every numeric cell, including hidden sheets and formula caches.
        keys = set()
        for term, _ in rules:
            if re.fullmatch(r'\s*[+-]?\d+(?:[.,]\d+)?[Ee][+-]?\d+\s*', term):
                if any(field.numeric for _, field in self.fields):
                    self.stop('scientific-notation identifier cannot be verified against Excel display precision')
            # Account for month words and AM/PM when recognizing date/time rules.
            number_text = re.sub(r'\b(?:Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|'
                                 r'Sep\w*|Oct\w*|Nov\w*|Dec\w*|AM|PM)\b', '', term, flags=re.I)
            if re.fullmatch(r'[0-9\s()+.,:/%$€£‐‑‒–—−-]+', number_text):
                digits = re.sub(r'[^0-9]', '', term)
                if digits:
                    if self.unmodelled_format:
                        self.stop('xl/styles.xml — cannot verify selected numeric identifiers against date, time, '
                                  'fraction, or scientific number formats; prepare a safe source copy')
                    keys.add(digits.lstrip('0') or '0')
                    fraction = re.search(r'[.,]([0-9]{1,6})\s*[%$€£]?\s*$', term)
                    if fraction:
                        padding = len(fraction[1]) - len(fraction[1].rstrip('0'))
                        if padding:
                            keys.add(digits[:-padding].lstrip('0') or '0')
        if not keys:
            return
        for _, field in self.fields:
            if not field.numeric:
                continue
            raw = field.value.strip()
            # Excel stores finite double-precision values. Bound expansion of
            # scientific notation before constructing its displayed digits.
            try:
                if len(raw) > 128:
                    raise InvalidOperation
                value = Decimal(raw)
                if not value.is_finite() or abs(value.as_tuple().exponent) > 400:
                    raise InvalidOperation
            except InvalidOperation:
                self.stop(field.location + ' — unsupported numeric value')
            # Number formats can come from a cell, row, column or conditional
            # style. Compare a superset of the supported rounded presentations.
            # General also rounds according to the available column width.
            with localcontext() as context:
                context.rounding = ROUND_HALF_UP
                context.prec = 150
                value = value.copy_abs()
                values = [value, value * 100] if self.has_percentage_format else [value]
                for number in values:
                    fraction_places = max(0, -number.as_tuple().exponent)
                    precisions = range(min(15, fraction_places) + 1)
                    displays = [format(number, 'f'), *(format(number, f'.{n}f') for n in precisions)]
                    for display in displays:
                        if '.' in display:
                            display = display.rstrip('0').rstrip('.')
                        if (display.replace('.', '').lstrip('0') or '0') in keys:
                            self.stop(field.location + ' — selected identifier matches a protected numeric value; prepare a safe source copy')
        if self.uncached_formatted_formula:
            self.stop(self.uncached_formatted_formula + ' — formatted formula has no cached value for checking the numeric identifier')

    def write(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, raw in self.parts.items():
                archive.writestr(name, self.roots[name].toxml(encoding='utf-8') if name in self.dirty else raw)
        return buffer.getvalue()

    def verify(self, pattern):
        if not pattern:
            return
        for _, field in self.fields:
            if pattern.search(field.value):
                self.stop(field.location + ' — confirmed identifier remains')
        for part, root in self.roots.items():
            for el in root.getElementsByTagName('*'):
                values = [a.value for a in el.attributes.values()]
                values.extend(n.data for n in children_text(el))
                if any(pattern.search(v) for v in values):
                    self.stop(f'{part} / {el.tagName} — identifier in protected content')
