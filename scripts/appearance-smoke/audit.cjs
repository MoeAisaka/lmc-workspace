// Prevent app-owned text from silently bypassing personalization again.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../packages/lmc-app/sources');
const files=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory()){if(e.name!=='dev')walk(p)}else if(/\.tsx?$/.test(e.name)&&!e.name.includes('.test.'))files.push(p)}}walk(root);
const issues=[],routes=[];let textSurfaces=0;
for(const p of files){const rel=path.relative(root,p),s=fs.readFileSync(p,'utf8');if(s.includes('<Text'))textSurfaces++;
 if(rel!=='components/StyledText.tsx'&&[...s.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]react-native['"]/g)].some(m=>/(^|,)\s*Text(?:\s+as\s+\w+)?\s*(,|$)/.test(m[1])))issues.push(rel+': raw Text import');
 if(!['components/ClaudeNativeDialog.tsx','components/CodeView.tsx','constants/Typography.ts'].includes(rel)&&/fontFamily:\s*['"](?:Menlo|monospace|IBMPlex[^'"]*)['"]/.test(s))issues.push(rel+': fixed font family');
 if(rel.startsWith('app/(app)/')&&!rel.endsWith('_layout.tsx'))routes.push({route:rel.slice(10),presentation:/Redirect/.test(s)?'redirect':/ItemList/.test(s)?'shared detail/list':'specialized surface'});
}
assert.deepEqual(issues,[]);console.log(JSON.stringify({textSurfaces,routes,exceptions:{'components/ClaudeNativeDialog.tsx':'Native terminal screen keeps a fixed-width grid.', 'components/CodeView.tsx':'Only native uses a fixed platform font; Web follows code preference.'}},null,2));
