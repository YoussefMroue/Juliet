"""Fictional workbook matching only the worksheet names in Lynn's visible notes."""
from pathlib import Path
import sys

from docx import Document
from openpyxl import load_workbook

from .exercises import build, NAME

TITLE = 'immune response pilot'


def build_lynn(folder):
    build(folder, 'clean')
    book = load_workbook(folder/'input.xlsx')
    book['Budget'].title = 'TU Year One'
    project = book.create_sheet('Project', 0)
    # Fictional positions deliberately carry no assumption about the real template.
    project['C3'] = NAME
    project['F7'] = TITLE
    book['TU Year One']['A5'] = 'Noor Fictional'
    book['TU Year One']['B5'] = 150
    book['TU Year One']['B4'] = '=SUM(B2:B3,B5)'
    book.save(folder/'input.xlsx')
    doc = Document(folder/'input.docx')
    doc.paragraphs[1].text = 'Personnel 850 and supplies 200 total 1050.'
    doc.add_paragraph(TITLE + ': Noor Fictional assists Mira Example.')
    doc.save(folder/'input.docx')


if __name__ == '__main__':
    build_lynn(Path(sys.argv[1]))
