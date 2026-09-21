const fs=require('fs'),path=require('path'),{createRequire}=require('module');
const root=process.argv[2],out=process.argv[3],req=createRequire(path.join(root,'package.json'));
const seen=new Map();
function add(name,from){
 let dir;try{dir=path.dirname(from.resolve(name+'/package.json'));}catch{dir=path.dirname(from.resolve(name));}
 while(!fs.existsSync(path.join(dir,'package.json'))||JSON.parse(fs.readFileSync(path.join(dir,'package.json'))).name!==name){const parent=path.dirname(dir);if(parent===dir)throw Error(name);dir=parent;}
 const pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json')));
 if(seen.has(name)){if(seen.get(name)!==pkg.version)throw Error('Conflicting '+name);return;}
 seen.set(name,pkg.version);
 const local=createRequire(path.join(dir,'package.json'));
 for(const dep of Object.keys(pkg.dependencies||{}))add(dep,local);
 const dest=path.join(out,'node_modules',name);fs.mkdirSync(path.dirname(dest),{recursive:true});
 fs.cpSync(dir,dest,{recursive:true,dereference:true,filter:src=>!src.slice(dir.length).split(path.sep).includes('node_modules')});
}
add('unpdf',req);add('mammoth',req);
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(Object.fromEntries(seen),null,2));
console.log('Packed '+seen.size+' parser packages');
