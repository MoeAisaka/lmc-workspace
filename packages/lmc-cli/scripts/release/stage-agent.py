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
# Parse and import the staged library before activating anything.
subprocess.run(['/opt/homebrew/bin/node','--check',str(target/'dist/index.mjs')],check=True)
subprocess.run(['/opt/homebrew/bin/node','--input-type=module','-e',"await import("+json.dumps(str(target/'dist/lib.mjs'))+"); console.log('staged library loaded')"],check=True)
release={'engine':'agent','version':json.loads((target/'package.json').read_text())['version'],'directory':str(target),'sha256':hashlib.sha256((target/'dist/index.mjs').read_bytes()).hexdigest()}
# Catalog contains code release location and digest only.
cat=home/'.lmc/agent/agent-release-catalog.json'
if cat.exists():shutil.copy2(cat,home/('.lmc/agent-release-catalog-before-'+tag+'.json'))
tmp=cat.with_suffix('.tmp');tmp.write_text(json.dumps(release));os.chmod(tmp,0o600);os.replace(tmp,cat)
print(json.dumps(release))
