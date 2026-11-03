"""Launch with python3 -m proposal_review."""
import sys
import os
import subprocess
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from .case import Case, candidate_terms
from .office import Blocked
from .projects import create_project, projects, review_rounds, save_round


class App:
    def __init__(self, root, case_folder=None):
        self.root = root
        project = Path(sys.executable).parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parents[1]
        self.local_cases = Path(case_folder) if case_folder else project / 'Local cases'
        self.project = None
        self.kit = project / ('Review kit' if getattr(sys, 'frozen', False) else 'review-kit')
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
        self.pending = {}
        ttk.Label(self.body, text='Proposal Review', font=('TkDefaultFont', 22, 'bold')).pack(anchor='w')
        entries = dict(projects(self.local_cases))
        selected = tk.StringVar(value=next((name for name,path in entries.items() if path == self.project),''))
        ttk.Label(self.body,text='Open a proposal to see its reviews or start another round.').pack(anchor='w',pady=8)
        chooser = ttk.Combobox(self.body,textvariable=selected,values=list(entries),state='readonly',width=76)
        chooser.pack(anchor='w')
        def choose_project(_=None):
            self.project = entries.get(selected.get())
            self.home()
        chooser.bind('<<ComboboxSelected>>', choose_project)
        form = ttk.LabelFrame(self.body,text='New proposal')
        form.pack(fill='x',pady=8)
        initials,submitted,title = tk.StringVar(),tk.StringVar(),tk.StringVar()
        for caption,var in [('Sponsor initials',initials),('Submitted (YYYY-MM-DD)',submitted),('Title (optional)',title)]:
            ttk.Label(form,text=caption).pack(side='left',padx=3)
            ttk.Entry(form,textvariable=var,width=20).pack(side='left')
        def create():
            try:
                self.project = create_project(self.local_cases,initials.get(),submitted.get(),title.get())
                self.home()
            except (Blocked,OSError) as exc:
                self.error(exc)
        ttk.Button(form,text='Create project',command=create).pack(side='left',padx=6)
        if not self.project:
            return
        ttk.Label(self.body,text='Saved review rounds',font=('TkDefaultFont',14,'bold')).pack(anchor='w')
        rounds = review_rounds(self.project)
        history = ttk.Combobox(self.body,values=[p.name for p in reversed(rounds)],state='readonly')
        history.pack(anchor='w')
        if rounds:
            history.current(0)
        def open_folder(path):
            if sys.platform == 'win32':
                os.startfile(path)
            else:
                subprocess.Popen(['open' if sys.platform=='darwin' else 'xdg-open',str(path)])
        controls = ttk.Frame(self.body)
        controls.pack(anchor='w',pady=4)
        if rounds:
            ttk.Button(controls,text='Open saved round',command=lambda:open_folder(self.project/'Reviews'/history.get())).pack(side='left')
        ttk.Button(controls,text='Open project inbox',command=lambda:open_folder(self.project/'Inbox')).pack(side='left')
        ttk.Label(self.body, text='Choose an Excel budget and a Word or selectable-text PDF justification.').pack(anchor='w', pady=10)
        paths = []
        for label, ext in [('Excel budget','xlsx'), ('Justification','docx pdf')]:
            row = ttk.Frame(self.body)
            row.pack(fill='x', pady=6)
            var = tk.StringVar()
            paths.append(var)
            def choose(v=var, e=ext):
                inbox = self.project / 'Inbox'
                path = filedialog.askopenfilename(initialdir=inbox,filetypes=[('Supported files',tuple('*.'+part for part in e.split()))])
                if path:
                    v.set(path)
            ttk.Button(row, text=label, command=choose, width=20).pack(side='left')
            ttk.Label(row, textvariable=var).pack(side='left', padx=8)
        def load():
            try:
                self.case = Case(*(v.get() for v in paths))
                self.pending = dict(candidate_terms(self.case.files))
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
        ttk.Label(self.body, text='Remove full names and obvious personal identifiers. Check the suggestions and keep roles, salaries and effort figures needed for review.').pack(anchor='w', pady=5)
        notebook = ttk.Notebook(self.body)
        notebook.pack(fill='both', expand=True)
        rule_tab, text_tab = ttk.Frame(notebook), ttk.Frame(notebook)
        notebook.add(rule_tab, text='Replacement rules')
        notebook.add(text_tab, text='Original content and locations')
        self.rule_tree = self.listing(rule_tab, ('Identifier','Replacement','Decision'), (350,250,130), 6)
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
            for k,v in self.pending.items():
                self.rule_tree.insert('', 'end', values=(k,v,'Needs decision'))
            for k,v in self.rules.items():
                self.rule_tree.insert('', 'end', values=(k,v,'Redact'))
        def select(_):
            if self.rule_tree.selection():
                k,v,_ = self.rule_tree.item(self.rule_tree.selection()[0], 'values')
                term.set(k)
                label.set(v)
        self.rule_tree.bind('<<TreeviewSelect>>', select, add='+')
        def save():
            k,v = term.get().strip(),label.get().strip()
            if not k or not v:
                return self.error('Enter an identifier and replacement.')
            self.pending.pop(k, None)
            self.rules[k] = v
            populate()
        def drop():
            if self.rule_tree.selection():
                k = self.rule_tree.item(self.rule_tree.selection()[0], 'values')[0]
                self.pending.pop(k, None)
                self.rules.pop(k, None)
                populate()
        ttk.Button(inputs, text='Redact term', command=save).pack(side='left')
        ttk.Button(inputs, text='Keep selected', command=drop).pack(side='left')
        populate()
        def preview():
            if self.pending:
                return self.error('Decide which suggested terms to redact or keep before inspecting the copies.')
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
        ttk.Label(self.body, text='Inspect before export · '+self.project.name, font=('TkDefaultFont',18,'bold')).pack(anchor='w')
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
        if self.results[1][1].kind == 'pdf':
            from .pdf import engine
            pane = ttk.Frame(tabs)
            tabs.add(pane, text='Redacted PDF pages')
            image_label = ttk.Label(pane)
            nav = ttk.Frame(pane)
            nav.pack()
            image_label.pack()
            page_index = 0
            def render(offset=0):
                nonlocal page_index
                pdf = engine()
                with pdf.open(stream=self.results[1][0],filetype='pdf') as doc:
                    page_index = max(0,min(len(doc)-1,page_index+offset))
                    page = doc[page_index]
                    scale = min(850/page.rect.width,390/page.rect.height)
                    pix = page.get_pixmap(matrix=pdf.Matrix(scale,scale))
                    photo = tk.PhotoImage(data=pix.tobytes('ppm'),format='PPM')
                    image_label.configure(image=photo)
                    image_label.image = photo
                    number.configure(text=f'Page {page_index+1} of {len(doc)}')
            ttk.Button(nav,text='Previous',command=lambda:render(-1)).pack(side='left')
            number = ttk.Label(nav)
            number.pack(side='left',padx=8)
            ttk.Button(nav,text='Next',command=lambda:render(1)).pack(side='left')
            render()
        approved = tk.BooleanVar()
        ttk.Checkbutton(self.body,text='Save this round locally with its originals, redacted copies and review documents.',variable=approved).pack(anchor='w',pady=6)
        def export():
            if not approved.get():
                return self.error('Inspect both copies and select the approval box first.')
            try:
                dest = save_round(self.project,self.case,self.results,self.kit)
            except (Blocked,OSError) as exc:
                return self.error(exc)
            self.home()
            messagebox.showinfo('Review saved',f'Your review round is in\n{dest}\n\n03 Redacted holds the approved pair.')
        self.actions('Export approved copies',export,'Back to rules',self.editor)
        ttk.Button(self.body,text='Cancel case',command=self.home).pack(anchor='w')


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == '__main__':
    main()
