from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

from proposal_review.case import Case
from proposal_review.projects import create_project, projects, review_rounds, save_round
from .exercises import build

KIT = Path(__file__).resolve().parents[1]/'review-kit'


class ProjectTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)
        self.root = folder/'Local cases'
        src = folder/'sample'
        build(src,'clean')
        self.case = Case(src/'input.xlsx',src/'input.docx')
        self.results,_ = self.case.inspect([('Mira Example','Person 01')])

    def test_isolated_projects_and_versioned_documents(self):
        first = create_project(self.root,'Same title','A-01')
        second = create_project(self.root,'Same title','A-02')
        self.assertEqual(len(projects(self.root)),2)
        one = save_round(first,self.case,self.results,KIT)
        notes = one/'04 Review'/'03-findings.md'
        notes.write_text('First-round corrections.',encoding='utf-8')
        two = save_round(first,self.case,self.results,KIT)
        other = save_round(second,self.case,self.results,KIT)
        self.assertEqual([p.name for p in review_rounds(first)],['Round-00001','Round-00002'])
        self.assertEqual(other.name,one.name)
        self.assertEqual(notes.read_text(encoding='utf-8'),'First-round corrections.')
        for rnd in (two,other):
            self.assertEqual((rnd/'01 Sources'/'Budget.xlsx').read_bytes(),self.case.originals[0])
            self.assertEqual((rnd/'03 Redacted'/'Budget.xlsx').read_bytes(),self.results[0][0])
            self.assertTrue((rnd/'02 Guidance').is_dir())
            self.assertEqual((rnd/'04 Review'/'03-findings.md').read_bytes(),(KIT/'03-findings.md').read_bytes())
            self.assertIn('input.xlsx',(rnd/'Review record.txt').read_text(encoding='utf-8'))

    def test_failed_or_concurrent_rounds(self):
        project = create_project(self.root,'Pilot')
        with self.assertRaises(OSError):
            save_round(project,self.case,self.results,self.root/'absent')
        self.assertEqual(list((project/'Reviews').iterdir()),[])
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(save_round,project,self.case,self.results,KIT) for _ in range(2)]
            self.assertEqual({future.result().name for future in futures},{'Round-00001','Round-00002'})
