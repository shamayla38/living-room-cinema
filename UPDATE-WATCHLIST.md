# October 17 watchlist update

Adds eight films with posters, genres, descriptions and dated IMDb/Rotten Tomatoes ratings. Adds an Already watched shelf and host controls to move films back and forth. Mulholland Drive is marked watched unless it still has an upcoming uncancelled screening. Existing ballots, RSVPs, screenings and subscriptions are preserved.

## Apply to the live site

1. Run `supabase/migrations/202610170001_watched_movies.sql` in Supabase SQL Editor (or your normal migration deployment).
2. Run `supabase/migrations/202610170002_watchlist_additions.sql`. This adds missing films, marks the three approved suggestions reviewed, and moves Mulholland Drive.
3. Push this code and run the existing GitHub Pages deployment workflow.
4. Check 39 watchlist films and one watched film, unless other catalog changes were made live. Verify the host Move film control.

Do not use reset-and-install.sql on the live site. It is a destructive fresh-install/recovery script.

The website stays compatible while migrations and deployment are rolled out in that order. No email is sent by these two migrations. Host-only movement refuses to archive a film with an upcoming screening. Old votes remain stored and are visible again if a film is returned to the same voting round.
