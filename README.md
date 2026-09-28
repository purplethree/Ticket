# Until Landing: Live Flight Study Tracker

**“Studying until this plane lands.”**

Type a real flight number (for example `EY416`). The app finds today's instance of that flight, loads its live operational data, shows it as a premium digital boarding pass and counts down to touchdown. An airplane moves along a route bar as the real aircraft flies.

Built for study Reels and TikToks: Compact Overlay, Minimal mode, a 9:16 Reel Mode and a `#00FF00` green screen for chroma keying.

> **STUDY VISUAL • NOT VALID FOR TRAVEL.** This is a visualization, not a travel document. The barcode is decorative and cannot be scanned.

Live flight data comes from **[AeroDataBox](https://aerodatabox.com)** through RapidAPI. Its free plan is enough to try the app. ([AirLabs](https://airlabs.co) is also supported, see “Switching data provider”.)

---

## 1. Get a free AeroDataBox key

1. Go to <https://rapidapi.com> and **Sign up** (Google or GitHub login works).
2. Open the AeroDataBox page: <https://rapidapi.com/aedbx-aedbx/api/aerodatabox>.
3. Click **Pricing**, choose the **Basic** plan ($0 / month) and **Subscribe**.
4. Copy your key. On the AeroDataBox page, open **Endpoints**; the code example shows a header `X-RapidAPI-Key` with your key. You can also find it under **My Apps → default-application → Authorization**. It's a long string of letters and numbers. Treat it like a password.

The free Basic plan gives **600 units a month**. Each flight lookup costs 1 unit (see “How much of the free plan does it use?”).

---

## 2a. Put it online with Render (no downloads, works on your phone)

Render runs the server for you and gives you a link like `https://until-landing.onrender.com`. The free plan is enough. Your key is stored in Render's settings, on the server, and never reaches the page.

1. Go to <https://render.com> and **Sign up with GitHub**. When GitHub asks which repositories Render may see, allow this repository (`Ticket`).
2. In the Render dashboard click **New** → **Blueprint**.
3. Pick this repository. If Render asks for a branch, choose the one that contains `render.yaml`. Render reads that file and sets everything up.
4. Render asks for two values:
   * **AERODATABOX_API_KEY**: paste your RapidAPI key.
   * **SITE_PASSWORD**: make up a password. Anyone opening the site needs it, which stops strangers from using up your free units.
5. Click **Apply** (or **Deploy Blueprint**). The first build takes 2–3 minutes.
6. Open the `…onrender.com` link shown at the top of the service page. The browser asks for a user name and password: type anything as the user name and your **SITE_PASSWORD** as the password. The browser remembers it.

Good to know:

* **First load after a break is slow.** Free Render services sleep after about 15 minutes without visitors and take 30–60 seconds to wake. While you're tracking a flight, the page keeps refreshing, which keeps it awake.
* **Updates deploy automatically.** When new code is pushed to that branch, Render rebuilds on its own.
* **Changing the key or password:** Render dashboard → your service → **Environment** → edit → **Save changes**. Render restarts the app.
* **If something breaks,** the **Logs** tab shows what the server printed. A healthy start includes `Live data: AeroDataBox (key loaded…)` and `Password: on`.
* **Created the service before AeroDataBox support existed?** Under **Environment**, add `AERODATABOX_API_KEY` (your key) and `FLIGHT_PROVIDER` = `aerodatabox`, and set `REFRESH_INTERVAL_SECONDS` to `120`.

(Other Node hosts work too. Set `AERODATABOX_API_KEY`, `SITE_PASSWORD` and `HOST=0.0.0.0`, and use `npm ci` to build and `npm start` to run.)

---

## 2b. Or run it on your own computer

You need **Node.js 18.17 or newer**. To check, open a terminal and run `node -v`. If you see an error or a version below 18, install the "LTS" version from <https://nodejs.org>.

> **Where is the terminal?**
> macOS: open **Terminal** (Spotlight → “Terminal”).
> Windows: open **PowerShell** (Start menu → “PowerShell”).
> Then `cd` into this project folder, for example `cd ~/Downloads/Ticket`.

1. **Copy `.env.example` to `.env`** in the project folder:

   | System | Command |
   | --- | --- |
   | macOS / Linux | `cp .env.example .env` |
   | Windows PowerShell | `Copy-Item .env.example .env` |
   | Windows Command Prompt | `copy .env.example .env` |

   (Or duplicate the file in Finder/Explorer and rename the copy to exactly `.env`. On macOS, press `Cmd + Shift + .` in Finder to show hidden dot-files.)

2. **Add your key.** Open `.env` in any text editor and fill in:

   ```
   AERODATABOX_API_KEY=YOUR_KEY
   ```

   Don't add quotes or spaces, then save. The key only lives in `.env` on your computer. The small backend in `server.js` reads it and calls AeroDataBox for the browser, so the key is **never** sent to the web page. (`.env` is in `.gitignore`, so it won't be committed.)

3. **Install** (once): `npm install`

4. **Start:** `npm start`. You should see:

   ```
     ✈  Flight Study Tracker
        Open  http://localhost:3000
        Live data: AeroDataBox (key loaded, refresh every 120s)
   ```

   If it says `Live data: OFF`, the key wasn't found: check step 2, save, and run `npm start` again. Leave the terminal open while you use the app. Press `Ctrl + C` to stop the server.

5. **Open** <http://localhost:3000> in Chrome, type `EY416` and press **TRACK FLIGHT**. No key yet? Click **Try the demo flight**. It costs nothing.

---

## Using it

### Search

* **Flight number:** IATA (`EY416`, `EY 416` and `ey0416` all work) or ICAO call sign (`ETD416`).
* **Flight date (optional):** the departure date at the departure airport. Leave it empty to get today's flight.

Flight numbers repeat daily, so the app looks at the instances around now and picks one in this order:

1. the instance that is **airborne right now**
2. **today's upcoming** instance (later today at the departure airport, or within the next 12 hours)
3. otherwise it **does not guess**. It shows *“Couldn't find an active EY416. Choose another flight instance below.”* with a list (route, date, times, status), most recently completed first.

If two instances tie (for example a multi-leg flight number), you get the same list. Once a flight is loaded, **Other EY416 flights** under the card lets you switch.

### Layouts

| Layout | What it shows |
| --- | --- |
| **Full ticket** | The complete boarding pass: airline, route, times, live route bar, countdown, passenger grid, gate/terminal, aircraft, registration, decorative barcode |
| **Compact** | A small overlay card: flight, status, codes, cities, route bar, %, countdown, landing time |
| **Minimal** | `EY416 · 02:28:43 LEFT` and `AUH ●━━━✈━━○ HKT` |

### Reel Mode (recording)

Click **Reel mode** (or press `R`). Navigation, settings, editing buttons and data/debug text disappear. The card is laid out inside a 9:16 frame and scales to it:

* at **1080 × 1920** (or any 9:16 window) the frame fills the screen
* on a wider screen the 9:16 frame is centred, and the background colour fills the rest

Move the mouse (or tap) to reveal a small control bar for **Full ticket / Compact / Minimal**, **Dark / Light / Green**, **Position** and **Fullscreen**. It fades away after 2 seconds and the cursor hides. Press `Esc` to leave.

**Position** (also in **Display**) places the widget at **Center**, **Top right**, **Bottom right** or **Bottom center** of the 9:16 frame, with safe margins for the platform UI.

**Recording at exactly 1080 × 1920 in Chrome:** open DevTools (`F12`), click the device toolbar icon (`Ctrl/Cmd + Shift + M`), choose *Dimensions: Responsive* and enter `1080 × 1920` (or `540 × 960` at DPR 2). Then record the tab with OBS, QuickTime or the Xbox Game Bar. On a phone, open the app in the browser and use the phone's screen recorder.

### Green screen

**Display → Overlay background → Green screen** (or `B` to cycle) paints pure `#00FF00` behind the widget. The card itself stays charcoal, and shadows are switched off so no dark halo is left after keying.

In **CapCut:** add the recording as an overlay → *Remove BG* → *Chroma key* → pick the green → raise *Intensity* until the green disappears.
In **Premiere Pro:** *Effects* → *Ultra Key* → eyedropper on the green.

### Edit pass (visual-only fields)

**Edit pass** (or `E`) lets you set the passenger name, seat, boarding group/zone, cabin class, booking reference, sequence number and boarding time. The defaults are *DEREK YANG · 12A · GROUP 3 · ECONOMY*.

These fields are saved only in your browser's local storage and are **never sent** to the server or the flight API. If you set a boarding time, the status shows **BOARDING** between that time and the departure. That status comes from your own input, not from the airline.

### Display settings

* Overlay background: **Dark / Light / Green screen**
* Position in Reel Mode
* Size: **S / M / L**
* Accent colour: **Blue / Gold / White**

### Keyboard shortcuts (tracker screen)

| Key | Action |
| --- | --- |
| `R` | Reel Mode on/off |
| `1` `2` `3` | Full ticket / Compact / Minimal |
| `B` | Cycle background |
| `P` | Cycle position |
| `F` | Fullscreen |
| `E` | Edit pass |
| `Space` | Pause / resume (**Demo Mode only**) |
| `Esc` | Close menus, exit Reel Mode |

### Links you can bookmark

* `…/?flight=EY416` loads that flight directly
* `…/?flight=EY416&layout=compact&bg=green&pos=top-right&reel=1` opens a ready-to-record overlay
* `…/?demo=1` starts Demo Mode

Accepted values: `layout=full|compact|minimal`, `bg=dark|light|green`, `pos=center|top-right|bottom-right|bottom-center`, `size=s|m|l`, `accent=blue|gold|white`, `date=YYYY-MM-DD`.

### Demo Mode

**Try the demo flight** simulates *Etihad EY416 Abu Dhabi (AUH) → Phuket (HKT)* on an *Airbus A321LR*: 6 h 30 m total, 2 h 30 m remaining when it starts. A yellow **DEMO** badge is always visible, including in Reel Mode, so the simulation can't be mistaken for live tracking. Demo Mode uses **no API units**. You can pause it, run it at 1× / 10× / 60×, and jump to *Pre-departure* or the *Final 90 s* to watch the landing.

Live tracking has **no pause**, because real time can't be paused.

---

## How much of the free plan does it use?

| Action | AeroDataBox units |
| --- | --- |
| Search | 1. It's 2 when nothing is airborne or leaving today, because the neighbouring day is also fetched for the picker. |
| Each refresh | 1 (times, gates, aircraft and live position all come in one lookup) |
| Demo Mode | 0 |

With the default refresh of **120 seconds**, a 6‑hour flight uses about **180 units**, so the free 600 units cover about three long flights a month. Before departure the app refreshes much less often (every 2–15 minutes), and it stops once the landing is confirmed. It also pauses while the browser tab is hidden. Identical lookups within 25 seconds are answered from the server's memory, so a second tab costs nothing.

Want smoother live updates and have units to spare? Set `REFRESH_INTERVAL_SECONDS=60` (minimum 30). Between refreshes the plane and countdown keep moving smoothly either way.

---

## How the live numbers are calculated

### Time until landing

`estimated arrival − now`, or the scheduled arrival if there is no estimate (labelled *UNTIL SCHEDULED LANDING*). The countdown ticks **every second in the browser**; the API is **not** called every second. When a refresh changes the ETA, the countdown glides to the new value over about 2 seconds instead of jumping. It never goes negative. At zero it shows **LANDED**, the app asks for confirmation shortly afterwards, and the status pill turns **LANDED** once the data confirms it.

### Route progress

* **LIVE POSITION:** when the data includes a recent aircraft position (under 15 min old), its latitude/longitude is projected onto the great-circle route between the two airports (along-track distance, spherical geometry). This ignores sideways airway offsets, and the result is clamped to 0–100 %. If the aircraft is far off the direct route (a hold or a diversion), the app switches to `flown / (flown + remaining)` distances.
* **ETA BASED:** if there is no fresh position, progress is `(now − departure) / (arrival − departure)`. The departure is the actual take-off time, else the estimated time, else the scheduled time. The arrival is the estimated time, else the scheduled time.

Between refreshes the plane keeps moving from the last real position at the rate that brings it to the destination at the ETA. When new data arrives, any difference is blended out over a few seconds, so the plane never jumps.

A subtle label under the countdown shows which method is active.

### Statuses

| Status | When |
| --- | --- |
| SCHEDULED | the flight hasn't departed and nothing else applies |
| BOARDING | the data provider reports boarding, **or** the boarding time **you entered** has passed |
| GATE CLOSED | reported by the data provider |
| DELAYED | reported, or the departure is ≥ 15 min late |
| DEPARTED | right after take-off, before a live position arrives |
| IN FLIGHT | the flight is reported en route, or there is a live position |
| DESCENDING | reported as approaching, or live data shows a descent with under 50 min to go |
| LANDED | reported as arrived, or an actual arrival time exists |
| CANCELLED / DIVERTED | reported by the data provider |

### Real data only

Gate, terminal, registration, aircraft, ETA and position come only from the flight-data API. If a value is missing, the field is **hidden** on the pass or shown as **—** in the Live Flight panel. The app never fills in a gate, terminal, registration or position. A position attached to a flight that hasn't departed is ignored, because it could belong to the aircraft's previous flight.

---

## Phone access

Easiest: put it online with Render (above) and open the link on your phone. To use your own computer instead, set `HOST=0.0.0.0` in `.env` and restart. On your phone (same Wi-Fi), open `http://<your-computer's-IP>:3000`, e.g. `http://192.168.1.23:3000`. To find the IP: macOS *System Settings → Wi-Fi → Details*, Windows `ipconfig`. Keep `HOST=127.0.0.1` otherwise, so nobody else on the network can use your API allowance.

---

## Troubleshooting

| Message | Fix |
| --- | --- |
| *Live tracking isn't set up yet…* | No key found. Add `AERODATABOX_API_KEY` (in `.env`, or Render → Environment) and restart. |
| *AeroDataBox rejected the API key…* | Wrong key. Copy it again from RapidAPI (step 1.4). |
| *Your RapidAPI key isn't subscribed to AeroDataBox yet…* | On the AeroDataBox page on RapidAPI, open **Pricing** and subscribe to **Basic** ($0). |
| *Your AeroDataBox plan's monthly allowance has run out…* | The 600 free units are used up. Wait for the monthly reset or upgrade, and use Demo Mode meanwhile. Next time, use a longer refresh interval. |
| *…too many requests right now…* | Short-term limit hit. Wait a minute. |
| *Couldn't find a flight XX123…* | Check the number. Leave the date empty for today's flight. |
| *Couldn't find an active EY416. Choose another flight instance below.* | Nothing airborne or departing today. Pick an instance from the list. |
| *Couldn't reach the local server…* | The terminal running `npm start` was closed (or the Render service is restarting). Start it again / wait a minute. |
| *Port 3000 is already in use* | Set `PORT=3001` in `.env` and open `http://localhost:3001`. |
| Browser keeps asking for a password | That's `SITE_PASSWORD`. Any user name works; the password must match exactly. After 10 wrong tries, wait 10 minutes. |
| Render link takes a minute to open | The free plan was asleep. It wakes on the first visit. |

---

## Switching data provider

Two providers are included:

| Provider | Settings |
| --- | --- |
| **AeroDataBox** (default) | `FLIGHT_PROVIDER=aerodatabox`, `AERODATABOX_API_KEY=…` |
| **AirLabs** | `FLIGHT_PROVIDER=airlabs`, `AIRLABS_API_KEY=…` (AirLabs currently has a sign-up waitlist) |

If `FLIGHT_PROVIDER` is empty, the app uses whichever key is set.

Everything outside `providers/` works with a provider-neutral flight model (documented at the top of `providers/index.js`). To add another service (e.g. FlightAware AeroAPI):

1. create `providers/aeroapi.js` exposing `isConfigured()`, `findInstances(flightCode, { date })` and `refreshInstance(flightCode, ref)` that return that model;
2. register it in `PROVIDERS` in `providers/index.js`;
3. set `FLIGHT_PROVIDER=aeroapi` (plus its key).

The server, instance selection and frontend need no changes.

---

## Project structure

```
server.js              Express backend: static files + /api/config, /api/search, /api/flight
render.yaml            one-click Render setup (Blueprint)
providers/
  index.js             provider registry + the provider-agnostic data model
  aerodatabox.js       AeroDataBox integration (Flight Status API via RapidAPI)
  airlabs.js           AirLabs integration (Flight Information + Real-Time Flights + Schedules)
lib/
  select.js            picks the right daily instance (airborne > today > ask)
  flight-code.js       parses "EY 416", "ETD416", ...
  errors.js            error codes → human-readable messages
  auth.js              optional site password (SITE_PASSWORD)
  cache.js             TTL cache (memory + disk for reference data)
  aircraft-types.js    ICAO type code → model name
public/
  index.html           markup for all screens
  style.css            design system: boarding pass, overlays, Reel Mode
  js/app.js            UI controller: search, refresh loop, Reel Mode, settings
  js/model.js          progress / ETA / status engine with smooth blending
  js/render.js         builds and updates the pass, compact and minimal widgets
  js/geo.js            great-circle maths
  js/demo.js           Demo Mode simulation
  js/format.js         time-zone-aware formatting (no NaN / undefined ever shown)
test/                  node:test suites (npm test)
test-support/          local AeroDataBox and AirLabs stand-ins used only by the tests
```

### Tests

```
npm test
```

This runs the geometry, progress/ETA model, instance-selection, password and backend tests. The backend tests run against local stand-ins in `test-support/`, so they spend no API units. Those stand-ins are used only by the tests; live mode always talks to the real service.

---

## Limitations

* Coverage depends on the data provider. Gates, terminals, registrations, estimates and live positions are not available for every airline, airport or flight, and missing fields are hidden.
* Positions come from ADS-B coverage. Over oceans the position can be stale, and the app then switches to ETA-based progress.
* This is a study/social-media visual. It is not affiliated with any airline, and it is **not valid for travel**.
