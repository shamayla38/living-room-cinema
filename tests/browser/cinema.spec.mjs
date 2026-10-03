import { test, expect } from '@playwright/test';

async function mockBackend(page) {
  const calls = [];
  const event = { id:'event-1',movie_id:'1',starts_at:new Date(Date.now()+86400000).toISOString(),timezone:'America/New_York',location:'Our sofa',capacity:12,seats_taken:0 };
  const state = { movies:[{id:'1',title:'Charade',year:1963,genres:['Mystery'],description:'An evening of intrigue.',poster:'assets/charade.jpg'}],counts:{},mine:[],round:{id:'round-1',closes_at:new Date(Date.now()+86400000).toISOString()},event };
  const profile = { host:false,subscribed:false,rsvps:[] };
  function session(anonymous) {
    const user={id:anonymous?'anon-1':'member-1',aud:'authenticated',role:'authenticated',is_anonymous:anonymous,email:anonymous?'':'guest@example.test',app_metadata:{},user_metadata:{}};
    const payload=Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'})).toString('base64url');
    return {access_token:`e30.${payload}.signature`,refresh_token:'refresh',expires_in:3600,token_type:'bearer',user};
  }
  await page.route('**/config.js', route=>route.fulfill({contentType:'text/javascript',body:'window.CINEMA_CONFIG={url:"https://test.supabase.co",key:"sb_publishable_test",turnstile:"test"};'}));
  await page.route('https://challenges.cloudflare.com/**',route=>route.fulfill({contentType:'text/javascript',body:'window.turnstile={render:(el,opts)=>{setTimeout(()=>opts.callback("test-captcha"),0);return "widget";},remove:()=>{},reset:()=>{}};'}));
  await page.route('https://test.supabase.co/**',async route=>{
    const request=route.request(), path=new URL(request.url()).pathname;
    const body=request.postDataJSON();
    calls.push({path,body});
    let data={};
    if(path.endsWith('/signup')) data=session(true);
    else if(path.endsWith('/verify') || path.endsWith('/token')) data=session(false);
    else if(path.endsWith('/user')) data=session(false).user;
    else if(path.endsWith('/cinema_state')) data=state;
    else if(path.endsWith('/member_state')) data=profile;
    else if(path.endsWith('/set_vote')) { state.mine=body.p_voted?['1']:[]; state.counts={'1':body.p_voted?1:0}; }
    else if(path.endsWith('/set_rsvp')) { profile.rsvps=body.p_attending?[event.id]:[]; state.event.seats_taken=body.p_attending?1:0; }
    else if(path.endsWith('/set_subscription')) profile.subscribed=body.p_active;
    else if(path.endsWith('/host_data')) { await route.fulfill({status:403,json:{message:'Host access required'}}); return; }
    await route.fulfill({json:data,headers:{'access-control-allow-origin':'*'}});
  });
  return {calls,state};
}

test('unconfigured preview renders every poster and disables submissions',async ({page})=>{
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.movie')).toHaveCount(32);
  await expect(page.locator('#connection-status')).toContainText('Preview only');
  await expect(page.locator('[data-vote]').first()).toBeDisabled();
  await expect(page.locator('#suggest-open')).toBeDisabled();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.goto('/credits.html');
  await expect(page.locator('img[alt="TMDB"]')).toBeVisible();
  expect(await page.locator('img[alt="TMDB"]').evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);
  expect(errors).toEqual([]);
});

test('anonymous voting persists across reload and toggles through the API',async ({page})=>{
  const {calls}=await mockBackend(page);
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button',{name:'Vote for Charade',exact:true}).click();
  await expect(page.getByRole('button',{name:'Remove vote for Charade'})).toHaveAttribute('aria-pressed','true');
  await page.reload();
  await expect(page.getByRole('button',{name:'Remove vote for Charade'})).toBeVisible();
  await page.getByRole('button',{name:'Remove vote for Charade'}).click();
  await expect(page.getByRole('button',{name:'Vote for Charade',exact:true})).toHaveAttribute('aria-pressed','false');
  expect(calls.filter(c=>c.path.endsWith('/signup'))).toHaveLength(1);
  expect(calls.filter(c=>c.path.endsWith('/set_vote')).map(c=>c.body.p_voted)).toEqual([true,false]);
  expect(errors).toEqual([]);
});

test('email code verifies before RSVP; guest cannot open host data',async ({page})=>{
  const {calls}=await mockBackend(page);
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  await page.locator('#rsvp-open').click();
  await page.getByLabel('Email address',{exact:true}).fill('guest@example.test');
  await page.getByRole('button',{name:'Send code',exact:true}).click();
  await page.getByLabel('Email code',{exact:true}).fill('123456');
  await page.getByRole('button',{name:'Verify email'}).click();
  await page.getByLabel('Your name',{exact:true}).fill('Guest');
  await page.getByLabel('Send me a reminder').check();
  await page.getByRole('button',{name:'Book one seat'}).click();
  await expect(page.locator('#toast')).toContainText('Your seat is booked');
  await page.locator('#host-open').click();
  await expect(page.locator('#toast')).toContainText('Host access required');
  expect(calls.find(c=>c.path.endsWith('/set_rsvp')).body.p_reminders).toBe(true);
  expect(errors).toEqual([]);
});

test('unsubscribe waits for a click and sends no request on page load',async ({page})=>{
  await page.route('**/config.js',route=>route.fulfill({contentType:'text/javascript',body:'window.CINEMA_CONFIG={url:"https://test.supabase.co"};'}));
  let requests=0;
  await page.route('https://test.supabase.co/**',route=>{requests++;return route.fulfill({body:'Unsubscribed',headers:{'access-control-allow-origin':'*'}});});
  await page.goto('/unsubscribe.html#'+'a'.repeat(72));
  expect(requests).toBe(0);
  await page.getByRole('button',{name:'Unsubscribe',exact:true}).click();
  await expect(page.locator('#result')).toContainText('You are unsubscribed');
  expect(requests).toBe(1);
  expect(new URL(page.url()).hash).toBe('');
});
