export function composeMail(job, siteUrl, functionUrl) {
  const p = job.payload;
  const time = new Date(p.starts_at).toLocaleString('en-US', {
    timeZone: p.timezone, weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  const unsubscribe = `${functionUrl}/unsubscribe?token=${encodeURIComponent(p.token)}`;
  const rsvp = new URL(siteUrl);
  rsvp.searchParams.set('event', job.event_id);
  rsvp.hash = 'screening';
  const subject = {
    invitation: `Movie night: ${p.title}`,
    'rsvp-reminder': `Still joining us for ${p.title}?`,
    'attendee-reminder': `See you at movie night: ${p.title}`,
    cancellation: `Cancelled: ${p.title} movie night`,
  }[job.kind];
  if (!subject) throw new Error('Unknown mail kind');
  const intro = {
    invitation: 'You are invited to our next movie night!',
    'rsvp-reminder': 'There is still time to RSVP, if seats are available.',
    'attendee-reminder': 'Your seat is booked. We look forward to seeing you!',
    cancellation: 'This screening has been cancelled. Your seat booking is cancelled too.',
  }[job.kind];
  return {
    subject,
    text: `${intro}\n\n${p.title}\n${time}\n${p.location}\n\nView screening / manage your RSVP:\n${rsvp.href}\n\nStop invitations and reminders:\n${unsubscribe}\n\nThe Living Room Cinema`,
    headers: {
      'List-Unsubscribe': `<${unsubscribe}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
