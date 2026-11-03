"""Launch with python3 -m proposal_review."""
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from .case import Case, candidate_terms, export_pair
from .office import Blocked


class App:
    def __init__(self, root):
        self.root = root
        root.title('Proposal Review')
        root.geometry('1080x740')
        self.body = ttk.Frame(root, padding=16)
        self.body.pack(expand=True, fill='both')
        root.protocol('WM_DELETE_WINDOW', root.destroy)
        root.report_callback_exception = self.unexpected_error
        self.home()

    def unexpected_error(self, _kind, _error, _traceback):
        # Keep sensitive case text out of terminal tracebacks.
        self.home()
        self.error('The case was closed after an unexpected error. Reopen the source files to retry.')

    def clear(self):
        for child in self.body.winfo_children():
            child.destroy()

    def home(self):
        self.clear()
        self.case = self.results = None
        self.rules = {}
        ttk.Label(self.body, text='Proposal Review', font=('TkDefaultFont', 22, 'bold')).pack(anchor='w')
        ttk.Label(self.body, text='Choose one budget and its justification. Inspection runs on this computer.').pack(anchor='w', pady=10)
        paths = []
        for label, ext in [('Excel budget','xlsx'), ('Word justification','docx')]:
            row = ttk.Frame(self.body)
            row.pack(fill='x', pady=6)
            var = tk.StringVar()
            paths.append(var)
            def choose(v=var, e=ext):
                path = filedialog.askopenfilename(filetypes=[('Office document','*.'+e)])
                if path:
                    v.set(path)
            ttk.Button(row, text=label, command=choose, width=20).pack(side='left')
            ttk.Label(row, textvariable=var).pack(side='left', padx=8)
        def load():
            try:
                self.case = Case(*(v.get() for v in paths))
                self.rules = dict(candidate_terms(self.case.files))
                self.editor()
            except (Blocked, OSError) as exc:
                self.error(exc)
        ttk.Button(self.body, text='Inspect files', command=load).pack(anchor='w', pady=12)

    def error(self, exc):
        messagebox.showerror('Cannot continue', str(exc), parent=self.root)

    def listing(self, parent, columns, widths, height):
        frame = ttk.Frame(parent)
        frame.pack(fill='both', expand=True)
        tree = ttk.Treeview(frame, columns=columns, show='headings', height=height, selectmode='browse')
        for col, width in zip(columns, widths):
            tree.heading(col, text=col)
            tree.column(col, width=width, minwidth=50)
        bar = ttk.Scrollbar(frame, orient='vertical', command=tree.yview)
        tree.configure(yscrollcommand=bar.set)
        bar.pack(side='right', fill='y')
        tree.pack(fill='both', expand=True)
        # Wrapped detail view, including multi-line or very long Office text.
        detail = tk.Text(parent, height=4, wrap='word', state='disabled', exportselection=False)
        detail.pack(fill='x')
        def show(_):
            detail.configure(state='normal')
            detail.delete('1.0','end')
            if tree.selection():
                detail.insert('1.0','\n'.join(map(str, tree.item(tree.selection()[0], 'values'))))
            detail.configure(state='disabled')
        tree.bind('<<TreeviewSelect>>', show)
        return tree

    def editor(self):
        self.clear()
        self.results = None
        ttk.Label(self.body, text='Review identifiers', font=('TkDefaultFont',18,'bold')).pack(anchor='w')
        ttk.Label(self.body, text='Suggestions can miss names or match harmless text. Review both files. Add aliases with the same replacement for one person.').pack(anchor='w', pady=5)
        notebook = ttk.Notebook(self.body)
        notebook.pack(fill='both', expand=True)
        rule_tab, text_tab = ttk.Frame(notebook), ttk.Frame(notebook)
        notebook.add(rule_tab, text='Replacement rules')
        notebook.add(text_tab, text='Original content and locations')
        self.rule_tree = self.listing(rule_tab, ('Identifier','Replacement'), (350,250), 6)
        self.text_tree = self.listing(text_tab, ('File','Location','Original content'), (100,260,500), 10)
        for office in self.case.files:
            for _, field in office.fields:
                self.text_tree.insert('', 'end', values=(office.label,field.location,field.value))
        inputs = ttk.Frame(rule_tab)
        inputs.pack(fill='x', pady=5)
        term, label = tk.StringVar(), tk.StringVar()
        for title, var in [('Identifier',term),('Replacement',label)]:
            ttk.Label(inputs, text=title).pack(side='left')
            ttk.Entry(inputs, textvariable=var).pack(side='left',padx=4)
        def populate():
            self.rule_tree.delete(*self.rule_tree.get_children())
            for k,v in self.rules.items():
                self.rule_tree.insert('', 'end', values=(k,v))
        def select(_):
            if self.rule_tree.selection():
                k,v = self.rule_tree.item(self.rule_tree.selection()[0], 'values')
                term.set(k)
                label.set(v)
        self.rule_tree.bind('<<TreeviewSelect>>', select, add='+')
        def save():
            k,v = term.get().strip(),label.get().strip()
            if not k or not v:
                return self.error('Enter an identifier and replacement.')
            self.rules[k] = v
            populate()
        def drop():
            if self.rule_tree.selection():
                k = self.rule_tree.item(self.rule_tree.selection()[0], 'values')[0]
                self.rules.pop(k, None)
                populate()
        ttk.Button(inputs, text='Add / update', command=save).pack(side='left')
        ttk.Button(inputs, text='Remove selected', command=drop).pack(side='left')
        populate()
        def preview():
            try:
                self.results, changes = self.case.inspect(self.rules.items())
                self.preview(changes)
            except Blocked as exc:
                self.error(exc)
        self.actions('Inspect redacted copies', preview, 'Cancel case', self.home)

    def actions(self, primary, go, secondary, back):
        bar = ttk.Frame(self.body)
        bar.pack(fill='x', pady=8)
        ttk.Button(bar, text=secondary, command=back).pack(side='left')
        ttk.Button(bar, text=primary, command=go).pack(side='right')

    def preview(self, changes):
        self.clear()
        ttk.Label(self.body, text='Inspect before export', font=('TkDefaultFont',18,'bold')).pack(anchor='w')
        note = ' Previews embedded by Office were removed.' if any(o.omitted for o in self.case.files) else ''
        ttk.Label(self.body, text=f'{len(changes)} locations changed. Check the full content of both inspected copies.'+note).pack(anchor='w', pady=5)
        tabs = ttk.Notebook(self.body)
        tabs.pack(fill='both', expand=True)
        for title, cols, widths, rows in [
            ('Changes', ('File','Location','Before','After'), (100,220,320,320), changes),
            ('Redacted content', ('File','Location','Content'), (100,260,550),
             ((o.label,f.location,f.value) for _,o in self.results for _,f in o.fields))]:
            pane = ttk.Frame(tabs)
            tabs.add(pane,text=title)
            tree = self.listing(pane,cols,widths,12)
            for row in rows:
                tree.insert('', 'end', values=row)
        approved = tk.BooleanVar()
        ttk.Checkbutton(self.body,text='I inspected both copies and approve these files for local export.',variable=approved).pack(anchor='w',pady=6)
        def export():
            if not approved.get():
                return self.error('Inspect both copies and select the approval box first.')
            folder = filedialog.askdirectory(title='Where should the redacted pair be saved?')
            if folder:
                try:
                    dest = export_pair(folder,self.results)
                except (Blocked,OSError) as exc:
                    return self.error(exc)
                self.home()
                messagebox.showinfo('Export complete',f'Your reviewed copies are in\n{dest}\n\nUse the review kit for the manual handoff.')
        self.actions('Export approved copies',export,'Back to rules',self.editor)
        ttk.Button(self.body,text='Cancel case',command=self.home).pack(anchor='w')


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == '__main__':
    main()
