"""Optional smoke test with a native display: PROPOSAL_TEST_DESKTOP=1."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from .exercises import build


@unittest.skipUnless(os.environ.get('PROPOSAL_TEST_DESKTOP'), 'requires a native display')
class DesktopFlow(unittest.TestCase):
    def test_approval_and_cancel(self):
        import tkinter as tk
        from tkinter import ttk
        from proposal_review.__main__ import App

        root = tk.Tk()
        self.addCleanup(root.destroy)
        app = App(root)
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
                button('Word justification').invoke()
            button('Inspect files').invoke()
            app.rules = {'Mira Example':'Person 01', 'mira@example.invalid':'Email 01','XQ-417':'ID 01','MX':'Initials 01'}
            button('Inspect redacted copies').invoke()
            root.update()
            with patch('tkinter.messagebox.showerror') as error:
                button('Export approved copies').invoke()
                error.assert_called_once()
            next(w for w in widgets(root) if isinstance(w,ttk.Checkbutton)).invoke()
            with patch('tkinter.filedialog.askdirectory',return_value=tmp), patch('tkinter.messagebox.showinfo'):
                button('Export approved copies').invoke()
            self.assertEqual(len(list(folder.glob('review-*/Budget.xlsx'))),1)
            self.assertIsNone(app.case)
            self.assertIsNone(app.results)
            with patch('tkinter.filedialog.askopenfilename',side_effect=[str(sample/'input.xlsx'),str(sample/'input.docx')]):
                button('Excel budget').invoke()
                button('Word justification').invoke()
            button('Inspect files').invoke()
            button('Cancel case').invoke()
            self.assertIsNone(app.case)
            self.assertEqual(len(list(folder.iterdir())),2)
