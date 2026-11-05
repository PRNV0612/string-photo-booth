# Graph Report - string  (2026-11-05)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 75 nodes · 131 edges · 9 communities (8 shown, 1 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- server.js
- onMsg
- package.json
- app.js
- capture
- checkComplete
- handle
- onFrameMsg
- strip.js

## God Nodes (most connected - your core abstractions)
1. `onMsg()` - 12 edges
2. `capture()` - 12 edges
3. `toast()` - 9 edges
4. `setupPC()` - 7 edges
5. `runSession()` - 6 edges
6. `startSession()` - 6 edges
7. `wsSend()` - 6 edges
8. `checkComplete()` - 6 edges
9. `handle()` - 5 edges
10. `onFrameMsg()` - 5 edges

## Surprising Connections (you probably didn't know these)
- `connect()` --calls--> `toast()`  [EXTRACTED]
  public/app.js → public/app.js  _Bridges community 1 → community 4_
- `onMsg()` --calls--> `screen()`  [EXTRACTED]
  public/app.js → public/app.js  _Bridges community 1 → community 5_
- `setupPC()` --calls--> `setupDC()`  [EXTRACTED]
  public/app.js → public/app.js  _Bridges community 1 → community 7_
- `startSession()` --calls--> `grabFrame()`  [EXTRACTED]
  public/app.js → public/app.js  _Bridges community 1 → community 3_
- `capture()` --calls--> `grabFrame()`  [EXTRACTED]
  public/app.js → public/app.js  _Bridges community 3 → community 4_

## Import Cycles
- None detected.

## Communities (9 total, 1 thin omitted)

### Community 0 - "server.js"
Cohesion: 0.11
Nodes (11): crypto, fs, http, https, MIME, path, PORT, PUB (+3 more)

### Community 1 - "onMsg"
Cohesion: 0.22
Nodes (13): connect(), genCode(), handleTime(), onMsg(), resetFrames(), runSession(), setStatus(), setupPC() (+5 more)

### Community 2 - "package.json"
Cohesion: 0.17
Nodes (12): dependencies, ws@^8.18.0, description, engines, node, main, name, private (+4 more)

### Community 3 - "app.js"
Cohesion: 0.31
Nodes (8): b64enc(), grabFrame(), ICE, S, sendFrame(), shutter(), videoReady(), waitFrame()

### Community 4 - "capture"
Cohesion: 0.47
Nodes (6): capture(), endSession(), ensureCam(), flash(), giveUpSession(), toast()

### Community 5 - "checkComplete"
Cohesion: 0.50
Nodes (5): buildChips(), checkComplete(), framesReady(), renderStrip(), screen()

### Community 6 - "handle"
Cohesion: 0.50
Nodes (5): handle(), makeCode(), onConn(), other(), send()

### Community 7 - "onFrameMsg"
Cohesion: 0.67
Nodes (3): b64dec(), onFrameMsg(), setupDC()

## Knowledge Gaps
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ws` connect `package.json` to `server.js`?**
  _High betweenness centrality (0.104) - this node is a cross-community bridge._
- **Should `server.js` be split into smaller, more focused modules?**
  _Cohesion score 0.1111111111111111 - nodes in this community are weakly interconnected._
- **Why does `syncClock()` connect `onMsg` to `app.js`?**
  _High betweenness centrality (0.013) - this node is a cross-community bridge._