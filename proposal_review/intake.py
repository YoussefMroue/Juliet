"""Read-only evidence extraction. This module never edits or recalculates a source."""
import hashlib
import io
import posixpath
import re
import zipfile
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from xml.etree import ElementTree as ET

from .office import Blocked, S, W, R, PR

LIMIT = 64 * 1024 * 1024
MAX_ITEMS = 100000
MAX_TEXT = 16 * 1024 * 1024
MAX_ITEM_TEXT = 6000
REF = re.compile(r"(?:(?:\[[^\]]+\])?(?:'[^']+'|[A-Za-z_][\w .]*)!)?\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6})?")
FORMAT = {'0': 'General', '1': '0', '2': '0.00', '3': '#,##0', '4': '#,##0.00', '9': '0%', '10': '0.00%'}
WORD_UNSUPPORTED = {'AlternateContent', 'altChunk', 'drawing', 'pict', 'object', 'fldSimple', 'fldChar', 'instrText', 'del', 'ins', 'moveFrom', 'moveTo', 'sdt', 'txbxContent'}


def _local(tag):
    return tag.rsplit('}', 1)[-1]


def _xml(raw, name):
    try:
        xml = raw.decode('utf-8-sig')
        if '\x00' in xml or re.search(r'<!DOCTYPE|<!ENTITY', xml, re.I):
            raise Blocked(f'{name}: XML entities, DTDs or unsupported encoding require local inspection.')
        root = ET.fromstring(xml)
        pending, count = [(root, 1)], 0
        while pending:
            node, depth = pending.pop()
            count += 1
            if count > 1500000 or depth > 128:
                raise Blocked(f'{name}: XML element or nesting limit exceeded.')
            pending.extend((child, depth + 1) for child in node)
        return root
    except (UnicodeError, ET.ParseError, RecursionError) as exc:
        raise Blocked(f'{name}: unreadable XML ({type(exc).__name__}).') from exc


def _package(data):
    if not isinstance(data, bytes) or len(data) > LIMIT:
        raise Blocked('Select an Office file no larger than 64 MiB.')
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            if len(infos) > 2000 or sum(i.file_size for i in infos) > LIMIT:
                raise Blocked('Office package exceeds the 2,000-part or 64 MiB expanded limit.')
            parts, seen = {}, set()
            for info in infos:
                name = info.filename
                if len(name) > 500 or name.casefold() in seen or '\\' in name or name.startswith('/') or '..' in name.split('/') or '\x00' in name:
                    raise Blocked('Office package has a duplicate or unsafe part name.')
                seen.add(name.casefold())
                if info.flag_bits & 1:
                    raise Blocked('Encrypted Office package requires local inspection.')
                if not info.is_dir():
                    parts[name] = archive.read(info)
            return parts
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError) as exc:
        raise Blocked(f'Unreadable Office package ({type(exc).__name__}).') from exc


class _Evidence:
    def __init__(self):
        self.items, self.limitations, self.size = [], [], 0
        self.seen = set()

    def limit(self, location, feature, message):
        key = (location, feature, message)
        if key not in self.seen:
            if len(self.limitations) >= 1000:
                raise Blocked('More than 1,000 unsupported structures; use a scoped supported copy or manual evidence.')
            self.seen.add(key)
            self.limitations.append({'location': location, 'feature': feature, 'message': message})

    def add(self, anchor, text, **metadata):
        if not text.strip():
            return
        if re.search(r'_x[0-9A-Fa-f]{4}_', text):
            self.limit(anchor, 'encoded Office text', 'Encoded Office text was preserved as stored, not decoded or matched to the rendered source. Inspect this location locally.')
        pieces = [text[i:i + MAX_ITEM_TEXT] for i in range(0, len(text), MAX_ITEM_TEXT)]
        for i, piece in enumerate(pieces):
            self.size += len(piece)
            if len(self.items) >= MAX_ITEMS or self.size > MAX_TEXT:
                raise Blocked('Extracted evidence exceeds the local item/text limit; select a scoped supported copy or inspect manually.')
            part = f' · segment {i + 1}/{len(pieces)}' if len(pieces) > 1 else ''
            self.items.append({'anchor': anchor + part, 'text': piece, 'method': 'extracted', **metadata})


def _target(base, target):
    if not target or '\\' in target or re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', target):
        raise Blocked('Unsupported internal Office relationship target.')
    name = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(base, target))
    if name == '..' or name.startswith('../'):
        raise Blocked('Office relationship points outside the package.')
    return name


def _relationships(parts, path, evidence):
    if path not in parts:
        return {}
    result = {}
    for rel in _xml(parts[path], path):
        identity = rel.get('Id')
        if not identity or identity in result:
            raise Blocked(f'{path}: missing or duplicate relationship identity.')
        if rel.get('TargetMode') == 'External':
            evidence.limit(path, 'external relationship', 'External content was not opened, refreshed or inspected.')
            result[identity] = None
        else:
            result[identity] = (rel.get('Target', ''), rel.get('Type', ''))
    return result


def _display(value, fmt):
    """A narrow display approximation, never the actual Excel rendering."""
    if not re.fullmatch(r'(?:#,##)?0(?:\.0{1,6})?%?', fmt):
        return None
    try:
        n = Decimal(value)
        if not n.is_finite() or abs(n.adjusted()) > 100:
            return None
        if fmt.endswith('%'):
            n *= 100
        digits = len(fmt.rstrip('%').split('.')[1]) if '.' in fmt else 0
        n = n.quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
        return format(n, (',' if ',' in fmt else '') + '.' + str(digits) + 'f') + ('%' if fmt.endswith('%') else '')
    except (InvalidOperation, ValueError):
        return None


def _xlsx(parts, evidence):
    main = 'xl/workbook.xml'
    if main not in parts:
        raise Blocked('The package has no Excel workbook part.')
    workbook = _xml(parts[main], main)
    if workbook.tag != f'{{{S}}}workbook':
        raise Blocked('Unsupported Excel workbook namespace.')
    rels = _relationships(parts, 'xl/_rels/workbook.xml.rels', evidence)
    shared = []
    if 'xl/sharedStrings.xml' in parts:
        root = _xml(parts['xl/sharedStrings.xml'], 'xl/sharedStrings.xml')
        for item in root.findall(f'{{{S}}}si'):
            shared.append(''.join(t.text or '' for t in item.iter(f'{{{S}}}t')))
    formats, styles = dict(FORMAT), []
    if 'xl/styles.xml' in parts:
        root = _xml(parts['xl/styles.xml'], 'xl/styles.xml')
        for fmt in root.findall(f'{{{S}}}numFmts/{{{S}}}numFmt'):
            formats[fmt.get('numFmtId')] = fmt.get('formatCode', '')
        styles = [formats.get(xf.get('numFmtId', '0'), 'Unmodeled format ' + xf.get('numFmtId', '0'))
                  for xf in root.findall(f'{{{S}}}cellXfs/{{{S}}}xf')]
    calc = workbook.find(f'{{{S}}}calcPr')
    mode = calc.get('calcMode', 'not recorded') if calc is not None else 'not recorded'
    evidence.limit(main, 'calculation evidence', f'Workbook calculation mode recorded as {mode}. Saved caches are not recalculation evidence. No engine, macro or external link was run.')
    if workbook.find(f'{{{S}}}definedNames') is not None:
        evidence.limit(main, 'defined names', 'Named ranges and named formulas were not resolved; formula reference tokens are not a complete dependency graph.')
    processed = {main, 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml'}
    for sheet in workbook.findall(f'{{{S}}}sheets/{{{S}}}sheet'):
        relation = rels.get(sheet.get(f'{{{R}}}id'))
        label = sheet.get('name', 'Unnamed sheet')
        if len(label) > 100:
            raise Blocked('Worksheet label exceeds the inspection limit.')
        state = sheet.get('state', 'visible')
        if not relation or not relation[1].endswith('/worksheet'):
            evidence.limit(label, 'unsupported sheet', 'Worksheet relationship is missing, external or not a worksheet; its contents are unchecked.')
            continue
        path = _target('xl', relation[0])
        if path not in parts:
            evidence.limit(label, 'missing worksheet', 'The referenced worksheet part is missing; its contents are unchecked.')
            continue
        processed.add(path)
        root = _xml(parts[path], path)
        if root.tag != f'{{{S}}}worksheet':
            evidence.limit(label, 'unsupported worksheet', 'Worksheet namespace or type is unsupported.')
            continue
        if root.find(f'{{{S}}}mergeCells') is not None:
            evidence.limit(label, 'merged cells', 'Cell values are anchored to stored cells; the rendered merged-cell layout was not verified.')
        if any(col.get('hidden') in {'1', 'true'} for col in root.findall(f'{{{S}}}cols/{{{S}}}col')):
            evidence.limit(label, 'hidden columns', 'This sheet contains hidden columns. Extraction includes stored cells without reproducing column visibility.')
        for el in root.iter():
            if _local(el.tag) in {'AlternateContent', 'extLst', 'drawing', 'legacyDrawing', 'oleObject', 'control', 'dataValidations', 'conditionalFormatting'}:
                evidence.limit(label, _local(el.tag), 'This feature is not rendered or interpreted; inspect affected content locally.')
        addresses = set()
        for row in root.findall(f'{{{S}}}sheetData/{{{S}}}row'):
            for cell in row.findall(f'{{{S}}}c'):
                address = cell.get('r', '')
                if not re.fullmatch(r'[A-Z]{1,3}[1-9]\d{0,6}', address) or address in addresses:
                    raise Blocked(f'{label}: invalid or duplicate cell address.')
                addresses.add(address)
                anchor = f'{label}' + (f' ({state})' if state != 'visible' else '') + '!' + address
                value = cell.findtext(f'{{{S}}}v')
                kind = cell.get('t', 'n')
                if kind == 's':
                    try:
                        index = int(value)
                        if index < 0:
                            raise ValueError()
                        value = shared[index]
                    except (TypeError, ValueError, IndexError) as exc:
                        raise Blocked(f'{anchor}: invalid shared string reference.') from exc
                elif kind == 'inlineStr':
                    value = ''.join(t.text or '' for t in cell.findall(f'{{{S}}}is//{{{S}}}t'))
                formula = cell.find(f'{{{S}}}f')
                if formula is None and value is None:
                    continue
                try:
                    style_index = int(cell.get('s', '0'))
                    if style_index < 0:
                        raise ValueError()
                    if not styles and style_index:
                        raise ValueError()
                    fmt = styles[style_index] if styles else 'General'
                except (IndexError, ValueError) as exc:
                    raise Blocked(f'{anchor}: invalid cell style.') from exc
                metadata = {'storedValue': value, 'numberFormat': fmt, 'displayValue': _display(value, fmt) if value is not None and kind == 'n' else None}
                lines = ['Stored value: ' + (str(value) if value is not None else '[absent]')]
                if formula is not None:
                    expression = formula.text or ''
                    references = list(dict.fromkeys(REF.findall(expression)))
                    metadata.update(formula=expression, cachedValue=value, references=references)
                    lines = ['Formula: =' + expression, 'Saved cached value: ' + (str(value) if value is not None else '[absent]')]
                    if formula.get('t') in {'shared', 'array', 'dataTable'}:
                        evidence.limit(anchor, 'formula structure', 'Shared, array or table formula semantics were not expanded or evaluated. Inspect the source range locally.')
                    if '[' in expression or re.search(r'\b(?:WEBSERVICE|RTD|DDE|HYPERLINK)\s*\(', expression, re.I):
                        evidence.limit(anchor, 'external or dynamic formula', 'External/dynamic dependencies were not resolved or refreshed. Saved values do not verify this formula.')
                    if references:
                        lines.append('Reference tokens (not an evaluated dependency graph): ' + ', '.join(references))
                lines.append('Number format: ' + fmt)
                if metadata['displayValue'] is not None:
                    lines.append('Modeled display (not Excel rendering): ' + metadata['displayValue'])
                if row.get('hidden') in {'1', 'true'}:
                    lines.append('Row is hidden in source.')
                evidence.add(anchor, '\n'.join(lines), **metadata)
    for name in parts:
        if name.startswith('xl/') and name not in processed:
            feature = 'external link' if 'externalLink' in name else 'uninspected workbook part'
            evidence.limit(name, feature, 'This package part was not interpreted; no linked content, embedded object or macro was executed.')


def _docx(parts, evidence):
    if 'word/document.xml' not in parts:
        raise Blocked('The package has no Word document part.')
    processed = set()
    for path in sorted(parts):
        if not re.fullmatch(r'word/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml', path):
            continue
        root = _xml(parts[path], path)
        if not root.tag.startswith('{' + W + '}'):
            raise Blocked(f'{path}: unsupported Word namespace.')
        processed.add(path)
        parents = {child: parent for parent in root.iter() for child in parent}
        tables = {node: i + 1 for i, node in enumerate(root.iter(f'{{{W}}}tbl'))}
        for index, paragraph in enumerate(root.iter(f'{{{W}}}p'), 1):
            lineage, ancestor = [], parents.get(paragraph)
            while ancestor is not None:
                lineage.append(ancestor)
                ancestor = parents.get(ancestor)
            anchor = f'{path} · paragraph {index}'
            table = next((node for node in lineage if node.tag == f'{{{W}}}tbl'), None)
            if table is not None:
                tr = next((node for node in lineage if node.tag == f'{{{W}}}tr'), None)
                tc = next((node for node in lineage if node.tag == f'{{{W}}}tc'), None)
                table_rows = [node for node in table if node.tag == f'{{{W}}}tr']
                row = table_rows.index(tr) + 1 if tr in table_rows else '?'
                column = [node for node in tr if node.tag == f'{{{W}}}tc'].index(tc) + 1 if tr is not None and tc in list(tr) else '?'
                anchor += f' · table {tables[table]} row {row} cell {column}'
            unsupported = {_local(node.tag) for node in [*paragraph.iter(), *lineage]} & WORD_UNSUPPORTED
            if unsupported:
                evidence.limit(anchor, ', '.join(sorted(unsupported)), 'This paragraph includes unsupported alternative, dynamic, drawing or revision content and was not extracted. Inspect it locally.')
                continue
            text = []
            for node in paragraph.iter():
                if node.tag == f'{{{W}}}t':
                    text.append(node.text or '')
                elif node.tag == f'{{{W}}}tab':
                    text.append('\t')
                elif node.tag in {f'{{{W}}}br', f'{{{W}}}cr'}:
                    text.append('\n')
            evidence.add(anchor, ''.join(text))
        for node in root.iter():
            if _local(node.tag) in WORD_UNSUPPORTED:
                evidence.limit(path, _local(node.tag), 'Unsupported content may have no extracted paragraph; inspect it locally before checking affected requirements.')
    for name in parts:
        if name not in processed and not re.fullmatch(r'(?:\[Content_Types\]\.xml|_rels/\.rels|docProps/.*|word/(?:styles|settings|numbering|fontTable|webSettings)\.xml)', name):
            evidence.limit(name, 'uninspected document part', 'Rendering, relationships and embedded content were not interpreted or retrieved.')
    evidence.limit('document', 'layout', 'Paragraph and table text does not establish pagination, headings, image content, tracked-change acceptance or rendered layout. Check those requirements locally.')


def inspect_source(data, kind):
    """Return attributed text/cell evidence and explicit limitations, without a derivative."""
    if kind not in {'xlsx', 'docx'}:
        raise Blocked('Only XLSX and DOCX Office evidence extraction is supported; use manual evidence for other formats.')
    parts, evidence = _package(data), _Evidence()
    (_xlsx if kind == 'xlsx' else _docx)(parts, evidence)
    return {'kind': kind, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data),
            'coverage': 'partial' if evidence.limitations else 'supported_text',
            'limitations': evidence.limitations, 'items': evidence.items}
