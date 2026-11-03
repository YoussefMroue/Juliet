from pathlib import Path
import tempfile
import unittest

import pymupdf as pdf

from proposal_review.case import Case, export_pair
from proposal_review.office import Blocked
from proposal_review.pdf import PdfFile
from .exercises import NAME, build


def make_pdf(path):
    with pdf.open() as doc:
        for number in range(2):
            page = doc.new_page(width=540, height=720)
            page.insert_text((48,68),'Budget justification',fontsize=20)
            page.draw_line((48,80),(482,80),color=(0.2,0.3,0.4))
            page.insert_text((48,121),'Mira Example serves as Principal Investigator.')
            page.insert_text((48,145),'Salary $700. Effort 25%. Supplies $200.')
            page.insert_text((48,169),'Contact mira@example.invalid for details.')
            page.insert_text((48,640),f'Page {number+1}')
        doc.set_metadata({'author':NAME,'subject':'Private internal notes'})
        doc.save(path)


class PdfPilot(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.sample = self.root/'case'
        build(self.sample,'clean')
        self.pdf = self.sample/'original.pdf'
        make_pdf(self.pdf)

    def test_pair_layout_pixels_and_selectable_text(self):
        original = self.pdf.read_bytes()
        case = Case(self.sample/'input.xlsx',self.pdf)
        pair,changes = case.inspect([(NAME,'Person 01'),('mira@example.invalid','Email 01')])
        dest = export_pair(self.root,pair)
        self.assertTrue((dest/'Budget.xlsx').exists())
        self.assertEqual(self.pdf.read_bytes(),original)
        self.assertTrue(any('Page 2' in loc for _,loc,_,_ in changes))
        with pdf.open(dest/'Justification.pdf') as after, pdf.open(self.pdf) as before:
            self.assertEqual(len(after),2)
            self.assertFalse(after.metadata['author'])
            self.assertNotIn(b'Private internal notes',pair[1][0])
            for i,page in enumerate(after):
                self.assertEqual(page.rect,before[i].rect)
                text = ' '.join(page.get_text(sort=True).split())
                self.assertNotIn(NAME,text)
                self.assertNotIn('mira@example.invalid',text)
                self.assertIn('Person 01 serves as Principal Investigator.',text)
                self.assertIn('Salary $700. Effort 25%. Supplies $200.',text)
                self.assertIn('Email 01',text)
                # At production resolution the unaffected header, table line and
                # budget figures may differ by one antialiasing level on the original pixel grid.
                for clip in [pdf.Rect(20,20,520,94), pdf.Rect(30,128,420,152)]:
                    args = dict(matrix=pdf.Matrix(2,2),clip=clip)
                    actual = page.get_pixmap(**args).samples
                    original_pixels = before[i].get_pixmap(**args).samples
                    self.assertEqual(len(actual), len(original_pixels))
                    self.assertLessEqual(max(abs(a-b) for a,b in zip(actual,original_pixels)),1)

    def test_mixed_scan_and_attachments_block_entire_pair(self):
        for feature in ['image','attachment','annotation','blank']:
            with self.subTest(feature=feature), pdf.open(self.pdf) as doc:
                page = doc.new_page()
                if feature == 'image':
                    pix = doc[0].get_pixmap()
                    page.insert_image(page.rect,pixmap=pix)
                    page.insert_text((50,50),'Selectable OCR')
                elif feature == 'attachment':
                    doc.embfile_add('original.txt',b'sensitive source')
                elif feature == 'annotation':
                    page.add_text_annot((50,50),'private note')
                with self.assertRaises(Blocked):
                    PdfFile(doc.tobytes())

    def test_wrapped_identifier_blocks(self):
        with pdf.open() as doc:
            page = doc.new_page()
            page.insert_text((42,84),'Mira')
            page.insert_text((42,104),'Example')
            doc.save(self.root/'wrapped.pdf')
        case = Case(self.sample/'input.xlsx',self.root/'wrapped.pdf')
        with self.assertRaisesRegex(Blocked,'crosses text lines'):
            case.inspect([(NAME,'Person 01')])
