"""Optional smoke test with a native display: PROPOSAL_TEST_DESKTOP=1."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from .exercises import build
from proposal_review.projects import create_project


@unittest.skipUnless(os.environ.get('PROPOSAL_TEST_DESKTOP'), 'requires a native display')
class DesktopFlow(unittest.TestCase):
    def test_approval_and_cancel(self):
        import tkinter as tk
        from tkinter import ttk
        from proposal_review.__main__ import App

        root = tk.Tk()
        self.addCleanup(root.destroy)
        location = tempfile.TemporaryDirectory()
        self.addCleanup(location.cleanup)
        app = App(root, location.name)
        app.project = create_project(Path(location.name),'Synthetic case')
        app.home()
        def widgets(parent):
            for child in parent.winfo_children():
                yield child
                yield from widgets(child)
        def button(text):
            return next(w for w in widgets(root) if isinstance(w,ttk.Button) and w['text']==text)
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            sample = folder/'sample'
            build(sample,'clean')
            with patch('tkinter.filedialog.askopenfilename',side_effect=[str(sample/'input.xlsx'),str(sample/'input.docx')]):
                button('Excel budget').invoke()
                button('Justification').invoke()
            button('Inspect files').invoke()
            button('Inspect redacted copies').focus_set()
            with patch('tkinter.messagebox.showerror') as error:
                button('Inspect redacted copies').invoke()
                error.assert_called_once()
            while app.pending:
                app.rule_tree.selection_set(app.rule_tree.get_children()[0])
                button('Keep selected').invoke()
            app.rules = {'Mira Example':'Person 01', 'mira@example.invalid':'Email 01','XQ-417':'ID 01','MX':'Initials 01'}
            button('Inspect redacted copies').invoke()
            root.update()
            with patch('tkinter.messagebox.showerror') as error:
                button('Export approved copies').invoke()
                error.assert_called_once()
            next(w for w in widgets(root) if isinstance(w,ttk.Checkbutton)).invoke()
            with patch('tkinter.filedialog.askdirectory',return_value=tmp), patch('tkinter.messagebox.showinfo'):
                button('Export approved copies').invoke()
            self.assertEqual(len(list(app.project.glob('Reviews/*/03 Redacted/Budget.xlsx'))),1)
            self.assertIsNone(app.case)
            self.assertIsNone(app.results)
            with patch('tkinter.filedialog.askopenfilename',side_effect=[str(sample/'input.xlsx'),str(sample/'input.docx')]):
                button('Excel budget').invoke()
                button('Justification').invoke()
            button('Inspect files').invoke()
            button('Cancel case').invoke()
            self.assertIsNone(app.case)
            self.assertEqual(len(list(folder.iterdir())),1)

    def test_pdf_page_preview_and_saved_round(self):
        import tkinter as tk
        from tkinter import ttk
        from proposal_review.__main__ import App
        from .test_pdf import make_pdf

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            build(base/'sample','clean')
            make_pdf(base/'sample'/'input.pdf')
            root = tk.Tk()
            self.addCleanup(root.destroy)
            app = App(root, base/'projects')
            app.project = create_project(app.local_cases,'PDF pilot')
            app.home()

            def click(parent, caption):
                for widget in parent.winfo_children():
                    if isinstance(widget,ttk.Button) and widget['text']==caption:
                        widget.invoke()
                        return True
                    if click(widget,caption):
                        return True
                return False

            with patch('tkinter.filedialog.askopenfilename',side_effect=[
                    str(base/'sample'/'input.xlsx'),str(base/'sample'/'input.pdf')]):
                self.assertTrue(click(root,'Excel budget'))
                self.assertTrue(click(root,'Justification'))
            self.assertTrue(click(root,'Inspect files'))
            app.pending.clear()
            app.rules = {'Mira Example':'Person 01','mira@example.invalid':'Email 01'}
            def fail_dialog(*args,**kwargs):
                self.fail(str(args))
            with patch('tkinter.messagebox.showerror',side_effect=fail_dialog):
                self.assertTrue(click(root,'Inspect redacted copies'))
                root.update()
                self.assertTrue(click(root,'Next'))
                self.assertTrue(click(root,'Previous'))
                check = next(w for w in app.body.winfo_children() if isinstance(w,ttk.Checkbutton))
                check.invoke()
                with patch('tkinter.messagebox.showinfo'):
                    self.assertTrue(click(root,'Export approved copies'))
            self.assertTrue((app.project/'Reviews'/'Round-00001'/'03 Redacted'/'Justification.pdf').exists())
