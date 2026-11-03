"""Generate fictional inputs for the review-kit exercises."""
import sys
from pathlib import Path

from docx import Document
from openpyxl import Workbook

NAME = 'Mira Example'
SCENARIOS = ('clean', 'ceiling', 'cost', 'missing', 'conflict')


def build(folder, scenario):
    folder.mkdir()
    if scenario not in SCENARIOS:
        raise ValueError('Unknown exercise')
    category = 'Entertainment' if scenario == 'cost' else 'Supplies'
    amount = 400 if scenario == 'ceiling' else 200
    book = Workbook()
    sheet = book.active
    sheet.title = 'Budget'
    sheet.append(['Personnel', 'Amount', 'Contact'])
    sheet.append([NAME, 700, 'mira@example.invalid'])
    sheet.append([category, amount])
    sheet.append(['Total', '=SUM(B2:B3)'])
    sheet.column_dimensions['A'].width = 24
    hidden = book.create_sheet('Details')
    hidden.sheet_state = 'hidden'
    hidden['B2'] = f'{NAME} / employee XQ-417'
    book.properties.creator = NAME
    book.save(folder/'input.xlsx')

    doc = Document()
    paragraph = doc.add_paragraph()
    paragraph.add_run('Mira ').bold = True
    paragraph.add_run('Example')
    paragraph.add_run(' will perform the research.')
    doc.add_paragraph(f'Personnel 700 and {category.lower()} {amount} total {700+amount}.')
    doc.sections[0].header.paragraphs[0].text = NAME
    doc.sections[0].footer.paragraphs[0].text = 'mira@example.invalid'
    doc.add_comment(paragraph.runs, text='Verified by Mira Example', author=NAME, initials='MX')
    doc.core_properties.author = NAME
    doc.save(folder/'input.docx')
    text = 'Fictional exercise EX-001. Period 1. Amounts in USD.\n'
    if scenario != 'missing':
        text += ('Exercise Guidelines v1. §1 Total costs may not exceed 1,000.\n'
                 '§2 Personnel and supplies are allowable. Entertainment is unallowable.\n')
    if scenario == 'conflict':
        text += 'Addendum A. The total cost ceiling is 800. Applicability and precedence unspecified.\n'
    (folder/'exercise-guidance.txt').write_text(text, encoding='utf-8')


if __name__ == '__main__':
    dest = Path(sys.argv[1])
    dest.mkdir()
    for case in SCENARIOS:
        build(dest/case, case)
