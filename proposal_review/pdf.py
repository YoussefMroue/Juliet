"""Layout-preserving local export for horizontal, selectable-text PDFs."""
from collections import Counter
from dataclasses import dataclass
import re

from .office import Blocked, LIMIT


def engine():
    try:
        import pymupdf
    except ImportError as exc:
        raise Blocked('PDF support needs PyMuPDF in the Python environment running the app. See requirements-pdf.txt.') from exc
    return pymupdf


def stop(reason, page=None):
    location = f' page {page.number + 1}' if page is not None else ''
    raise Blocked(f'Justification PDF{location}: {reason}')


@dataclass
class Line:
    location: str
    value: str
    chars: list


def lines_on(page):
    lines = []
    for block in page.get_text('rawdict', sort=True, flags=engine().TEXTFLAGS_TEXT)['blocks']:
        for line in block.get('lines', []):
            if tuple(line['dir']) != (1, 0):
                stop('rotated text requires source cleanup', page)
            chars = [char for span in line['spans'] for char in span['chars']]
            value = ''.join(c['c'] for c in chars)
            if any(len(c['c']) != 1 or c['c'] == '\ufffd' for c in chars):
                stop('text could not be mapped to individual visible characters', page)
            if value.strip():
                lines.append(Line(f'Page {page.number+1}, line {len(lines)+1}', value, chars))
    return lines


def inspect_page(page):
    if (page.rotation or page.cropbox != page.mediabox or page.rect.tl != (0, 0)
            or page.rect.width > 1440 or page.rect.height > 1440):
        stop('rotated, cropped or oversized page', page)
    if page.annot_xrefs() or page.get_image_info() or page.get_xobjects():
        stop('image, annotation, link, form or embedded drawing requires source cleanup', page)
    for kind, _ in page.get_bboxlog():
        if kind not in ('fill-text', 'stroke-path', 'fill-path'):
            stop('unsupported graphic or hidden content', page)
    for drawing in page.get_drawings():
        for item in drawing['items']:
            if item[0] == 're':
                continue
            if item[0] == 'l' and (item[1].x == item[2].x or item[1].y == item[2].y):
                continue
            stop('freehand or outlined drawing requires visual source cleanup', page)
    lines = lines_on(page)
    if not lines:
        stop('no selectable text; scanned pages require source cleanup', page)
    return lines


class PdfFile:
    kind = 'pdf'
    label = 'Justification'
    omitted = ()

    def __init__(self, data):
        pdf = engine()
        self.fields = []
        if len(data) > LIMIT:
            stop('file exceeds the inspection limit')
        try:
            with pdf.open(stream=data, filetype='pdf') as doc:
                if (not doc.is_pdf or doc.needs_pass or doc.metadata.get('encryption') or doc.is_repaired or doc.embfile_count()
                        or doc.is_form_pdf or doc.get_ocgs() or not 0 < len(doc) <= 50):
                    stop('encrypted, damaged, layered, interactive, attached or oversized document')
                pixels = 0
                for page in doc:
                    pixels += page.rect.width * page.rect.height * 4
                    if pixels > 64_000_000:
                        stop('document exceeds the rendered-page limit', page)
                    for line in inspect_page(page):
                        self.fields.append((page.number, line))
        except (RuntimeError, ValueError) as exc:
            if isinstance(exc, Blocked):
                raise
            raise Blocked('Justification PDF could not be inspected.') from exc

    def inspect(self, original, aliases, pattern):
        pdf = engine()
        changes = []
        checked = PdfPreview()
        with pdf.open(stream=original, filetype='pdf') as source, pdf.open() as output:
            for page in source:
                indexed = [field for index, field in self.fields if index == page.number]
                combined = ' '.join(line.value for line in indexed)
                line_matches = sum(len(list(pattern.finditer(line.value))) for line in indexed) if pattern else 0
                if pattern and len(list(pattern.finditer(combined))) != line_matches:
                    stop('identifier crosses text lines; prepare a safe source copy', page)
                inserts = []
                expected = []
                for line in indexed:
                    matches = list(pattern.finditer(line.value)) if pattern else []
                    expected.append(pattern.sub('',line.value) if pattern else line.value)
                    if not matches:
                        continue
                    after = pattern.sub(lambda m: aliases[m.lastgroup],line.value)
                    changes.append((self.label,line.location,line.value,after))
                    for m in matches:
                        chars = line.chars[m.start():m.end()]
                        rect = pdf.Rect(chars[0]['bbox'])
                        for char in chars[1:]:
                            rect |= pdf.Rect(char['bbox'])
                        label = aliases[m.lastgroup]
                        width = pdf.get_text_length(label, fontname='helv', fontsize=1)
                        size = min(11, rect.height * .7, rect.width / max(.01,width))
                        if size < 4 or not label.isascii() or not label.isprintable():
                            stop(f'{line.location} — choose a shorter, plain-text replacement that fits',page)
                        page.add_redact_annot(rect, fill=(1,1,1), cross_out=False)
                        inserts.append((chars[0]['origin'],label,size,rect))
                if inserts:
                    page.apply_redactions(graphics=pdf.PDF_REDACT_LINE_ART_NONE)
                    retained = page.get_text()
                    if Counter(''.join(retained.split())) != Counter(''.join(''.join(expected).split())):
                        stop('redaction would affect nearby text; prepare a safe source copy',page)
                    for origin,label,size,rect in inserts:
                        page.insert_text(origin,label,fontsize=size,fontname='helv')
                        if label not in page.get_textbox(rect + (-1,-2,1,2)):
                            stop('replacement could not be verified in its original position',page)

                # Start with a fresh document. Only rendered sanitized pixels and
                # verified words enter it; original resources and history stay behind.
                target = output.new_page(width=page.rect.width,height=page.rect.height)
                pix = page.get_pixmap(matrix=pdf.Matrix(2,2),alpha=False)
                target.insert_image(target.rect,stream=pix.tobytes('png'))
                for x0,y0,x1,y1,word,*_ in page.get_text('words',sort=True):
                    width = pdf.get_text_length(word,fontsize=1)
                    size = min((x1-x0)/max(width,.01), (y1-y0)*.72)
                    if size <= 0:
                        stop('invalid text coordinates',page)
                    target.insert_text((x0,y1-size*.22),word,fontsize=size,render_mode=3)
            data = output.tobytes(garbage=4,deflate=True)
            if len(data)>LIMIT:
                stop('result exceeds the inspection limit')
            with pdf.open(stream=data,filetype='pdf') as saved:
                for i,page in enumerate(saved):
                    text = page.get_text(sort=True)
                    source_text = source[i].get_text(sort=True)
                    if ''.join(text.split()) != ''.join(source_text.split()):
                        stop('selectable text could not be verified after export',page)
                    if pattern and pattern.search(re.sub(r'\s+',' ',text)):
                        stop('confirmed identifier remains in the exported text',page)
                    checked.fields.append((i,Line(f'Page {i+1}',text,[])))
        return (data,checked),changes


class PdfPreview:
    kind = 'pdf'
    label = 'Justification'

    def __init__(self):
        self.fields = []
