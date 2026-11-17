#!/usr/bin/env python3
"""Package the installed Electron runtime with an explicit source allowlist."""
import json
import plistlib
import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
meta = json.loads((root / 'package.json').read_text())
arch = subprocess.check_output(['uname', '-m'], text=True).strip()
if arch != 'arm64':
    raise SystemExit('This package target requires macOS Apple Silicon')
out = root / 'dist'
app = out / 'Lotus.app'
out.mkdir(exist_ok=True)
if app.exists():
    shutil.rmtree(app)
shutil.copytree(root / 'node_modules/electron/dist/Electron.app', app, symlinks=True)
resources = app / 'Contents/Resources'
(resources / 'default_app.asar').unlink(missing_ok=True)
bundle = resources / 'app'
bundle.mkdir()
for name in ['src', 'dify']:
    shutil.copytree(root / name, bundle / name)
for name in ['package.json', 'README.md', 'PRIVACY.md']:
    shutil.copy2(root / name, bundle / name)
# Include all installed production dependencies, including nested dependencies.
paths = subprocess.check_output(['npm', 'ls', '--omit=dev', '--all', '--parseable'], cwd=root, text=True)
for line in paths.splitlines()[1:]:
    source = Path(line)
    relative = source.relative_to(root)
    target = bundle / relative
    if not target.exists():
        shutil.copytree(source, target, symlinks=True)
plist = app / 'Contents/Info.plist'
with plist.open('rb') as f:
    info = plistlib.load(f)
info.update(CFBundleName='Lotus', CFBundleDisplayName='Lotus', CFBundleIdentifier='com.xhdnoah.lotus-writer', CFBundleShortVersionString=meta['version'], CFBundleVersion=meta['version'])
with plist.open('wb') as f:
    plistlib.dump(info, f)
subprocess.run(['codesign', '--force', '--deep', '--sign', '-', str(app)], check=True)
archive = out / f"Lotus-{meta['version']}-macOS-arm64.zip"
subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(archive)], check=True)
print(archive)
