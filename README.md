# Expense Manager

A simple, mobile-first expense tracker in plain HTML, CSS and JavaScript. There's no build step and nothing to install.

## Run it

- **On your computer:** double-click `index.html`. Expenses are saved in the browser (IndexedDB) on this device.
- **Hosted (GitHub Pages):** you also get Google sign-in, cloud backup and sync through Supabase, plus offline use when the app is installed on your phone.

| | Opened as a file | Hosted (https) |
|---|---|---|
| Add / edit / delete expenses | ✅ | ✅ |
| Works offline | ✅ | ✅ (after first visit) |
| Google sign-in + cloud sync | ❌ (Google can't redirect back to a file) | ✅ |
| Install to home screen | ❌ | ✅ |

## Screens

- **Home**: gradient header (title, light/dark toggle, Google sign-in or your profile with an online dot and Logout), an *Install app* banner, *View Your Expenses* / *Shared with you* (coming soon) / *Create New Expense* cards, and **Quick access**.
- **Your Expenses** (`#/lists`): your expense lists, e.g. "Daily Expenses" or "Credit Card". Each card shows its type, number of entries, last entry date and this month's money out (−) / in (+). Use ♡ for quick access, 🔗 to copy a link, ✏️ to edit and 🗑️ to delete.
- **A list** (`#/list/<id>`): this month's spent / received / balance, then the entries as two-line rows: **Amount · Purpose · Pay via** over **Date, time · 📝 · Paid by** (red − for spent, green + for received). A long purpose is cut to 2 lines; tap it (or the row) for the full details, with Edit and Delete. 📝 appears only when there's a note; tap it to see the note.
- **Entry form**: − Spent or + Received, amount, purpose (required), category, date and time, pay via (Cash / UPI / Card / Net banking / Wallet / Other), paid by, and an optional note.
- **Notes**: the same sheet has a **📝 Note** tab for text that isn't money: a month summary, your available balance, a budget, a reminder, money due or lent, or a plain note. Pick a date, time and type, and write as many lines as you like (notes are text only; amounts you type in them are just coloured). In the list a note is a coloured one-line row at its date and time; tap it to expand the full text (and Edit / Delete), tap again to collapse. Notes never count in totals, selections or exports. Money filters (type, pay via, category) hide them; a text search also finds them.
- **List form**: name (required) and an optional type: Daily expenses (default), Trip / travel, Credit card, Personal, Household or Other.

Inner pages use a compact header with back, title, theme and avatar. Everyone starts with a **My Daily Expenses** list (type Daily expenses, in Quick access). Its name and type are fixed, it can't be deleted and it always stays in Quick access. It has the same id on every device, so it never duplicates. Entries saved before lists existed are moved into it automatically.

## Export

On a list, tap 📤 to export its entries:

- **Format**: Excel (`.xlsx`, with real dates and numbers), CSV, plain text, or PDF (opens the print window; choose *Save as PDF*).
- **Entries**: the rows you ticked, this month, this year, all time, a chosen month or year, or a date range. You can also apply the current search and filters.
- **Columns**: Date, Time, Purpose, Category, Pay via, Paid by and Note can each be switched off. Amount is always included; spent amounts are negative.

The files are made in the browser by [`export.js`](export.js), with no libraries, so export also works offline.

## Import

In the same sheet, the **📥 Import** tab adds entries to the current list from an Excel (`.xlsx`), CSV or text file:

- Files exported from this app import back exactly (all columns).
- Other files work if their first row has column names: Date, Amount (or separate Debit / Credit, Withdrawal / Deposit columns), and optionally Time, Type, Purpose / Description / Narration, Category, Pay via / Mode, Paid by and Note / Remarks. Title rows above the header, as in bank statements, are skipped.
- Dates are read day-first (13/10/2026, 13-10-26, 13 Oct 2026, 2026-10-13, or Excel dates). Negative amounts, "Dr" and "(1,200)" count as spent; positive amounts count as received when the file also has negatives.
- **Or paste text** into the box: rows copied from Excel or Google Sheets, CSV text, this app's text export, or simple lines like `13/10/2026 540 Petrol`.
  It also reads a **day-wise list**: a date on its own line, then that day's entries as `time, amount, purpose, pay via` (an extra field becomes the note; put a field that contains commas in "double quotes"):
  ```
  01/09/2026
  10:30am, 50000, Salary Received, Bank Transfer
  8:11pm, 300, Fish, PhonePe UPI
  ```
  A purpose containing words like *received, salary, refund, cashback, credited* makes an unsigned amount money received. Without a header row the Date, Amount (and Time) and Purpose columns are guessed; plain amounts are spent, and `+15000` or `3,000 Cr` are received.
- You see a preview first. Entries already in the list (same date, amount, type and purpose) are skipped unless you untick that option.
- **⬇ Sample CSV** downloads a template. Reading is done by [`import.js`](import.js), with no libraries.

## Sharing with friends

Tap the share button on any of your lists, enter a friend's **Google email** and choose:

- **👁 View**: they can see the list and its entries.
- **✏️ Edit**: they can also add entries, and edit or delete the entries *they* added.

The friend sees the list under **Shared with you** after signing in with that email. Your card shows a *shared by you* badge and who it's shared with. Change access or remove someone from the same dialog; removed friends lose the list on their next sync. Each entry on a shared list shows who added it.

Sharing needs Google sign-in. Supabase enforces it with Row Level Security (`list_members` table and `list_role()` in [`supabase/schema.sql`](supabase/schema.sql)), so access rules hold even outside the app.

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout |
| `styles.css` | Styling (light and dark mode) |
| `config.js` | **Your Supabase URL and anon key**, currency |
| `db.js` | IndexedDB storage on the device |
| `sync.js` | Google login and sync with Supabase |
| `app.js` | Screens, form, totals and list |
| `sw.js`, `manifest.json` | Offline support and installable app |
| `icons/` | App icons: `icon.svg`, `icon-*.png`, `apple-touch-icon.png` (PNGs are required for installing on Android/iOS); `icon-maskable.svg` is the source of the maskable PNG |
| `server.js` | Local server: `node server.js` → http://localhost:3000 |
| `vendor/supabase.js` | Supabase library (bundled so it works offline) |
| `supabase/schema.sql` | Database table and security rules |

## How data flows

Every expense is saved to IndexedDB first, so the app is always fast and works offline. When you're signed in and online, changes upload to Supabase, and changes from your other devices download. Sync runs after every change, when the app opens, when you come back online, and when you return to the app.

If you add expenses without signing in, they move into your account the first time you sign in.

## Set up Supabase + Google sign-in

1. Use the **OneDB** Supabase project, shared with my other apps (see `OneDB/README.md` in the parent folder). This app's tables live in the `myexpenses` schema.
2. In **SQL Editor**, run `OneDB/platform.sql` first, then [`supabase/schema.sql`](supabase/schema.sql).
   Then add `myexpenses` under **Project Settings → Data API → Exposed schemas**.
3. Turn on Google sign-in:
   - In Google Cloud Console → APIs & Services → Credentials, create an **OAuth client ID** (Web application).
     Under authorized redirect URIs, add the callback URL shown in Supabase → Authentication → Providers → Google
     (`https://<project-ref>.supabase.co/auth/v1/callback`).
   - Paste the client ID and secret into Supabase → Authentication → Providers → Google, and enable it.
4. In Supabase → Authentication → URL Configuration, add your site URL, e.g.
   `https://<your-user>.github.io/myExpenses/`, to **Redirect URLs** (and set it as **Site URL**).
5. Put the project URL and anon key from Supabase → Project Settings → API into [`config.js`](config.js).
   The anon key is meant to be public. Row Level Security keeps each user's data private.
   **Never** use the `service_role` key.

## Host on GitHub Pages

1. Push this folder to a GitHub repo, e.g. `myExpenses`.
2. In the repo, go to **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder `/ (root)` → Save.
3. After a minute the app is live at `https://<your-user>.github.io/myExpenses/`.
4. On your phone, open that URL and choose **Add to Home Screen**.

## Run on localhost

Google sign-in, offline mode and "Install app" need `http://` or `https://`, not `file://`. A tiny server with no dependencies is included:

```sh
node server.js            # → http://localhost:3000
PORT=8080 node server.js  # different port (PowerShell: $env:PORT=8080; node server.js)
```

Add `http://localhost:3000/` to Supabase → Authentication → URL Configuration → **Redirect URLs** so Google sign-in can return to it.
