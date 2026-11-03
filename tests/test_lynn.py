import io
from pathlib import Path
import tempfile
import unittest
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from openpyxl import load_workbook
from openpyxl.styles import Font
from openpyxl.workbook.defined_name import DefinedName

from proposal_review.lynn import inspect_budget
from proposal_review.office import Blocked, CT, PR, S
from .lynn_fixture import build_lynn, NAME, TITLE

BLANKS = [NAME, TITLE, 'Noor Fictional']
RULES = [(NAME, 'Person PI'), (TITLE, 'Project 01'), ('Noor Fictional', 'Person 02'),
         ('mira@example.invalid', 'Email 01'), ('XQ-417', 'ID 01')]


class LynnBlankCells(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name)/'fixture'
        build_lynn(self.folder)
        self.path = self.folder/'input.xlsx'

    def inspect(self, data=None, rules=RULES, blanks=BLANKS, project=(NAME, TITLE)):
        return inspect_budget(data or self.path.read_bytes(), rules, blanks, project)

    def test_actual_blank_cells_preserve_style_numbers_formulas_and_originals(self):
        book = load_workbook(self.path)
        book['Project']['C3'].font = Font(bold=True, color='123456')
        book['Project'].merge_cells('F7:G7')
        book.save(self.path)
        before = self.path.read_bytes()
        result, changes, _ = self.inspect()
        self.assertEqual(self.path.read_bytes(), before)
        after = load_workbook(io.BytesIO(result))
        for sheet, cell in [('Project', 'C3'), ('Project', 'F7'), ('TU Year One', 'A2'), ('TU Year One', 'A5')]:
            self.assertIsNone(after[sheet][cell].value)
            self.assertIn(('Budget', f'{sheet}!{cell}', book[sheet][cell].value, ''), changes)
        self.assertTrue(after['Project']['C3'].font.bold)
        self.assertEqual(after['Project']['C3'].font.color.rgb, '00123456')
        self.assertIn('F7:G7', after['Project'].merged_cells)
        self.assertEqual(after['TU Year One']['B2'].value, 700)
        self.assertEqual(after['TU Year One']['B5'].value, 150)
        self.assertEqual(after['TU Year One']['B4'].value, '=SUM(B2:B3,B5)')
        self.assertEqual(after['Details']['B2'].value, 'Person PI / employee ID 01')
        with ZipFile(io.BytesIO(result)) as z:
            for part in z.namelist():
                for term in BLANKS:
                    self.assertNotIn(term, z.read(part).decode())
            root = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
            for address in ['C3', 'F7']:
                cell = root.find(f'.//{{{S}}}c[@r="{address}"]')
                self.assertEqual(list(cell), [])
                self.assertNotIn('t', cell.attrib)

    def test_substrings_cannot_satisfy_project_identity(self):
        for blanks, project in [(['ir', 'mm'], ['ir', 'mm']), ([NAME, 'immune'], [NAME, 'immune'])]:
            with self.subTest(blanks=blanks), self.assertRaises(Blocked):
                self.inspect(rules=[(term, 'Removed') for term in blanks], blanks=blanks, project=project)

    def test_mixed_content_is_not_erased(self):
        book = load_workbook(self.path)
        book['TU Year One']['A5'] = 'Noor Fictional — Research Assistant'
        book.save(self.path)
        with self.assertRaisesRegex(Blocked, 'shares a cell with other text'):
            self.inspect()

    def test_missing_worksheet_or_missing_blank_target_blocks(self):
        with self.assertRaisesRegex(Blocked, 'not found as standalone'):
            self.inspect(rules=RULES+[('Nobody Here', 'Person 03')], blanks=BLANKS+['Nobody Here'])
        book = load_workbook(self.path)
        book['Project'].title = 'Different template'
        book.save(self.path)
        with self.assertRaisesRegex(Blocked, 'requires Project and TU Year One'):
            self.inspect()

    def test_blank_target_must_also_be_redacted_elsewhere(self):
        with self.assertRaisesRegex(Blocked, 'must also have a neutral replacement'):
            self.inspect(rules=[r for r in RULES if r[0] != NAME])

    def test_dependencies_block_including_ranges_and_defined_names(self):
        original = self.path.read_bytes()
        for expression in ["='Project'!$C$3", '=SUM(A1:A5)', '=SUM(A:A)', '=SUM(2:5)',
                           "=SUM(Project:Other!C3)", '=SUM(SelectedPersonnel)']:
            with self.subTest(expression=expression):
                book = load_workbook(io.BytesIO(original))
                book['TU Year One']['D10'] = expression
                if 'SelectedPersonnel' in expression:
                    book.defined_names.add(DefinedName('SelectedPersonnel', attr_text="'TU Year One'!$A$2:$A$5"))
                book.save(self.path)
                with self.assertRaisesRegex(Blocked, 'depend|cross-sheet'):
                    self.inspect()

    def test_unrelated_sheet_coordinates_do_not_block(self):
        book = load_workbook(self.path)
        book['Details']['C3'] = 12
        book['Details']['D10'] = '=SUM(C3:C4)'
        book['TU Year One']['D10'] = "='Details'!C3"
        book.save(self.path)
        result, _, _ = self.inspect()
        after = load_workbook(io.BytesIO(result))
        self.assertEqual(after['TU Year One']['D10'].value, "='Details'!C3")

    def test_lowercase_and_hidden_target_sheets_are_supported(self):
        book = load_workbook(self.path)
        book['Project'].title = 'Temporary project'
        book['Temporary project'].title = 'project'
        book['project'].sheet_state = 'hidden'
        book['TU Year One'].title = 'Temporary year'
        book['Temporary year'].title = 'tu year one'
        book.save(self.path)
        result, _, _ = self.inspect()
        after = load_workbook(io.BytesIO(result))
        self.assertIsNone(after['project']['C3'].value)
        self.assertIsNone(after['tu year one']['A2'].value)
        self.assertEqual(after['project'].sheet_state, 'hidden')

    def test_numeric_identifier_protection_is_not_bypassed(self):
        book = load_workbook(self.path)
        book['Project']['D9'] = '700'
        book.save(self.path)
        with self.assertRaisesRegex(Blocked, 'protected numeric'):
            self.inspect(rules=RULES+[('700', 'Amount removed')], blanks=BLANKS+['700'])

    def test_shared_and_rich_text_cells_blank_without_leaving_private_strings(self):
        book = load_workbook(self.path)
        book['Details']['D9'] = NAME  # This sheet must keep its neutral label.
        book.save(self.path)
        with ZipFile(self.path) as z:
            parts = {name: z.read(name) for name in z.namelist()}
        types = ET.fromstring(parts['[Content_Types].xml'])
        ET.SubElement(types, f'{{{CT}}}Override', {'PartName': '/xl/sharedStrings.xml',
            'ContentType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'})
        parts['[Content_Types].xml'] = ET.tostring(types)
        rels = ET.fromstring(parts['xl/_rels/workbook.xml.rels'])
        ET.SubElement(rels, f'{{{PR}}}Relationship', {'Id': 'rIdStrings', 'Target': 'sharedStrings.xml',
            'Type': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings'})
        parts['xl/_rels/workbook.xml.rels'] = ET.tostring(rels)
        for part, address in [('xl/worksheets/sheet1.xml', 'C3'), ('xl/worksheets/sheet2.xml', 'A2'), ('xl/worksheets/sheet3.xml', 'D9')]:
            root = ET.fromstring(parts[part])
            cell = root.find(f'.//{{{S}}}c[@r="{address}"]')
            for child in list(cell):
                cell.remove(child)
            cell.set('t', 's')
            ET.SubElement(cell, f'{{{S}}}v').text = '0'
            parts[part] = ET.tostring(root)
        parts['xl/sharedStrings.xml'] = (
            f'<sst xmlns="{S}" count="3" uniqueCount="2"><si><r><t>Mira </t></r><r><t>Example</t></r></si>'
            '<si><t>Noor Fictional</t></si></sst>').encode()
        data = io.BytesIO()
        with ZipFile(data, 'w') as z:
            for name, raw in parts.items():
                z.writestr(name, raw)
        result, _, _ = self.inspect(data.getvalue())
        after = load_workbook(io.BytesIO(result))
        self.assertIsNone(after['Project']['C3'].value)
        self.assertIsNone(after['TU Year One']['A2'].value)
        self.assertEqual(after['Details']['D9'].value, 'Person PI')
        with ZipFile(io.BytesIO(result)) as z:
            shared = z.read('xl/sharedStrings.xml').decode()
            self.assertNotIn('Mira', shared)
            self.assertNotIn('Noor Fictional', shared)
            self.assertEqual(ET.fromstring(shared).get('count'), '1')
