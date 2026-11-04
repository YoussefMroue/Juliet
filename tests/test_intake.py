import hashlib
import io
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from proposal_review.intake import inspect_source
from proposal_review.office import Blocked, S, W, R, PR


def package(parts):
    stream = io.BytesIO()
    with ZipFile(stream, 'w') as archive:
        for name, contents in parts.items():
            archive.writestr(name, contents)
    return stream.getvalue()


def workbook(extra=None, cells=None):
    parts = {
        'xl/workbook.xml': f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets><sheet name="Budget" state="hidden" sheetId="1" r:id="rId1"/></sheets><calcPr calcMode="auto"/></workbook>',
        'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="{PR}"><Relationship Id="rId1" Type="{R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/styles.xml': f'<styleSheet xmlns="{S}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="2"/></cellXfs></styleSheet>',
        'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{S}"><sheetData><row r="4">' + (cells or '<c r="B4"><v>700</v></c><c r="B5"><v>200</v></c><c r="B6"><v>150</v></c><c r="B7"><v>25</v></c><c r="B8"><f>SUM(B4:B6)</f><v>900</v></c><c r="D12" s="1"><v>10.004</v></c><c r="C10"><f>[1]Rates!A1</f></c>') + '</row></sheetData></worksheet>'
    }
    parts.update(extra or {})
    return package(parts)


class SourceIntakeTests(unittest.TestCase):
    def test_formula_cache_inputs_and_modeled_rounding_remain_distinct(self):
        raw = workbook()
        original = bytes(raw)
        result = inspect_source(raw, 'xlsx')
        entries = {item['anchor'].split('!')[-1]: item for item in result['items']}
        self.assertEqual(sum(int(entries[ref]['storedValue']) for ref in ['B4', 'B5', 'B6']), 1050)
        self.assertEqual(entries['B8']['formula'], 'SUM(B4:B6)')
        self.assertEqual(entries['B8']['cachedValue'], '900')
        self.assertEqual(entries['B8']['references'], ['B4:B6'])
        self.assertNotIn('B7', entries['B8']['references'])
        self.assertEqual(entries['B7']['storedValue'], '25')
        self.assertEqual(entries['D12']['storedValue'], '10.004')
        self.assertEqual(entries['D12']['displayValue'], '10.00')
        self.assertEqual(entries['D12']['numberFormat'], '0.00')
        self.assertIsNone(entries['C10']['cachedValue'])
        self.assertIn('hidden', entries['B4']['anchor'])
        self.assertEqual(raw, original)
        self.assertEqual(result['sha256'], hashlib.sha256(original).hexdigest())
        self.assertTrue(any(row['feature'] == 'external or dynamic formula' for row in result['limitations']))
        self.assertTrue(any('No engine' in row['message'] for row in result['limitations']))

    def test_external_relationships_are_not_opened(self):
        relations = f'<Relationships xmlns="{PR}"><Relationship Id="rId1" Type="{R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="{R}/externalLink" TargetMode="External" Target="https://example.invalid/private.xlsx"/></Relationships>'
        result = inspect_source(workbook({'xl/_rels/workbook.xml.rels': relations}), 'xlsx')
        self.assertEqual(len(result['items']), 7)
        self.assertTrue(any(row['feature'] == 'external relationship' for row in result['limitations']))
        self.assertNotIn('https://example.invalid', str(result))

    def test_alternate_content_and_binary_objects_are_reported_without_weakening_redaction(self):
        xml = f'<worksheet xmlns="{S}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><sheetData><row r="1"><c r="A1"><v>5</v></c></row></sheetData><mc:AlternateContent><mc:Fallback><c r="A2"><v>999</v></c></mc:Fallback></mc:AlternateContent></worksheet>'
        raw = workbook({'xl/worksheets/sheet1.xml': xml, 'xl/media/image1.emf': b'fictional binary'})
        result = inspect_source(raw, 'xlsx')
        self.assertEqual(len(result['items']), 1)
        self.assertEqual(result['items'][0]['storedValue'], '5')
        self.assertEqual(result['coverage'], 'partial')
        self.assertTrue(any(row['feature'] == 'AlternateContent' for row in result['limitations']))
        self.assertTrue(any('image1.emf' in row['location'] for row in result['limitations']))

    def test_shared_formula_is_not_invented_or_evaluated(self):
        result = inspect_source(workbook(cells='<c r="A1"><f t="shared" si="0">B4*2</f><v>1400</v></c><c r="A2"><f t="shared" si="0"/><v>400</v></c>'), 'xlsx')
        self.assertEqual(result['items'][1]['formula'], '')
        self.assertEqual(result['items'][1]['cachedValue'], '400')
        self.assertEqual(sum(x['feature'] == 'formula structure' for x in result['limitations']), 2)

    def test_docx_tables_have_stable_locations_and_rendering_limitations(self):
        doc = f'<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>Narrative paragraph.</w:t></w:r></w:p><w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>Supplies</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3500</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
        raw = package({'word/document.xml':doc, 'word/media/image1.emf':b'not interpreted'})
        result = inspect_source(raw, 'docx')
        self.assertEqual([row['text'] for row in result['items']], ['Narrative paragraph.', 'Supplies', '3500'])
        self.assertIn('table 1 row 1 cell 2', result['items'][2]['anchor'])
        self.assertTrue(any(row['feature'] == 'layout' for row in result['limitations']))
        self.assertTrue(any('image1.emf' in row['location'] for row in result['limitations']))

    def test_docx_alternatives_tracked_changes_and_dynamic_fields_are_not_silently_flattened(self):
        doc = f'<w:document xmlns:w="{W}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body><w:p><w:r><w:t>Readable</w:t></w:r></w:p><w:p><w:ins><w:r><w:t>Tracked</w:t></w:r></w:ins></w:p><mc:AlternateContent><mc:Choice><w:p><w:r><w:t>Alternative</w:t></w:r></w:p></mc:Choice></mc:AlternateContent><w:p><w:fldSimple><w:r><w:t>Field</w:t></w:r></w:fldSimple></w:p></w:body></w:document>'
        result = inspect_source(package({'word/document.xml':doc}), 'docx')
        self.assertEqual([row['text'] for row in result['items']], ['Readable'])
        self.assertTrue(any('ins' in row['feature'] for row in result['limitations']))
        self.assertTrue(any('AlternateContent' in row['feature'] for row in result['limitations']))

    def test_oversized_paragraph_is_split_with_explicit_segment_anchors(self):
        doc = f'<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>{"A" * 6500}</w:t></w:r></w:p></w:body></w:document>'
        result = inspect_source(package({'word/document.xml':doc}), 'docx')
        self.assertEqual([len(row['text']) for row in result['items']], [6000, 500])
        self.assertIn('segment 2/2', result['items'][1]['anchor'])

    def test_duplicate_cell_rejected(self):
        with self.assertRaisesRegex(Blocked, 'duplicate cell'):
            inspect_source(workbook(cells='<c r="A1"><v>1</v></c><c r="A1"><v>2</v></c>'), 'xlsx')

    def test_unsafe_names_and_duplicate_parts_rejected(self):
        for parts in [{'../outside.xml':'x'}, {'xl/A.xml':'x','xl/a.xml':'y'}, {'/absolute.xml':'x'}]:
            with self.subTest(parts=parts), self.assertRaisesRegex(Blocked, 'unsafe|duplicate'):
                inspect_source(package(parts), 'xlsx')

    def test_entities_and_dtd_are_rejected_before_parsing(self):
        xml = f'<!DOCTYPE workbook [<!ENTITY secret SYSTEM "file:///not-readable">]><workbook xmlns="{S}">&secret;</workbook>'
        with self.assertRaisesRegex(Blocked, 'entities|DTDs'):
            inspect_source(workbook({'xl/workbook.xml':xml}), 'xlsx')

    def test_relationship_cannot_escape_package(self):
        relations = f'<Relationships xmlns="{PR}"><Relationship Id="rId1" Type="{R}/worksheet" Target="../../outside.xml"/></Relationships>'
        with self.assertRaisesRegex(Blocked, 'outside'):
            inspect_source(workbook({'xl/_rels/workbook.xml.rels':relations}), 'xlsx')

    def test_deeply_nested_xml_fails_before_text_traversal(self):
        xml = '<root>' * 130 + '</root>' * 130
        with self.assertRaisesRegex(Blocked, 'nesting limit'):
            inspect_source(workbook({'xl/workbook.xml':xml}), 'xlsx')

    def test_missing_style_is_not_claimed_as_general_format(self):
        with self.assertRaisesRegex(Blocked, 'invalid cell style'):
            inspect_source(workbook({'xl/styles.xml':f'<styleSheet xmlns="{S}"/>'}), 'xlsx')

    def test_resource_limit_fails_instead_of_silent_truncation(self):
        with patch('proposal_review.intake.MAX_ITEMS', 2), self.assertRaisesRegex(Blocked, 'limit'):
            inspect_source(workbook(), 'xlsx')

    def test_unsupported_and_invalid_sources_fail_closed(self):
        with self.assertRaisesRegex(Blocked, 'Only XLSX'):
            inspect_source(b'old workbook', 'xls')
        with self.assertRaisesRegex(Blocked, 'Unreadable'):
            inspect_source(b'not zip', 'xlsx')


if __name__ == '__main__':
    unittest.main()
