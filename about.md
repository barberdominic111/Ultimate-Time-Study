# TimeStudy

TimeStudy is a mobile-first time study tool for the shop floor, inspired by UMT/LaborPro. You watch an operator and tap a button at the end of each cycle. The app turns those timestamps into cycle-time stats, waste and delay analysis, and an operator utilization picture.

## How a Study Works

1. **Setup:** station, associate, target cycle time, and optional quantity and shift length.
2. **Timer:** a live stopwatch runs and shifts from green to yellow to red as it nears the target.
3. **Capture:** each tap logs a lap and restarts the clock instantly.
   - **Normal** is a clean cycle.
   - **The 8 wastes** explain why a cycle went badly: Transport, Inventory, Motion, Waiting, Overproduction, Overprocessing, Defects, Skills.
   - **The 4 delays** mark time when work wasn't happening: Direct Delay, Indirect Delay, Troubleshooting, Fumble.
4. **Notes:** non-normal taps open an optional comment box. The clock has already stopped by then, so typing never inflates the cycle.
5. **Corrections:** pause the clock, or tap any lap in the history to disregard it. Disregarded laps drop out of every stat and chart.
6. **Analyze and export:** five tabs plus a one-tap CSV export of everything.

## The Five Tabs

| Tab | What it shows |
|---|---|
| **Timer** | Stopwatch, button grids, earned time bank, pace rating, and recent laps |
| **Chart** | Run chart with cycles, moving average, overall average, and target line |
| **Pareto** | Two-stage waterfall for wastes and for delays (see below) |
| **Utilization** | Pie of utilized vs. unutilized time, plus a wall-clock timeline |
| **Balance** | Horizontal box-and-whisker plot with a full stats table |

### Pareto

- **Stage 1** ranks categories by count and highlights the ones that make up the first 80%. A toggle controls whether Normal is included.
- **Stage 2** ranks the comments within only those top categories. Comments are grouped ignoring case and punctuation, and blanks become "Undefined."
- Wastes and delays each get their own two-stage pareto.
- The waterfall chart floats each bar from the prior running total to its own, so you can see which categories stack up to reach the 80% line.

### Utilization

- **Utilized:** Normal and the 8 wastes.
- **Unutilized:** the 4 delays.
- The timeline plots each cycle at its real clock time, with utilized blocks above the axis and delays below. Block width is the cycle's duration, and each tag has its own color.

### Balance

- Min, whisker low, Q1, median, Q3, whisker high, max, and outliers, using the Tukey 1.5×IQR method.
- Target cycle time is overlaid as a reference line.
- Supporting data includes average, standard deviation, pace rating, takt time, and required associates.
- Designed to feed an operator loading chart built outside the app.

## Key Metrics

- **Pace rating:** target ÷ average × 100. 100 is standard and 115 is 15% faster. It works like a golf handicap for comparing associates.
- **Earned time:** time saved on cycles faster than target, banked so it can be spent later.
- **Cycle-time color:** green below 80% of target, yellow at 80–89%, red at 90% and above.

## Export

The ⬇ button in the header, available from any tab, downloads one CSV with labeled sections:

1. Session config
2. Summary stats
3. Box and whisker values
4. Downtime pareto, stages 1 and 2
5. Utilization pareto, stages 1 and 2
6. Operator utilization totals
7. Every raw lap with all fields

## Code Features

- **Architecture:** a single `App.jsx` (about 1,500 lines) using React 18 hooks. Components are `SetupScreen`, `ActiveSession`, `ParetoWaterfallChart`, `UtilizationPie`, `UtilizationTimeline`, and `BoxWhiskerPlot`.
- **One source of truth:** everything derives from a single `laps` array. Stats, charts, paretos, and exports are computed with `useMemo` from the non-disregarded laps, so disregarding one lap updates everything at once.
- **Accurate timing:** elapsed time comes from timestamps (`Date.now()` minus a start ref), not interval tick counts, so it can't drift. Paused time is tracked separately and subtracted.
- **Data-driven tags:** wastes and delays are config arrays. Helpers like `isNormalTag`, `buildPareto`, and `centerNormalLayout` drive the button grid and the analysis, so adding a category is a one-line change.
- **Custom SVG charts:** the pie, timeline, and box plot are hand-built SVG with no chart library. Recharts handles only the run chart and the waterfall.
- **Styling:** all inline style objects, with no CSS framework.
- **Export:** the CSV is built client-side with a Blob download.
- **PWA:** Vite plus `vite-plugin-pwa` provides a manifest, a Workbox service worker, and offline support. `vercel.json` rewrites all routes to the single-page app.

### Lap Data Model

```js
{
  n,          // sequential number
  cycleSec,   // duration in seconds
  timestamp,  // wall-clock end time (ms)
  variance,   // cycleSec - targetSec
  earnedSec,  // time banked if faster than target
  tagKey,     // normal, motion, direct_delay, etc.
  group,      // "waste" | "delay"
  note,       // free-text comment
  disregard,  // true = excluded from all stats and charts
}
```

## Project Structure

```
timestudy/
├── index.html
├── package.json
├── vite.config.js
├── vercel.json
├── .gitignore
├── public/
│   ├── favicon.svg
│   ├── icon-192.png    (you supply)
│   └── icon-512.png    (you supply)
└── src/
    ├── main.jsx
    ├── index.css
    └── App.jsx
```

## Deployment

1. Unzip the project, then run `npm install` and `npm run dev` to test locally.
2. Push to a GitHub repo.
3. Import the repo in Vercel. The Vite preset is detected automatically.
4. On a phone, open the Vercel URL and choose Add to Home Screen to install it as a PWA.

## Known Limitations

- Sessions save to localStorage when you tap END, but there is no screen yet to reopen them. Export the CSV before ending a study.
- The PWA icons `icon-192.png` and `icon-512.png` still need to be supplied.
- The original bar-style `ParetoChart` is still in the file, unused, in case you want to switch back.
- Multi-station line balancing and Firebase sync are planned but not built.

## Improvement Tracker Readiness (Data Contract v1.0)

TimeStudy stays local-first and collects observations only. It links to other apps through portable JSON files, with no backend, database, or sync.

- **Stable ID:** every new study gets a `studyId` (UUID) at creation. It never changes through edits or exports. Older saved studies receive one the first time they are exported or opened in Saved Studies, and their laps and settings are not altered.
- **Optional links:** `improvementId`, `processId`, `sequenceId`, `elementId`, `sourceWorkStudyRecordId`, and a study role (`baseline`, `trial`, `post_change`, `verification`, `unspecified`). None are required. They can be set in setup (Linking & context) or later under Saved Studies > Edit details.
- **Status and timestamps:** `studyStatus` is `draft`, `completed`, or `reviewed`. `createdAt` and `updatedAt` are ISO 8601. Editing details updates `updatedAt`, so a re-export is never identical to an earlier one.
- **Single-study JSON:** the `{ }` button in the session header, or Export JSON in Saved Studies. It contains the header, `links`, `study.configuration`, `study.summary`, and every raw lap.
- **Export-all JSON:** Saved Studies > Export All. It contains a `manifest` (app name, schema version, export time, record count) and a `records` array using the same record schema.
- **Raw laps are preserved:** disregarded laps stay in the export with `disregard: true` and `includedInStatistics: false`, so downstream tools can apply the same inclusion rule.
- **Summary:** total, included, and disregarded laps, sample count, average, median, min, max, population standard deviation, target and unit, pace rating, and per-tag and per-group statistics. Anything not calculable is `null`, never zero. Times are in seconds.
- **Work Study import:** Linking & context > Import Work Study context. The file is fully validated, previewed, and only applied after confirmation. It fills the setup form only. Imported standard times are kept as reference values and are never treated as an observed standard. Files with an unknown `schemaVersion` or malformed fields are rejected with a message.
- **Evidence rules:** the app never overwrites a previous export or another study, and it makes no claim that a study proves a sustained improvement.

CSV export and all analysis tabs are unchanged.
