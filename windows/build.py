"""Build the Windows pilot on an approved Windows build computer."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def build():
    if sys.platform != 'win32':
        raise SystemExit('Build the Windows executable on Windows with the target Python architecture.')
    out = ROOT / 'dist'
    out.mkdir(exist_ok=True)
    destination = out / 'Proposal Review'
    if destination.exists():
        raise SystemExit('Move the previous dist/Proposal Review folder before building again.')
    subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-v'], cwd=ROOT, check=True,
                   env={**os.environ, 'PROPOSAL_TEST_DESKTOP': '1'})
    with tempfile.TemporaryDirectory(dir=out) as tmp:
        stage = Path(tmp)
        subprocess.run([
            sys.executable, '-m', 'PyInstaller', '--onedir', '--windowed', '--noupx',
            '--specpath', str(stage), '--workpath', str(stage / 'work'),
            '--distpath', str(stage / 'bundle'), str(ROOT / 'Proposal Review.pyw')
        ], cwd=ROOT, check=True)
        bundle = stage / 'bundle' / 'Proposal Review'
        if not (bundle / 'Proposal Review.exe').is_file():
            raise SystemExit('Expected Windows executable missing from build.')
        shutil.copyfile(ROOT / 'windows' / 'Start here.txt', bundle / 'Start here.txt')
        kit = bundle / 'Review kit'
        kit.mkdir()
        for sheet in sorted((ROOT / 'review-kit').glob('*.md')):
            shutil.copyfile(sheet, kit / (sheet.stem + '.txt'))
        subprocess.run([sys.executable, '-m', 'tests.exercises', str(bundle / 'Practice cases')],
                       cwd=ROOT, check=True)
        bundle.rename(destination)
    print(f'Windows pilot folder ready for testing: {destination}')


if __name__ == '__main__':
    build()
