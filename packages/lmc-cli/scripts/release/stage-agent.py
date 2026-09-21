import os,sys,json,hashlib,shutil,pathlib,subprocess
source=pathlib.Path(sys.argv[1]);old=pathlib.Path(sys.argv[2]);home=pathlib.Path.home();tag=sys.argv[3]
target=home/'.lmc/agent-releases'/tag
if target.exists(): raise SystemExit('Release directory already exists')
target.mkdir(parents=True)
for name in ['dist','bin']:
 shutil.copytree(source/name,target/name)
shutil.copy2(source/'package.json',target/'package.json')
deps=target/'node_modules';deps.mkdir()
# Preserve the existing resolved dependency layers, without copying runtime data.
layers=[old.parent.parent/'node_modules',old/'node_modules']
for layer in layers:
 if not layer.is_dir():continue
 for item in layer.iterdir():
  if item.name.startswith('@') and item.is_dir():
   scope=deps/item.name;scope.mkdir(exist_ok=True)
   for child in item.iterdir():
    link=scope/child.name
    if link.is_symlink():link.unlink()
    if not link.exists():link.symlink_to(child.resolve())
  else:
   link=deps/item.name
   if link.is_symlink():link.unlink()
   if not link.exists():link.symlink_to(item.resolve())
# A release may carry a portable overlay for newly introduced runtime packages.
# Replace links inside this new release only; never mutate the previous release.
overlay=source/'runtime-dependencies/node_modules'
if overlay.is_dir():
 for package in overlay.iterdir():
  if not package.is_dir() or package.name.startswith('.'):continue
  items=list(package.iterdir()) if package.name.startswith('@') else [package]
  for item in items:
   if not item.is_dir() or item.name.startswith('.'):continue
   dest=deps/item.relative_to(overlay)
   if dest.is_symlink():dest.unlink()
   if dest.exists():raise SystemExit('Dependency overlay conflicts with '+str(dest))
   dest.parent.mkdir(parents=True,exist_ok=True)
   shutil.copytree(item,dest)
node=shutil.which('node')
if not node:raise SystemExit('node must be on PATH')
# Parse and import the staged library before activating anything.
subprocess.run([node,'--check',str(target/'dist/index.mjs')],check=True)
subprocess.run([node,'--input-type=module','-e',"await import("+json.dumps(str(target/'dist/lib.mjs'))+"); console.log('staged library loaded')"],check=True)
if (target/'bin/resource-text-worker.mjs').exists():
 # Resolve parser packages from the release itself, not the build workspace.
 subprocess.run([node,'--input-type=module','-e',"import {createRequire} from 'node:module'; const r=createRequire("+json.dumps(str(target/'package.json'))+"); r.resolve('unpdf'); r.resolve('mammoth'); console.log('document parser dependencies resolved');"],check=True)
release={'engine':'agent','version':json.loads((target/'package.json').read_text())['version'],'directory':str(target),'sha256':hashlib.sha256((target/'dist/index.mjs').read_bytes()).hexdigest()}
# Catalog contains code release location and digest only.
cat=home/'.lmc/agent/agent-release-catalog.json'
if cat.exists():shutil.copy2(cat,home/('.lmc/agent-release-catalog-before-'+tag+'.json'))
tmp=cat.with_suffix('.tmp');tmp.write_text(json.dumps(release));os.chmod(tmp,0o600);os.replace(tmp,cat)
print(json.dumps(release))
