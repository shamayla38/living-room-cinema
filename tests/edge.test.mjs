import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function loadFunction(name, context) {
  let handler;
  globalThis.__edgeTest = context;
  globalThis.Deno = { serve: fn => handler=fn, env:{ get: key=>context.secrets[key] } };
  const result = await build({entryPoints:[`supabase/functions/${name}/index.ts`],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
    name:'test-server', setup(build) {
      build.onResolve({filter:/\/server\.ts$/},()=>({path:'server',namespace:'test'}));
      build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:`
        const ctx=globalThis.__edgeTest;
        export const admin=()=>ctx.db;
        export const rpc=(_db,name,args)=>ctx.rpc(name,args);
        export const secret=name=>{if(!ctx.secrets[name])throw new Error('Missing secret');return ctx.secrets[name];};
        export const authorizedCron=req=>req.headers.get('Authorization')==='Bearer '+ctx.secrets.CRON_SECRET;
      `}));
    }
  }]});
  await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${Math.random()}`);
  return handler;
}

test('Edge unsubscribe redirects GET without mutation and accepts explicit POST',async()=>{
  const calls=[];
  const handler=await loadFunction('unsubscribe',{secrets:{SITE_URL:'https://example.test/cinema/'},rpc:async(...args)=>{calls.push(args);return true;},db:{}});
  const token='a'.repeat(72);
  const response=await handler(new Request(`https://project.supabase.co/functions/v1/unsubscribe?token=${token}`));
  assert.equal(response.status,303);
  assert.equal(response.headers.get('Location'),`https://example.test/cinema/unsubscribe.html#${token}`);
  assert.equal(calls.length,0);
  const result=await handler(new Request(`https://project.supabase.co/functions/v1/unsubscribe?token=${token}`,{method:'POST'}));
  assert.equal(result.status,200);
  assert.equal(calls[0][0],'unsubscribe_email');
  assert.equal((await handler(new Request('https://project.supabase.co/functions/v1/unsubscribe?token=bad',{method:'POST'}))).status,400);
});

test('Edge mailer rejects outsiders, skips ineligible recipients, and preserves retry keys',async()=>{
  const changes=[], sends=[];
  const job={id:'mail-1',event_id:'event-1',payload:{email:'test@example.test',title:'Charade',starts_at:'2099-06-01T20:00:00Z',timezone:'America/New_York',location:'Sofa',token:'token'},kind:'invitation'};
  let eligible=true;
  const ctx={secrets:{CRON_SECRET:'cron',RESEND_API_KEY:'key',EMAIL_FROM:'Cinema <cinema@example.test>',SITE_URL:'https://example.test/',SUPABASE_URL:'https://project.supabase.co'},
    db:{from:()=>({update:value=>({eq:async()=>{changes.push(value);return {error:null};}})})},
    rpc:async name=>name==='claim_mail'?[job]:name==='mail_is_eligible'?eligible:null};
  const handler=await loadFunction('mailer',ctx);
  assert.equal((await handler(new Request('https://example.test/mailer',{method:'POST'}))).status,401);
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{sends.push({url,...options});return new Response('{}',{status:200});};
  const invoke=()=>handler(new Request('https://example.test/mailer',{method:'POST',headers:{Authorization:'Bearer cron'}}));
  try {
    await invoke(); await invoke();
    assert.equal(sends.length,2);
    assert.equal(sends[0].headers['Idempotency-Key'],sends[1].headers['Idempotency-Key']);
    assert.equal(sends[0].body,sends[1].body);
    assert.equal(changes[0].status,'sent');
    eligible=false; await invoke();
    assert.equal(sends.length,2);
    assert.equal(changes.at(-1).status,'skipped');
    eligible=true;
    globalThis.fetch=async()=>new Response('{}',{status:429});
    await invoke(); assert.equal(changes.at(-1).status,'sending');
    globalThis.fetch=async()=>new Response('{}',{status:422});
    await invoke(); assert.equal(changes.at(-1).status,'failed');
  } finally { globalThis.fetch=oldFetch; }
});

test('Edge poster refresh compiles and rejects unauthenticated calls',async()=>{
  const handler=await loadFunction('refresh-posters',{secrets:{CRON_SECRET:'cron'}});
  assert.equal((await handler(new Request('https://example.test/posters',{method:'POST'}))).status,401);
});
