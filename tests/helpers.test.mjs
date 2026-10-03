import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHTML, safeImage, ratingText, eventLabel } from '../dist/ui.mjs';
import { composeMail } from '../supabase/functions/_shared/mail.mjs';

test('untrusted text and image URLs cannot inject markup', () => {
  assert.equal(escapeHTML('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  for(const url of ['javascript:alert(1)','data:text/html,bad','//evil.test/x','assets/../../private']) {
    assert.equal(safeImage(url),'assets/poster-placeholder.svg');
  }
  assert.equal(safeImage('https://image.tmdb.org/t/p/w500/test.jpg'),'https://image.tmdb.org/t/p/w500/test.jpg');
  assert.equal(ratingText(undefined,'imdb'),'Not rated');
  assert.equal(ratingText(7.9,'imdb'),'7.9/10');
});
test('email links bind to a screening and support project-path hosting', () => {
  const job = { event_id:'abc',kind:'invitation',payload:{email:'guest@example.test',title:'Charade',starts_at:'2099-06-02T00:00:00Z',timezone:'America/New_York',location:'Our sofa',token:'secret-token'} };
  const mail=composeMail(job,'https://example.github.io/cinema/','https://project.supabase.co/functions/v1');
  assert.match(mail.text,/https:\/\/example.github.io\/cinema\/\?event=abc#screening/);
  assert.match(mail.text,/8:00 PM/);
  assert.match(mail.headers['List-Unsubscribe'],/\/unsubscribe\?token=secret-token/);
  assert.equal(mail.headers['List-Unsubscribe-Post'],'List-Unsubscribe=One-Click');
  assert.match(eventLabel(job.payload),/8:00|20:00/);
  assert.match(eventLabel(job.payload),/Our sofa/);
});
