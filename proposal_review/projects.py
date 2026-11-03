"""Proposal folders and immutable, numbered review submissions on local disk."""
from datetime import datetime
import json
from pathlib import Path
import re
import shutil
import tempfile
import uuid

from .office import Blocked


def create_project(root, title, reference='', sponsor=''):
    title = title.strip()
    if not title:
        raise Blocked('Enter a project title.')
    root.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r'[^A-Za-z0-9]+', '-', title).strip('-')[:36] or 'Project'
    project = root / f'P-{uuid.uuid4().hex[:8]}-{slug}'
    project.mkdir()
    try:
        record = {'title': title, 'reference': reference.strip(), 'sponsor': sponsor.strip()}
        (project/'project.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
        (project/'Inbox').mkdir()
        (project/'Reviews').mkdir()
    except BaseException:
        shutil.rmtree(project)
        raise
    return project


def projects(root):
    entries = []
    for file in sorted(root.glob('P-*/project.json')):
        record = json.loads(file.read_text(encoding='utf-8'))
        label = ' · '.join(filter(None, (record['title'], record['reference'], record['sponsor'],
                                        file.parent.name[:10])))
        entries.append((label, file.parent))
    return sorted(entries, key=lambda row: row[0].casefold())


def review_rounds(project):
    return sorted(p for p in (project/'Reviews').iterdir()
                  if p.is_dir() and re.fullmatch(r'Round-\d{5}', p.name))


def save_round(project, case, results, kit):
    kinds = [document.kind for _,document in results]
    if kinds not in (['xlsx','pdf'], ['xlsx','docx']):
        raise Blocked('Inspect both documents before saving a round.')
    reviews = project/'Reviews'
    stage = Path(tempfile.mkdtemp(prefix='.preparing-',dir=reviews))
    try:
        sources = stage/'01 Sources'
        guidance = stage/'02 Guidance'
        approved = stage/'03 Redacted'
        work = stage/'04 Review'
        for folder in (sources,guidance,approved,work):
            folder.mkdir()
        for name,original,(redacted,_) in zip(('Budget.xlsx','Justification.'+kinds[1]),
                                               case.originals,results):
            (sources/name).write_bytes(original)
            (approved/name).write_bytes(redacted)
        for template in ('01-intake','02-review-instructions','03-findings'):
            path = kit/(template+'.md')
            if not path.exists():  # The optional Windows bundle uses plain text.
                path = kit/(template+'.txt')
            shutil.copyfile(path,work/path.name)
        record = json.loads((project/'project.json').read_text(encoding='utf-8'))
        date = datetime.now().astimezone().isoformat(timespec='seconds')
        rounds = review_rounds(project)
        number = int(rounds[-1].name[6:])+1 if rounds else 1
        while number <= 99999:
            dest = reviews/f'Round-{number:05}'
            (stage/'Review record.txt').write_text(
                f'{record["title"]} | {dest.name}\nProposal reference: {record["reference"]}\n'
                f'Sponsor: {record["sponsor"]}\nApproved local export: {date}\n\n'
                f'Original budget filename: {case.filenames[0]}\n'
                f'Original justification filename: {case.filenames[1]}\n\n'
                '01 Sources — original inputs saved locally.\n'
                '02 Guidance — place the governing solicitation, amendments and institutional rules here.\n'
                '03 Redacted — reviewer-approved copies for the manual review workflow.\n'
                '04 Review — complete the intake, use the instructions and record findings and disposition.\n',
                encoding='utf-8')
            try:
                stage.rename(dest)
                return dest
            except OSError:
                if not dest.is_dir():
                    raise
                number += 1
        raise Blocked('This project has reached its review-round limit.')
    finally:
        if stage.exists():
            shutil.rmtree(stage)
