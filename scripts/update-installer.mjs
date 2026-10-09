#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {runInstallTransaction} from './updater/install-transaction.mjs';
try {
  const {values}=parseArgs({options:{plan:{type:'string'},recover:{type:'string'}},strict:true,allowPositionals:false});
  if(Boolean(values.plan)===Boolean(values.recover))throw Error('Use exactly --plan <plan.json> or --recover <plan.json>');
  const result=await runInstallTransaction(values.plan??values.recover,{recovery:Boolean(values.recover)});
  console.log(JSON.stringify(result));
  if(result.status==='recovery-needed')process.exitCode=2;
}catch(error){console.error(JSON.stringify({status:'failed',error:error instanceof Error?error.message:'Update failed'}));process.exitCode=1;}
