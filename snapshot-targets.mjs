import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createFsutilUsnJournal } from './usn-journal.mjs';

export const inside = (root, value) => {
  const relative = path.relative(root, value);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const samePath = (left, right) => path.relative(left, right) === '';
const excluded = new Set(['node_modules','target','.next','.git','.cache','test-results','playwright-report']);
const stamp = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.mode}`;
const fileId = s => {
  if(typeof s.ino==='number'&&!Number.isSafeInteger(s.ino))throw new Error('Unsafe numeric NTFS file ID');
  return BigInt(s.ino).toString(16).padStart(16,'0');
};
const incrementalFallback = message => Object.assign(new Error(message),{code:'MUSU_USN_FALLBACK'});
const journalCovers = (result,startUsn,journalId) => result.journalId===journalId&&
  BigInt(startUsn)>=BigInt(result.firstUsn)&&BigInt(result.nextUsn)>=BigInt(startUsn);

async function loadHashIndex(backupRoot,roots,maxEntries) {
  const file=path.join(backupRoot,'indexes','full-snapshot.json');
  try {
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024*1024) return null;
    const parsed=JSON.parse(await fs.readFile(file,'utf8'));
    if(parsed?.version!==1||!Array.isArray(parsed.roots)||parsed.roots.length!==roots.length||
      parsed.roots.some((root,index)=>!samePath(root,roots[index]))||typeof parsed.journalId!=='string'||
      !/^[0-9a-f]+$/.test(parsed.journalId)||!/^\d+$/.test(parsed.nextUsn)||
      !parsed.items||Array.isArray(parsed.items)||typeof parsed.items!=='object'||Object.keys(parsed.items).length>maxEntries) return null;
    for(const [name,item] of Object.entries(parsed.items)) {
      if(!roots.some(root=>inside(root,name))||!item||typeof item!=='object'||
        !/^[0-9a-f]{16}$/.test(item.fileId)||!['file','directory','link'].includes(item.kind)) return null;
      if(item.kind==='file'&&(!item.entry||!/^[0-9a-f]{64}$/.test(item.entry.sha256)||!Number.isSafeInteger(item.entry.size))) return null;
    }
    return parsed;
  } catch(e) { if(e.code==='ENOENT'||e instanceof SyntaxError) return null; return null; }
}

async function saveHashIndex(backupRoot,index) {
  const directory=path.join(backupRoot,'indexes');
  await fs.mkdir(directory,{recursive:true});
  const destination=path.join(directory,'full-snapshot.json');
  const temporary=path.join(directory,`.full-snapshot-${process.pid}-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary,JSON.stringify(index),{flag:'wx',mode:0o600});
    await fs.rename(temporary,destination);
  } finally { await fs.rm(temporary,{force:true}); }
}

function analyzeJournal(records,currentItems,indexItems={}) {
  const currentById=new Map(),previousById=new Map(),directoryIds=new Set();
  const add=(map,name,item)=>{if(!map.has(item.fileId))map.set(item.fileId,[]);map.get(item.fileId).push([name,item]);if(item.kind==='directory')directoryIds.add(item.fileId);};
  for(const [name,item] of Object.entries(currentItems))add(currentById,name,item);
  for(const [name,item] of Object.entries(indexItems))add(previousById,name,item);
  const changedIds=new Set();let relevant=false,structural=false;
  for(const record of records) {
    const current=currentById.get(record.fileId)||[];
    const previous=previousById.get(record.fileId)||[];
    const touches=current.length>0||previous.length>0||directoryIds.has(record.parentId);
    if(!touches)continue;
    relevant=true;
    if(record.directory||current.some(([,item])=>item.kind!=='file')||previous.some(([,item])=>item.kind!=='file'))structural=true;
    changedIds.add(record.fileId);
  }
  return {changedIds,relevant,structural};
}
export async function safePath(value, cwd, roots) {
  const file = path.resolve(cwd, value);
  const root = roots.find(r => inside(r, file));
  if (!root) throw new Error('Path outside editable code/wiki roots');
  if (!samePath(await fs.realpath(root), root)) throw new Error('Workspace root must be canonical');
  let cursor = root;
  for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('Symlink or junction mutation path rejected');
      if (samePath(cursor, file) && stat.isFile() && stat.nlink > 1) throw new Error('Hard-linked mutation path rejected');
    }
    catch (e) { if (e.code === 'ENOENT') break; throw e; }
  }
  return file;
}
export async function digestFile(file, signal) {
  const h = createHash('sha256');
  const before = await fs.lstat(file);
  if (before.isSymbolicLink()) {
    const error = new Error('Symlink or junction backup object rejected');
    error.code = 'ELOOP';
    throw error;
  }
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error('Expected regular file');
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('File identity changed before read');
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) { signal?.throwIfAborted(); const { bytesRead } = await handle.read(buffer); if (!bytesRead) break; h.update(buffer.subarray(0,bytesRead)); }
    if ((await handle.stat()).size !== opened.size) throw new Error('File changed during read');
    return h.digest('hex');
  } finally { await handle.close(); }
}

export function snapshotter({ roots, backupRoot, maxFiles=100000, maxFileBytes=256*1024*1024, maxTotalBytes=16*1024**3, workers=8, minFreeBytes=0, journal=createFsutilUsnJournal(roots) }) {
  roots = roots.map(r => path.resolve(r));
  for (const n of [maxFiles,maxFileBytes,maxTotalBytes,workers]) if (!Number.isSafeInteger(n)||n<1) throw new Error('Invalid snapshot limit');
  if (!Number.isSafeInteger(minFreeBytes)||minFreeBytes<0) throw new Error('Invalid minimum free byte limit');
  if (workers>64) throw new Error('Too many workers');
  return async function snapshot(targets, options={}) {
    try { return await runSnapshot(targets,options,true); }
    catch(e) { if(e.code!=='MUSU_USN_FALLBACK')throw e; return runSnapshot(targets,options,false); }
  };
  async function runSnapshot(targets, { signal, full=false, tool='file-change', progress=()=>{} }={}, allowIncremental) {
    const id = `${Date.now()}-${randomUUID()}`;
    const entries = Object.create(null), versions = new Map(), candidates = [], currentItems=Object.create(null);
    let count=0,totalBytes=0,done=0;
    const seen = new Set(), directories=[];
    let journalStart=null,index=null,incremental=null,indexBoundary=null,strategy='full-scan',inventoryChanged=false;
    if(full&&journal){
      try { journalStart=await journal.query();index=allowIncremental?await loadHashIndex(backupRoot,roots,maxFiles*4):null; }
      catch { journalStart=null;index=null; }
    }
    async function observedFileId(file,s){
      if(typeof s.ino==='number'&&!Number.isSafeInteger(s.ino))return fileId(await fs.lstat(file,{bigint:true}));
      return fileId(s);
    }
    async function walk(file) {
      signal?.throwIfAborted();
      if (seen.has(file)) return; seen.add(file);
      if(seen.size>maxFiles*4)throw new Error('Snapshot entry limit exceeded');
      let s;
      try { s=await fs.lstat(file); } catch(e) { if(e.code!=='ENOENT')throw e; entries[file]={absent:true};versions.set(file,null);return; }
      if(s.isSymbolicLink()) {
        if(!full)throw new Error('Symlink target rejected');
        entries[file]={link:await fs.readlink(file)};versions.set(file,stamp(s));currentItems[file]={fileId:await observedFileId(file,s),kind:'link',entry:entries[file]};return;
      }
      if(s.isDirectory()) {
        entries[file]={directory:true,mode:s.mode};versions.set(file,stamp(s));currentItems[file]={fileId:await observedFileId(file,s),kind:'directory',entry:entries[file]};
        // Directory traversal is bounded by visited entries as well as regular files.
        if(seen.size>maxFiles*4)throw new Error('Snapshot entry limit exceeded');
        directories.push(file);
        return;
      }
      if(!s.isFile())throw new Error('Unsupported snapshot entry');
      if(++count>maxFiles||s.size>maxFileBytes||(totalBytes+=s.size)>maxTotalBytes)throw new Error(`Snapshot limit exceeded at ${file}; files=${count}, bytes=${totalBytes}`);
      versions.set(file,stamp(s));candidates.push({file,s});currentItems[file]={fileId:await observedFileId(file,s),kind:'file'};
    }
    for(const target of targets) await walk(await safePath(target,roots[0],roots));
    while(directories.length){
      const batch=directories.splice(0,workers);
      const scans=await Promise.allSettled(batch.map(async(dir)=>{
        const children=await fs.readdir(dir,{withFileTypes:true});
        for(const child of children)if(!full||!excluded.has(child.name))await walk(path.join(dir,child.name));
      }));
      const error=scans.find(r=>r.status==='rejected');if(error)throw error.reason;
      progress({phase:'scanning',count,totalBytes});
    }
    const pending=[];
    if(full&&journalStart&&index&&index.journalId===journalStart.journalId&&
      BigInt(index.nextUsn)>=BigInt(journalStart.firstUsn)&&BigInt(index.nextUsn)<=BigInt(journalStart.nextUsn)){
      try {
        const delta=await journal.read(index.nextUsn);
        if(!journalCovers(delta,index.nextUsn,journalStart.journalId))throw incrementalFallback('USN journal no longer covers the hash index');
        const analysis=analyzeJournal(delta.records,currentItems,index.items);
        if(analysis.structural)throw incrementalFallback('Directory or link structure changed');
        incremental={boundary:delta.nextUsn,changedIds:analysis.changedIds};strategy='usn-incremental';
      } catch(e) { if(e.code==='MUSU_USN_FALLBACK')throw e; incremental=null;strategy='full-scan'; }
    }
    for(const candidate of candidates){
      const previous=index?.items?.[candidate.file];
      const reusable=incremental&&previous?.kind==='file'&&previous.fileId===currentItems[candidate.file].fileId&&
        !incremental.changedIds.has(previous.fileId)&&previous.entry.size===candidate.s.size&&/^[a-f0-9]{64}$/.test(previous.entry.sha256);
      if(reusable){entries[candidate.file]={...previous.entry};currentItems[candidate.file].entry=entries[candidate.file];done++;}
      else pending.push(candidate);
    }
    const hashedFiles=pending.length,reusedFiles=count-hashedFiles;
    await fs.mkdir(path.join(backupRoot,'objects'),{recursive:true});
    await fs.mkdir(path.join(backupRoot,'manifests'),{recursive:true});
    const filesystem = await fs.statfs(backupRoot, { bigint: true });
    const availableBytes = filesystem.bavail * filesystem.bsize;
    const writeBytes=pending.reduce((sum,item)=>sum+item.s.size,0);
    const requiredBytes = BigInt(writeBytes) + BigInt(minFreeBytes);
    if (availableBytes < requiredBytes) throw new Error(`Insufficient backup disk space; availableBytes=${availableBytes}, checkpointBytes=${writeBytes}, minimumFreeBytes=${minFreeBytes}`);
    const verified=new Map();
    let next=0,failed=false;
    const outcomes=await Promise.allSettled(Array.from({length:workers},async()=>{
      try {
        while(!failed&&next<pending.length){
          const {file,s}=pending[next++];signal?.throwIfAborted();
          await safePath(file,roots[0],roots);
          let succeeded=false,lastError;
          for(let attempt=0;attempt<(full?3:1)&&!succeeded;attempt++){
          const temp=path.join(backupRoot,'objects',`.${id}-${randomUUID()}.tmp`);
          let input,output;
          try {
            input=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
            const actual=await input.stat();
            if(!full&&stamp(actual)!==stamp(s))throw new Error(`Source changed before backup: ${file}`);
            if(!actual.isFile()||actual.size>maxFileBytes)throw new Error(`Snapshot file limit exceeded: ${file}`);
            const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let size=0;
            for(;;){signal?.throwIfAborted();const {bytesRead}=await input.read(buffer);if(!bytesRead)break;size+=bytesRead;if(size>actual.size)throw new Error('Source grew during backup');hash.update(buffer.subarray(0,bytesRead));}
            if(size!==actual.size||stamp(await input.stat())!==stamp(actual))throw new Error(`Source changed during backup: ${file}`);
            const sha256=hash.digest('hex'),object=path.join(backupRoot,'objects',`${sha256}.backup`);
            if(!verified.has(sha256))verified.set(sha256,(async()=>{
              try { if(await digestFile(object,signal)!==sha256)throw new Error('Corrupt backup object'); }
              catch(e){
                if(e.code!=='ENOENT')throw e;
                const source=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
                try{
                  if(stamp(await source.stat())!==stamp(actual))throw new Error(`Source changed before object write: ${file}`);
                  output=await fs.open(temp,'wx',0o600);
                  const secondHash=createHash('sha256');let copied=0;
                  for(;;){signal?.throwIfAborted();const {bytesRead}=await source.read(buffer);if(!bytesRead)break;copied+=bytesRead;if(copied>actual.size)throw new Error('Source grew during object write');const chunk=buffer.subarray(0,bytesRead);secondHash.update(chunk);await output.writeFile(chunk);}
                  if(copied!==actual.size||stamp(await source.stat())!==stamp(actual)||secondHash.digest('hex')!==sha256)throw new Error(`Source changed during object write: ${file}`);
                  await output.sync();await output.close();output=null;
                }finally{await source.close();}
                await fs.rename(temp,object);
              }
            })());
            try{await verified.get(sha256);}catch(e){verified.delete(sha256);throw e;}
            entries[file]={sha256,size,mode:actual.mode};currentItems[file].entry=entries[file];
            done++; if(done%100===0)progress({phase:'backing_up',done,count,totalBytes});
            succeeded=true;
          }catch(e){
            if(full&&e.code==='ENOENT'){
              entries[file]={absent:true};inventoryChanged=true;delete currentItems[file];
              done++;if(done%100===0)progress({phase:'backing_up',done,count,totalBytes});
              succeeded=true;
            }else{lastError=e;if(!full||attempt===2)throw e;}
          }
          finally{await input?.close();await output?.close();await fs.rm(temp,{force:true});}
          }
          if(!succeeded)throw lastError;
        }
      }catch(e){failed=true;throw e;}
    }));
    const failure=outcomes.find(r=>r.status==='rejected');if(failure)throw failure.reason;
    signal?.throwIfAborted();
    if(full&&journalStart&&!inventoryChanged){
      try {
        const fromUsn=incremental?.boundary||journalStart.nextUsn;
        const tail=await journal.read(fromUsn);
        if(!journalCovers(tail,fromUsn,journalStart.journalId))throw incrementalFallback('USN journal changed or wrapped during snapshot');
        const analysis=analyzeJournal(tail.records,currentItems,index?.items);
        if(incremental&&analysis.relevant)throw incrementalFallback('Source changed during incremental snapshot');
        if(!analysis.relevant)indexBoundary=tail.nextUsn;
      } catch(e) { if(incremental)throw incrementalFallback(`USN stability check failed: ${e.message}`); }
    }
    const manifest={version:2,id,tool,roots,full,strategy,hashedFiles,reusedFiles,createdAt:new Date().toISOString(),entries,count,totalBytes};
    const temp=path.join(backupRoot,'manifests',`${id}.tmp`),dest=path.join(backupRoot,'manifests',`${id}.json`);
    await fs.writeFile(temp,JSON.stringify(manifest),{flag:'wx',mode:0o600});await fs.rename(temp,dest);
    if(full&&indexBoundary){
      const items=Object.fromEntries(Object.entries(currentItems).filter(([,item])=>item.entry));
      await saveHashIndex(backupRoot,{version:1,roots,journalId:journalStart.journalId,nextUsn:indexBoundary,items}).catch(()=>{});
    }
    return {id,count,totalBytes,strategy,hashedFiles,reusedFiles,async verify(){
      for(const [file,version] of versions){if(!entries[file]?.link)await safePath(file,roots[0],roots);let current;try{current=stamp(await fs.lstat(file));}catch(e){if(e.code!=='ENOENT')throw e;current=null;}if(current!==version)throw new Error(`Source changed before mutation: ${file}`);}
    }};
  }
}

export async function restoreToNewDirectory(manifest,backupRoot,destination) {
  // Never overwrite an existing restore target or the original roots.
  destination=path.resolve(destination);
  destination=path.join(await fs.realpath(path.dirname(destination)),path.basename(destination));
  if(manifest.roots.some(r=>inside(r,destination)||inside(destination,r)))throw new Error('Restore must be outside source roots');
  await fs.mkdir(destination,{recursive:false});
  for(const [original,entry] of Object.entries(manifest.entries)){
    const root=manifest.roots.find(r=>inside(r,original));if(!root)throw new Error('Invalid manifest path');
    const target=path.resolve(destination,String(manifest.roots.indexOf(root)),path.relative(root,original));
    if(!inside(destination,target))throw new Error('Restore path escaped');
    if(entry.absent)continue;
    if(entry.link)continue; // Deliberately never recreate links into live sources.
    if(entry.directory){await fs.mkdir(target,{recursive:true});continue;}
    if(!/^[a-f0-9]{64}$/.test(entry.sha256))throw new Error('Invalid object hash');
    const object=path.join(backupRoot,'objects',`${entry.sha256}.backup`);
    if(await digestFile(object)!==entry.sha256)throw new Error('Corrupt restore object');
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(object,target,constants.COPYFILE_EXCL);
    if(await digestFile(target)!==entry.sha256)throw new Error('Restore readback mismatch');
    await fs.chmod(target,entry.mode&0o777);
  }
}
