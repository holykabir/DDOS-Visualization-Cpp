# ThreatScope — Setup Guide
## Global DDoS Visualization Platform

> ⚠️ **SAFETY NOTICE**: This system simulates attack data for visualization and educational purposes only.
> No real network attack traffic is generated at any point.

---

## Project Structure

```
ddos-visualizer/
├── backend/
│   ├── CMakeLists.txt          # CMake build config
│   ├── main.cpp                # Drogon entry point
│   ├── attack_generator.hpp    # Multi-threaded event simulator (header-only)
│   ├── websocket_server.hpp    # Drogon WebSocket controller (header-only)
│   ├── api_routes.hpp          # REST API controller (header-only)
│   └── stats_tracker.hpp       # Thread-safe stats accumulator (header-only)
├── frontend/
│   ├── index.html              # Dashboard HTML
│   ├── styles.css              # Cyberpunk dark theme
│   ├── globe.js                # Three.js 3D globe (ES module)
│   ├── main.js                 # App logic + simulation (ES module)
│   └── websocket-client.js     # WS client with reconnect (ES module)
├── data/
│   └── country_coordinates.json  # 35 country lat/lon entries
└── docs/
    └── setup.md                # This file
```

---

## Option A — Frontend Only (No Backend Required)

The frontend ships with a built-in JavaScript simulation engine.
Open directly in a browser — no server, no build step.

```bash
# From the project root, serve with any static file server:
npx serve ddos-visualizer/frontend

# Or Python 3:
cd ddos-visualizer/frontend
python3 -m http.server 3000

# Then open: http://localhost:3000
```

The app auto-detects that no WebSocket backend is available and
activates **simulation mode** automatically (shown in the top-right badge).

---

## Option B — Full Stack (C++ Backend + Frontend)

### 1. Install C++ Dependencies

**Ubuntu / Debian**
  ```bash
  sudo apt update
  sudo apt install -y \
      build-essential cmake git \
      libjsoncpp-dev uuid-dev zlib1g-dev \
      libssl-dev libpq-dev \
      libc-ares-dev

  # Install Drogon
  git clone https://github.com/drogonframework/drogon.git
  cd drogon
  git submodule update --init
  mkdir build && cd build
  cmake .. -DCMAKE_BUILD_TYPE=Release
  make -j$(nproc)
  sudo make install
```

**macOS (Homebrew)**
```bash
brew install cmake jsoncpp openssl c-ares zlib
brew install drogon          # or build from source (see above)
```

**Docker (easiest)**
```dockerfile
FROM drogonframework/drogon:latest
WORKDIR /app
COPY backend/ ./backend/
WORKDIR /app/backend
RUN mkdir build && cd build && cmake .. && make -j$(nproc)
EXPOSE 8080
CMD ["./build/threatscope"]
```

---

### 2. Build the Backend

```bash
cd ddos-visualizer/backend
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
```

Expected output:
```
[100%] Linking CXX executable threatscope
[100%] Built target threatscope
```

---

### 3. Run the Backend

```bash
# From the build directory:
./threatscope

# Expected startup log:
# ╔══════════════════════════════════════╗
# ║  ThreatScope DDoS Visualizer Backend ║
# ║  Version 2.4.1  |  SIMULATION ONLY   ║
# ╚══════════════════════════════════════╝
# [Main] Attack generator running
# [INFO] Listening on 0.0.0.0:8080
```

---

### 4. Open the Frontend

```bash
# The backend serves the frontend automatically at:
open http://localhost:8080

# Or, for development with live reload:
cd ddos-visualizer/frontend
npx serve -p 3000 .
# Then open http://localhost:3000
# The frontend will auto-connect to ws://localhost:8080/ws/attacks
```

---

## REST API Reference

| Endpoint              | Description                         |
|-----------------------|-------------------------------------|
| `GET /api/stats`      | Global counters (total, APS, peak)  |
| `GET /api/top-attackers` | Top 10 source countries          |
| `GET /api/top-targets` | Top 10 target countries            |
| `GET /api/attack-types` | Attack type breakdown             |
| `GET /api/health`     | Liveness probe                      |

**Example — /api/stats response:**
```json
{
  "total_attacks": 142857,
  "attacks_per_sec": 392,
  "peak_rate_pps": 94201
}
```

---

## WebSocket Protocol

**Endpoint:** `ws://localhost:8080/ws/attacks`

**Inbound event (server → client):**
```json
{
  "source_country": "China",
  "target_country": "United States",
  "attack_type": "SYN Flood",
  "packet_rate": 45000,
  "source_ip": "192.168.1.100",
  "target_ip": "10.0.0.1",
  "timestamp": 1710000000000
}
```

**Attack types:** `SYN Flood` · `UDP Flood` · `HTTP Flood` ·
`DNS Amplification` · `ICMP Flood` · `NTP Amplification`

---

## Configuration

Edit `main.cpp` to tune generation parameters:

```cpp
// Number of worker threads (default: CPU core count)
AttackGenerator::get().start(4, 400);
//                            ^   ^
//                        threads  events/sec per thread
```

For 10,000 events/sec: set threads=25, events/sec=400.
Scale linearly. The WebSocket broadcast is lock-based so ~1000 clients
is comfortable before needing a pub-sub intermediary (Redis/NATS).

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                   C++ Backend (Drogon)                  │
│                                                         │
│  ┌──────────────┐    ┌────────────────────────────────┐ │
│  │AttackGenerator│───▶│  StatsTracker (atomic/mutex)   │ │
│  │ 4 threads    │    └────────────────────────────────┘ │
│  │ 400 ev/thread│    ┌────────────────────────────────┐ │
│  └──────┬───────┘    │  ApiRoutes  GET /api/*          │ │
│         │            └────────────────────────────────┘ │
│         ▼            ┌────────────────────────────────┐ │
│  ┌──────────────┐    │  AttackStreamWS  /ws/attacks   │ │
│  │ JSON Serialise│───▶│  broadcast() → all clients    │ │
│  └──────────────┘    └────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                              │ WebSocket / HTTP
                     ─────────┼──────────────────
                              │
┌─────────────────────────────────────────────────────────┐
│                    Browser Frontend                     │
│                                                         │
│  main.js ──▶ WSClient ──▶ processEvent()               │
│    │           (auto-falls back to JS simulation)       │
│    │                                                    │
│    └──▶ GlobeRenderer (Three.js)                       │
│           ├── 3D Earth sphere + atmosphere shader      │
│           ├── 9000-star particle field                 │
│           ├── Lat/lon grid lines                       │
│           ├── Animated attack arcs (QuadBezier)        │
│           └── Landing pulse rings                      │
│                                                         │
│  UI panels: stats · vectors · feed · controls          │
└─────────────────────────────────────────────────────────┘
```

---

## Performance Optimization Tips

1. **Arc culling** — Globe keeps max 250 arcs (configurable via `ARC_LIMIT` in `globe.js`).
2. **BufferGeometry reuse** — Arc geometry uses `setDrawRange` for progressive reveal without rebuilding geometry.
3. **UI throttling** — All UI writes go through `requestAnimationFrame` to avoid forced layout thrash.
4. **Backend dispatch** — Each worker thread calls the callback directly; for > 10K clients, introduce a lock-free ring buffer (e.g. `boost::lockfree::queue`) between generator and broadcaster.
5. **Three.js pixel ratio** — Capped at `2.0` to prevent 3x/4x DPR displays from killing frame rate.
6. **WebSocket back-pressure** — If a slow client lags, Drogon's send buffer will drop frames. For production, add per-client send queues with overflow shedding.

---

## Browser Compatibility

| Browser       | Status |
|---------------|--------|
| Chrome 89+    | ✅ Full support (importmap native) |
| Firefox 108+  | ✅ Full support |
| Edge 89+      | ✅ Full support |
| Safari 16.4+  | ✅ Full support |
| Safari < 16.4 | ⚠️  importmap polyfill needed (`es-module-shims`) |
