# The Living Room Cinema

A local, responsive movie-club prototype with 32 real movie posters, original short descriptions, IMDb and Rotten Tomatoes scores, anonymous trial voting, movie suggestions, host review, screening selection, trial RSVPs, and a weekly email preview.

## Open locally

From this folder, run:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
```

Open http://127.0.0.1:4173 in your browser. No install or build step is needed.

## What works in this draft

- Each movie has an anonymous vote toggle and a tally. You can vote for multiple films and undo a vote. Trial votes are limited to one per film in the current browser; they are not shared counts or abuse-resistant public voting. Host film options are sorted by votes.
- Ratings are dated snapshots with links to IMDb and Rotten Tomatoes. Rotten Tomatoes scores are the critics’ Tomatometer, not audience scores. IMDb scores come from the official public ratings dataset.
- All 32 films and posters are bundled locally, so the initial watchlist needs no external image service.
- Visitors can submit a movie title with an optional name.
- Host view shows suggestions and lets you add a year, genres, an HTTPS poster URL, and a short description before approving a film.
- Hosts can choose a film, future screening date/time, and location.
- RSVP opens once a screening is saved. Repeat entries with the same email update the current screening's RSVP instead of duplicating it.
- Signups and a weekly invitation preview demonstrate the email flow. Nothing is sent.
- Draft entries persist only in this browser using local storage. They are not shared between devices or guests. Clearing site data removes them.
- Dates are displayed in the browser's local timezone in this prototype.

## Files

- `dist/index.html`: website structure
- `dist/style.css`: responsive charcoal and warm-red design
- `dist/app.js`: draft interactions
- `dist/movies.js`: film catalog
- `dist/assets/`: actual poster images
- `dist/credits.html`: poster source links

## Before launching to guests

This is a design and interaction prototype, not a production guest-management service. The host view is deliberately an openly labeled demo, not an authentication boundary.

Your partner can put this folder in a repository and deploy `dist` to a static host for design review. A functional public launch needs:

1. Server-side host authentication and authorization.
2. Shared storage for films, suggestions, anonymous ballots, events, RSVPs, and email subscriptions.
3. Server-side validation, submission limits and spam protection.
4. A configured email provider, verified sending domain, subscription consent and unsubscribe handling.
5. A weekly schedule that sends an invitation only for a selected, upcoming screening, without duplicate sends.
6. Anonymous voting with shared aggregate counts, duplicate-vote controls, a voting cutoff, and an explicit tie-breaking rule.
7. An explicit event timezone and a public RSVP link.
8. A suitable poster source and usage permissions for the public site. Current posters retain their respective owners' copyrights; source links are preserved.

Keep email-provider keys and other secrets on the server, never in these public files.

## Film versions

The catalog uses The Drama (2026), The Fall (2006; US theatrical release 2008), The Stepford Wives (1975), Something Wild (1986), Charade (1963), and The Player (1992). The Stepford Wives original and Something Wild (1986) have stronger Rotten Tomatoes ratings than their same-name alternatives. The Fall (2006) has a strong audience rating; it is a different film from Fall (2022).

## Validation

JavaScript syntax, all 32 local image files, catalog completeness, vote toggling and persistence, suggestion persistence, and the host screening/RSVP flow were checked. Interactive browser inspection was unavailable because the browser tool could not verify its administrator security policy. WebMCP registration is feature-detected; validation in a supported WebMCP browser was unavailable.
