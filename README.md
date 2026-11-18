# Scout

A private household app for two people: a shared calendar, a whiteboard, shopping lists, a fridge/freezer meal tracker and recipes. It runs as a web page on GitHub Pages and keeps everything in one Google Sheet that both people can edit.

**Open it:** <https://kingslayercode.github.io/scout/app/> (add it to the iPhone home screen from Safari's Share menu).

## What's in it

| Tab | What it does |
| --- | --- |
| **Calendar** | Everyone's chosen Google Calendars in one month view, plus a *Shared* calendar for household events. The theme follows the season of the month on screen. Live weather strip with a 7-day forecast. |
| **Board** | A whiteboard for to-dos (written in marker, in the person's colour when assigned) and sticky-note notices. Type `-dane` / `-jack` at the end of a to-do to assign it. The Board icon shows a red dot for new things and flashes while you have an open to-do. |
| **Meals** | Fridge and freezer drawn as shelves of numbered containers, with expiry colours. Import cooked meals, drag containers between fridge and freezer. |
| **Shopping** | One list per trip (Costco, Walmart, Co-op or any store) with a trip date, item counts, rough price estimates and a trip total. A dated trip appears on the shared calendar. |
| **Recipes** | Recipes by category; add a recipe's ingredients to a shopping list (amounts are stripped). |
| **Profile** | Name, photo, colour, theme, menu order, household members, sign out. |

Changes show up on the other person's phone within a few seconds, without refreshing.

## How it works

```
iPhone / browser ──► app/index.html + app/server.js  (static files on GitHub Pages)
                        │  Google sign-in (each person's own account)
                        ├──► Google Sheets API   – the "Scout" sheet holds all household data
                        ├──► Google Calendar API – reads each person's chosen calendars, writes shared events
                        ├──► Google Tasks / Drive – tasks; sharing the sheet with a new member
                        └──► helper/scout-keys.gs – tiny Apps Script that swaps sign-in codes for tokens,
                                                    so sign-in lasts without storing the Client Secret in the page
```

There is no server of our own and no build step. `app/server.js` is the browser-side data layer: it talks to the Google APIs directly with the signed-in person's token.

## Folders

| Path | What it is |
| --- | --- |
| `index.html` | Older launcher at the site root that forwards to the original Apps Script version of the app (kept so existing home-screen shortcuts still work). |
| `app/index.html` | The whole app: layout, styles and screens. |
| `app/server.js` | Data layer: Google sign-in, the sheet's tabs and every read/write. |
| `app/fonts/` | Caveat (whiteboard handwriting), with its licence. |
| `app/manifest.webmanifest`, icons | Home-screen app name and icons. |
| `helper/scout-keys.gs` | The "Scout keys" Apps Script (deploy as a web app; see below). |

## The sheet

`SHEET_ID` at the top of `app/server.js` points at the Google Sheet. Tabs are created automatically when missing, and new columns are added as the app grows:

`Profiles`, `Sources`, `Events`, `SharedEvents`, `Config`, `Lists`, `ListItems`, `Board`, `Meals`, `Recipes`, `Rev` (a single row of change stamps used for live updates).

## Setting it up from scratch

1. **Google Cloud:** create a project, enable the Sheets, Calendar, Tasks and Drive APIs, and create an OAuth *Web application* client with `https://kingslayercode.github.io` as an authorised JavaScript origin. Put its Client ID in `CLIENT_ID` (`app/server.js`) and in `helper/scout-keys.gs`.
2. **Scout keys helper:** create an Apps Script project, paste `helper/scout-keys.gs`, add a Script Property `CLIENT_SECRET` with the OAuth client secret, and deploy as a web app (*Execute as: Me*, *Who has access: Anyone*). Put the `/exec` URL in `KEYS_URL` (`app/server.js`). The secret never goes in this repo.
3. **Sheet:** create an empty Google Sheet and put its ID in `SHEET_ID`. Sign in once; Scout builds the tabs.
4. **Publish** the Google project (OAuth consent screen → *In production*) so sign-ins don't expire after 7 days, and add each household member from Profile → Household.

## Making changes

Edit the files and push to `main`; GitHub Pages serves them as they are. After a push, hard-refresh the app (or close and reopen it from the home screen) to get the new version.
