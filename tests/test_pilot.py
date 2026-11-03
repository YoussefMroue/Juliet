import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from docx import Document
from openpyxl import load_workbook
from openpyxl.comments import Comment

from proposal_review.case import Case, candidate_terms, export_pair
from proposal_review.office import Blocked, OfficeFile
from .exercises import build, NAME, SCENARIOS

RULES = [(NAME, 'Person 01'), ('mira@example.invalid', 'Email 01'),
         ('XQ-417', 'ID 01'), ('MX','Initials 01')]


def digest(path):
    return hashlib.sha256(path.read_bytes()).digest()


class PilotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.inputs = self.root/'case'
        build(self.inputs, 'clean')
        self.xlsx = self.inputs/'input.xlsx'
        self.docx = self.inputs/'input.docx'

    def load(self):
        return Case(self.xlsx, self.docx)

    def test_local_round_trip(self):
        before = [digest(p) for p in (self.xlsx, self.docx)]
        case = self.load()
        guesses = dict(candidate_terms(case.files))
        self.assertIn(NAME, guesses)
        self.assertIn('mira@example.invalid', guesses)
        results, changes = case.inspect(RULES)
        self.assertTrue(any('(hidden)!B2' in loc for _,loc,_,_ in changes))
        self.assertTrue(any('comments.xml' in loc for _,loc,_,_ in changes))
        self.assertEqual(list(self.root.iterdir()), [self.inputs])
        dest = export_pair(self.root, results)
        second = export_pair(self.root, results)
        self.assertNotEqual(dest, second)
        self.assertEqual(set(p.name for p in dest.iterdir()), {'Budget.xlsx','Justification.docx'})
        for file in dest.iterdir():
            with ZipFile(file) as z:
                self.assertNotIn('docProps/thumbnail.jpeg', z.namelist())
                for name in z.namelist():
                    data = z.read(name).decode().lower()
                    for term,_ in RULES[:-1]:
                        self.assertNotIn(term.lower(), data)
        wb = load_workbook(dest/'Budget.xlsx')
        self.assertEqual(wb.active['A2'].value,'Person 01')
        self.assertEqual(wb.active['B2'].value,700)
        self.assertEqual(wb.active['B4'].value,'=SUM(B2:B3)')
        self.assertEqual(wb.active.column_dimensions['A'].width,24)
        self.assertEqual(wb['Details'].sheet_state,'hidden')
        self.assertEqual(wb['Details']['B2'].value,'Person 01 / employee ID 01')
        doc = Document(dest/'Justification.docx')
        self.assertEqual(doc.paragraphs[0].text,'Person 01 will perform the research.')
        self.assertTrue(doc.paragraphs[0].runs[0].bold)
        self.assertEqual(next(iter(doc.comments)).author,'Person 01')
        self.assertEqual(next(iter(doc.comments)).initials,'Initials 01')
        self.assertEqual(doc.sections[0].header.paragraphs[0].text,'Person 01')
        self.assertEqual(doc.core_properties.author,'Person 01')
        self.assertEqual([digest(p) for p in (self.xlsx,self.docx)], before)

    def test_retry_and_false_match(self):
        case = self.load()
        case.inspect(RULES + [('Personnel','Example label')])
        results,_ = case.inspect(RULES)
        self.assertEqual(load_workbook(io.BytesIO(results[0][0])).active['A1'].value,'Personnel')
        with self.assertRaisesRegex(Blocked, 'identifier remains'):
            case.inspect([(NAME,NAME)])

    def test_formula_and_structural_blockers(self):
        book = load_workbook(self.xlsx)
        book.active['C6'] = '=LEN("Mira Example")'
        book.save(self.xlsx)
        with self.assertRaisesRegex(Blocked, 'Budget!C6 formula'):
            self.load().inspect(RULES)
        book.active['C6'] = None
        book.active.title = NAME
        book.save(self.xlsx)
        with self.assertRaisesRegex(Blocked, 'Sheet name'):
            self.load().inspect(RULES)

    def test_excel_notes_name_unsupported_drawing(self):
        book = load_workbook(self.xlsx)
        book.active['A4'].comment = Comment(NAME,NAME)
        book.save(self.xlsx)
        with self.assertRaisesRegex(Blocked, 'Budget: .*legacyDrawing|Budget: .*\\.vml'):
            self.load()

    def test_media_and_ambiguous_files_block(self):
        for name in ['word/media/image1.png','word/embeddings/object.bin']:
            data = io.BytesIO(self.docx.read_bytes())
            with ZipFile(data,'a') as z:
                z.writestr(name,b'example')
            with self.subTest(name=name), self.assertRaisesRegex(Blocked, name):
                OfficeFile(data.getvalue(),'docx')
        with self.assertRaisesRegex(Blocked,'unreadable'):
            OfficeFile(b'broken','docx')

    def test_shared_string_lists_both_cells(self):
        from xml.etree import ElementTree as ET
        from proposal_review.office import S, PR, CT
        with ZipFile(self.xlsx) as archive:
            parts = {n: archive.read(n) for n in archive.namelist()}
        def add_child(part, ns, tag, attributes):
            root = ET.fromstring(parts[part])
            ET.SubElement(root, f'{{{ns}}}{tag}', attributes)
            parts[part] = ET.tostring(root)
        add_child('[Content_Types].xml', CT, 'Override', {
            'PartName':'/xl/sharedStrings.xml',
            'ContentType':'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'})
        add_child('xl/_rels/workbook.xml.rels', PR, 'Relationship', {
            'Id':'rIdStrings', 'Target':'sharedStrings.xml',
            'Type':'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings'})
        for i, cell in [(1,'A2'), (2,'B2')]:
            part = f'xl/worksheets/sheet{i}.xml'
            root = ET.fromstring(parts[part])
            node = root.find(f'.//{{{S}}}c[@r="{cell}"]')
            node.remove(node.find(f'{{{S}}}is'))
            node.set('t','s')
            ET.SubElement(node,f'{{{S}}}v').text = '0'
            parts[part] = ET.tostring(root)
        parts['xl/sharedStrings.xml'] = (
            f'<sst xmlns="{S}" count="2" uniqueCount="1"><si><r><t xml:space="preserve">Mira </t>'
            '</r><r><t>Example</t></r></si></sst>').encode()
        with ZipFile(self.xlsx,'w') as archive:
            for name,data in parts.items():
                archive.writestr(name,data)
        pair,changes = self.load().inspect(RULES)
        self.assertTrue(any('Budget!A2' in loc and 'Details (hidden)!B2' in loc for _,loc,_,_ in changes))
        book = load_workbook(io.BytesIO(pair[0][0]))
        self.assertEqual(book.active['A2'].value,'Person 01')
        self.assertEqual(book['Details']['B2'].value,'Person 01')

    def test_header_and_layout_control_blockers(self):
        doc = Document(self.docx)
        doc.add_paragraph('Mira\tExample')
        doc.save(self.docx)
        with self.assertRaisesRegex(Blocked, 'Justification: word/document.xml ¶3'):
            self.load().inspect(RULES)
        book = load_workbook(self.xlsx)
        book.active.oddHeader.center.text = NAME
        book.save(self.xlsx)
        with self.assertRaisesRegex(Blocked, 'Budget / oddHeader'):
            self.load().inspect(RULES)

    def test_multiple_matches_in_rich_text(self):
        from xml.dom.minidom import parseString
        from proposal_review.office import Field
        from proposal_review.case import normalize
        # Rich text substitutions must preserve offsets with overlapping terms and
        # multiple occurrences in the same run.
        nodes = parseString('<p><t>Mira </t><t>Example / Mira Example</t></p>').getElementsByTagName('t')
        field = Field('sample',[t.firstChild for t in nodes])
        aliases,pattern = normalize([(NAME,'Person 01'),('Mira','Person 01')])
        field.replace(list(pattern.finditer(field.value)),aliases)
        self.assertEqual(field.value,'Person 01 / Person 01')

    def test_incomplete_export_removed(self):
        results,_ = self.load().inspect(RULES)
        real_open = Path.open
        def fail_second(path,*args,**kwargs):
            if path.name == 'Justification.docx':
                raise OSError('simulated disk error')
            return real_open(path,*args,**kwargs)
        with patch.object(Path,'open',fail_second), self.assertRaises(OSError):
            export_pair(self.root,results)
        self.assertEqual(list(self.root.iterdir()),[self.inputs])

    def test_review_exercises_match_answer_key(self):
        for scenario in SCENARIOS:
            with self.subTest(scenario=scenario):
                folder = self.root/scenario
                build(folder,scenario)
                pair,_ = Case(folder/'input.xlsx',folder/'input.docx').inspect(RULES)
                sheet = load_workbook(io.BytesIO(pair[0][0])).active
                guidance = (folder/'exercise-guidance.txt').read_text(encoding='utf-8')
                amount = sum(sheet[cell].value for cell in ('B2','B3'))
                self.assertEqual(sheet['B4'].value,'=SUM(B2:B3)')
                self.assertIn(f'total {amount}',Document(io.BytesIO(pair[1][0])).paragraphs[1].text)
                self.assertEqual(amount>1000,scenario=='ceiling')
                self.assertEqual(sheet['A3'].value=='Entertainment',scenario=='cost')
                self.assertEqual('§1' not in guidance,scenario=='missing')
                self.assertEqual('Addendum A' in guidance,scenario=='conflict')
