import io
import json
import zipfile
from types import SimpleNamespace
from proposal_review.case import Case, candidate_terms, normalize
from proposal_review.office import OfficeFile, Blocked
from proposal_review.lynn import inspect_budget
from proposal_review.intake import inspect_source

def office_intake(data,kind):
    return json.dumps(inspect_source(data.to_py().tobytes(),kind))

def office_read(data,kind):
    file = OfficeFile(data.to_py().tobytes(), kind)
    return [(f.location, f.value) for _,f in file.fields]

def suggestions(rows):
    fields = [(None,SimpleNamespace(value=value)) for _,value in json.loads(rows)]
    return json.dumps(candidate_terms([SimpleNamespace(fields=fields)]))

def office_edit(data,kind,rules,blank_terms='[]',project_terms='[]'):
    raw = data.to_py().tobytes()
    if json.loads(blank_terms):
        if kind != 'xlsx':
            raise Blocked('Blank cell mode is only available for the workbook.')
        result,changes,checked = inspect_budget(raw,json.loads(rules),json.loads(blank_terms),json.loads(project_terms))
        return result, json.dumps(changes), json.dumps([(f.location,f.value) for _,f in checked.fields])
    # Use the desktop case inspector on one Office input in browser memory.
    case = Case.__new__(Case)
    case.originals = [raw]
    case.files = [OfficeFile(raw,kind)]
    results,changes = case.inspect(json.loads(rules))
    return results[0][0], json.dumps(changes), json.dumps([(f.location,f.value) for _,f in results[0][1].fields])

def pdf_matches(lines_json,rules_json):
    labels,pattern = normalize(json.loads(rules_json))
    lines = json.loads(lines_json)
    edits = [[(m.start(),m.end(),labels[m.lastgroup]) for m in pattern.finditer(line)] if pattern else [] for line in lines]
    if pattern and sum(map(len,edits)) != sum(1 for _ in pattern.finditer(' '.join(lines))):
        raise Blocked('Identifier crosses PDF lines. Prepare a safe source copy.')
    return json.dumps(edits)

def check_residual(text,rules):
    _, pattern = normalize(json.loads(rules))
    if pattern and pattern.search(' '.join(text.split())):
        raise Blocked('A confirmed identifier remains in the saved PDF.')

def archive_round(files):
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,data in files.to_py().items():
            archive.writestr(name, data if isinstance(data,str) else bytes(data))
    return stream.getvalue()
