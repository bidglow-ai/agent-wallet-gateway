import {spawn} from 'node:child_process';

const error=code=>Object.assign(new Error(code),{code});

// Trusted POSIX executables only: bounds this invocation's process group, NOT
// arbitrary descendants that escape via setsid/setpgid. It is not an OS sandbox.
// Raw stdout stays in caller memory. Optional bounded stderr matching returns
// only a boolean; no stderr text or captured stream is attached to any error.
export async function captureNativeProcess(executable,args,env,{
  timeoutMs=180000,killGraceMs=5000,maxStdoutBytes=2097152,maxStderrBytes=262144,
  stderrMarker,initialSignal='SIGTERM',
}={}){
  if(process.platform==='win32')throw error('NATIVE_PROCESS_ISOLATION_UNAVAILABLE');
  if(typeof executable!=='string'||!executable||!Array.isArray(args)||args.some(value=>typeof value!=='string')||
    !env||typeof env!=='object'||[timeoutMs,maxStdoutBytes,maxStderrBytes].some(value=>!Number.isSafeInteger(value)||value<1)||
    !Number.isSafeInteger(killGraceMs)||killGraceMs<0||timeoutMs>180000||killGraceMs>5000||
    (stderrMarker!==undefined&&(typeof stderrMarker!=='string'||stderrMarker.length<1||stderrMarker.length>80))||
    !['SIGTERM','SIGINT'].includes(initialSignal))
    throw error('NATIVE_PROCESS_CONFIGURATION_REQUIRED');
  return await new Promise((resolve,reject)=>{
    let child,deadline,forced,fallback,settled=false,stopping=false,closed=false;
    let failure,code=null,stdoutBytes=0,stderrBytes=0;
    const stdout=[],stderr=[];
    const markFailure=value=>{failure??=value;};
    const groupExists=()=>{
      if(!child?.pid)return false;
      try{process.kill(-child.pid,0);return true;}
      catch(cause){return cause.code!=='ESRCH';}
    };
    const signalGroup=signal=>{
      // detached:true makes exactly this invocation's child PID its new PGID.
      // Never use a shell, inherited group, broad process search or external kill.
      if(!child?.pid)return;
      try{process.kill(-child.pid,signal);}
      catch(cause){if(cause.code!=='ESRCH')markFailure('NATIVE_PROCESS_CLEANUP_UNCONFIRMED');}
    };
    const finish=()=>{
      if(settled)return;settled=true;
      clearTimeout(deadline);clearTimeout(forced);clearTimeout(fallback);
      process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);
      child?.stdout?.destroy();child?.stderr?.destroy();
      if(failure){stdout.length=0;stderr.length=0;reject(error(failure));}
      else {
        const stderrMarkerObserved=stderrMarker!==undefined&&Buffer.concat(stderr,stderrBytes).toString('utf8').toLowerCase().includes(stderrMarker.toLowerCase());
        stderr.length=0;
        resolve({code,stdout:Buffer.concat(stdout,stdoutBytes).toString('utf8'),stderrBytes,...(stderrMarker!==undefined?{stderrMarkerObserved}:{})});
      }
    };
    const hardStop=()=>{
      if(settled)return;
      signalGroup('SIGKILL');
      // A descendant holding inherited pipes must not prevent close/settlement.
      // SIGKILL was issued to our group before dropping its stream references.
      child?.stdout?.destroy();child?.stderr?.destroy();
      fallback=setTimeout(finish,100);
    };
    const stop=reason=>{
      if(settled)return;
      if(reason)markFailure(reason);
      if(stopping)return;stopping=true;
      signalGroup(initialSignal);
      forced=setTimeout(hardStop,killGraceMs);
      if(closed&&!groupExists())finish();
    };
    const interrupted=()=>stop('NATIVE_CLIENT_INTERRUPTED');
    try{child=spawn(executable,args,{env,detached:true,stdio:['ignore','pipe','pipe']});}
    catch{markFailure('NATIVE_CLIENT_STARTUP_UNCONFIRMED');finish();return;}
    process.on('SIGINT',interrupted);process.on('SIGTERM',interrupted);
    // Do not clear this on `exit`: surviving descendants can still hold pipes.
    deadline=setTimeout(()=>stop('NATIVE_CLIENT_TIMEOUT'),timeoutMs);
    child.stdout.on('data',chunk=>{
      if(settled)return;
      stdoutBytes+=chunk.length;
      if(stdoutBytes>maxStdoutBytes){stop('NATIVE_CLIENT_OUTPUT_LIMIT');return;}
      stdout.push(chunk);
    });
    child.stderr.on('data',chunk=>{
      if(settled)return;
      stderrBytes+=chunk.length;
      if(stderrBytes>maxStderrBytes){stop('NATIVE_CLIENT_OUTPUT_LIMIT');return;}
      if(stderrMarker!==undefined)stderr.push(chunk);
    });
    child.once('error',()=>{
      markFailure('NATIVE_CLIENT_STARTUP_UNCONFIRMED');
      if(child.pid)stop();else finish();
    });
    child.once('close',exitCode=>{
      closed=true;code=exitCode;
      if(code!==0)markFailure('NATIVE_CLIENT_RUN_UNCONFIRMED');
      if(groupExists())stop();else finish();
    });
  });
}
