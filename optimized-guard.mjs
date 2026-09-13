import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createMutationGate } from './checkpoint.mjs';
import { snapshotter, safePath, inside } from './snapshot-targets.mjs';
import { openJobs } from './jobs.mjs';

if(!process.env.MCP_EDITABLE_ROOTS||!process.env.MCP_BACKUP_ROOT||!process.env.MCP_JOBS_ROOT)throw new Error('MCP_EDITABLE_ROOTS, MCP_BACKUP_ROOT and MCP_JOBS_ROOT are required');
const configuredRoots=process.env.MCP_EDITABLE_ROOTS.split(',').map(value=>value.trim()).filter(Boolean);
if(!configuredRoots.length||configuredRoots.some(root=>!path.isAbsolute(root)))throw new Error('MCP_EDITABLE_ROOTS must contain absolute paths');
const roots=await Promise.all(configuredRoots.map(root=>fs.realpath(path.resolve(root))));
if(new Set(roots).size!==roots.length||roots.some((root,index)=>roots.some((other,otherIndex)=>index!==otherIndex&&inside(root,other))))throw new Error('MCP_EDITABLE_ROOTS must contain unique non-overlapping paths');
const backupRoot=path.resolve(process.env.MCP_BACKUP_ROOT);
const jobsRoot=path.resolve(process.env.MCP_JOBS_ROOT);
const snapshot=snapshotter({roots,backupRoot,maxFiles:200000,maxFileBytes:256*1024*1024,maxTotalBytes:32*1024**3,workers:64});
const fastSnapshot=snapshotter({roots,backupRoot,maxFiles:2000,maxFileBytes:128*1024*1024,maxTotalBytes:512*1024**2,workers:4});
const gate=createMutationGate(async()=>({kind:'target-or-job'}),8);
const jobs=await openJobs(jobsRoot);
const callbacks=new Map(), registrations=new WeakSet(), processOwners=new Map();
const result=data=>({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
const wrapped=operation=>async(...args)=>{try{return await operation(...args);}catch(e){return {...result({error:e.message}),isError:true};}};
const owner=extra=>{const id=extra?.authInfo?.clientId;if(!id)throw new Error('Authenticated OAuth client required');return id;};
const instructions=` Editable roots: ${roots.join(', ')}. Read repository instructions before mutation. Direct mutations get target byte backups; shell/script/patch and large trees use submit_job then get_job. Preserve recovery evidence. Same-UID shell is not a security sandbox.`;
const deferred=new Set(['exec_command','run_script','apply_patch']);
const single=new Set(['write_file','replace_in_file','upload_file','make_directory','remove_path','chmod_path']);
async function targetsFor(name,args) {
  const cwd=await safePath(args.cwd||roots[0],roots[0],roots);
  let values;
  if(single.has(name))values=[args.path];
  else if(name==='copy_path'||name==='move_path'){
    const source=await safePath(args.sourcePath,cwd,roots),destination=await safePath(args.destinationPath,cwd,roots);
    if(inside(source,destination)||inside(destination,source))throw new Error('Overlapping copy/move paths rejected');
    values=name==='move_path'?[source,destination]:[destination];
  }else throw new Error('Unknown mutating tool; use a reviewed job');
  const paths=await Promise.all(values.map(v=>safePath(v,cwd,roots)));
  if(paths.some(p=>roots.some(root=>inside(root,p)&&inside(p,root))))throw new Error('Workspace-root mutation rejected');
  return paths;
}
const original=McpServer.prototype.registerTool;
McpServer.prototype.registerTool=function(name,config,callback){
  callbacks.set(name,{config,callback});config.description+=instructions;
  let handler=callback;
  if(['write_stdin','terminate_process','read_process'].includes(name))handler=wrapped(async(args,extra)=>{
    if(processOwners.get(args.sessionId)!==owner(extra))throw new Error('Process not owned by this OAuth client');
    // Input and termination continue an already checkpointed process, not a new command.
    return callback(args,extra);
  });
  else if(deferred.has(name))handler=wrapped(async()=>{throw new Error(`Use submit_job with tool=${name}, arguments and unique requestKey; full backup precedes execution asynchronously.`);});
  else if(config.annotations?.readOnlyHint!==true)handler=wrapped(async(args,extra)=>{
    return gate(name,async()=>{
      const proof=await fastSnapshot(await targetsFor(name,args),{signal:extra?.signal,tool:name});
      await proof.verify();extra?.signal?.throwIfAborted();
      const output=await callback(args,extra);
      return {...output,structuredContent:{...output.structuredContent,checkpoint:{id:proof.id,count:proof.count,totalBytes:proof.totalBytes}}};
    },extra?.signal);
  });
  const registration=original.call(this,name,config,handler);
  if(!registrations.has(this)){
    registrations.add(this);const meta=config._meta;
    original.call(this,'submit_job',{description:'Queue full code AND wiki backup then execution; returns job ID immediately. Reuse requestKey for safe retry; poll get_job. Shell can access other mounted paths, which this snapshot does not protect.'+instructions,inputSchema:{requestKey:z.string().min(1).max(128),tool:z.enum(['checkpoint','exec_command','run_script','apply_patch','copy_path','move_path','remove_path']),arguments:z.record(z.string(),z.unknown()).default({})},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true},_meta:meta},wrapped(async(args,extra)=>{
      const client=owner(extra),record=callbacks.get(args.tool);
      const parsed=args.tool==='checkpoint'?{}:z.object(record.config.inputSchema).parse(args.arguments);
      if(parsed.cwd)await safePath(parsed.cwd,roots[0],roots);
      if(parsed.workdir)await safePath(parsed.workdir,roots[0],roots);
      if(['copy_path','move_path','remove_path'].includes(args.tool))await targetsFor(args.tool,parsed);
      return result(await jobs.submit(client,args.requestKey,{tool:args.tool,arguments:parsed},async({signal,update})=>{
        const executionExtra={...extra,signal};
        return gate(args.tool,async()=>{
          let lastProgress=0;
          const proof=await snapshot(roots,{full:true,signal,tool:args.tool,progress:p=>{if(Date.now()-lastProgress>2000){lastProgress=Date.now();void update({progress:p}).catch(()=>{});}}});
          await update({state:'ready',checkpoint:{id:proof.id,count:proof.count,totalBytes:proof.totalBytes}});
          signal.throwIfAborted();
          if(args.tool==='checkpoint')return {checkpoint:{id:proof.id,count:proof.count,totalBytes:proof.totalBytes}};
          await update({state:'running'});
          const value=await record.callback(['exec_command','run_script'].includes(args.tool)?{...parsed,yieldTimeMs:0,maxOutputBytes:65536}:parsed,executionExtra);
          if(value.isError)throw new Error(value.structuredContent?.error||'Tool execution failed');
          const output=value.structuredContent;
          if(output?.sessionId){processOwners.set(output.sessionId,client);await update({process:{sessionId:output.sessionId,running:output.running}});}
        if(output?.sessionId&&output.running){
          try{
            let current=output,tail=output.output||'';
            while(current.running){signal.throwIfAborted();const next=await callbacks.get('read_process').callback({sessionId:output.sessionId,afterSeq:current.nextSeq||0,waitMs:1000,maxOutputBytes:65536},executionExtra);if(next.isError)throw new Error('Process result unavailable');current=next.structuredContent;tail=(tail+(current.output||'')).slice(-65536);}
            return {...current,output:tail};
          }catch(e){if(signal.aborted)await callbacks.get('terminate_process').callback({sessionId:output.sessionId,signal:'SIGTERM',graceMs:1000},executionExtra);throw e;}
        }
        return output;
        },signal);
      }));
    }));
    original.call(this,'get_job',{description:'Get your job state, progress, checkpoint and bounded result. No source scan.',inputSchema:{jobId:z.string().uuid()},annotations:{readOnlyHint:true},_meta:meta},wrapped(async(args,extra)=>result(jobs.get(args.jobId,owner(extra)))));
    original.call(this,'cancel_job',{description:'Cancel your queued/backup job or stop its managed process. Does not roll back effects.',inputSchema:{jobId:z.string().uuid()},annotations:{readOnlyHint:false,destructiveHint:true},_meta:meta},wrapped(async(args,extra)=>result(await jobs.cancel(args.jobId,owner(extra)))));
  }
  return registration;
};
