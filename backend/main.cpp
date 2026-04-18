/**
 * main.cpp — ThreatScope Backend Entry Point
 * Framework : Drogon (https://github.com/drogonframework/drogon)
 * Language  : C++17
 *
 * SAFETY NOTICE: This backend generates SIMULATED attack data only.
 * No real network packets, no real IPs are targeted.
 */

#include <drogon/drogon.h>
#include <trantor/utils/Logger.h>
#include <thread>
#include <chrono>
#include <string>
#include <sstream>

#include "attack_generator.hpp"
#include "stats_tracker.hpp"
#include "websocket_server.hpp"
#include "api_routes.hpp"

/* ─── JSON serialiser (no external lib required) ─── */
static std::string eventToJSON(const AttackEvent& ev) {
    std::ostringstream ss;
    ss << '{'
       << "\"source_country\":\""  << ev.source_country << "\","
       << "\"target_country\":\""  << ev.target_country << "\","
       << "\"attack_type\":\""     << ev.attack_type    << "\","
       << "\"packet_rate\":"       << ev.packet_rate    << ','
       << "\"source_ip\":\""       << ev.source_ip      << "\","
       << "\"target_ip\":\""       << ev.target_ip      << "\","
       << "\"timestamp\":"         << ev.timestamp
       << '}';
    return ss.str();
}

int main() {
    LOG_INFO << "╔══════════════════════════════════════╗";
    LOG_INFO << "║  ThreatScope DDoS Visualizer Backend ║";
    LOG_INFO << "║  Version 2.4.1  |  SIMULATION ONLY   ║";
    LOG_INFO << "╚══════════════════════════════════════╝";

    /* ── 1. Wire attack generator → stats + WebSocket broadcast ── */
    AttackGenerator::get().setCallback([](const AttackEvent& ev) {
        // Record stats
        StatsTracker::get().record(
            ev.source_country, ev.target_country,
            ev.attack_type, ev.packet_rate);

        // Broadcast JSON to WebSocket clients
        AttackStreamWS::broadcast(eventToJSON(ev));
    });

    /* ── 2. APS drain timer (runs on Drogon's event loop) ── */
    drogon::app().getLoop()->runEvery(1.0, [] {
        StatsTracker::get().drainAPS();
    });

    /* ── 3. Start attack generator (4 threads, ~400 events/sec) ── */
    drogon::app().registerBeginningAdvice([] {
        AttackGenerator::get().start(4, 400);
        LOG_INFO << "[Main] Attack generator running";
    });

    /* ── 4. Configure and run Drogon ── */
    drogon::app()
        .setLogPath("./logs")
        .setLogLevel(trantor::Logger::kInfo)

        // HTTP + WebSocket on port 8080
        .addListener("0.0.0.0", 8080)

        // Worker threads = CPU cores
        .setThreadNum(static_cast<int>(std::thread::hardware_concurrency()))

        // Idle timeout for WebSocket connections (seconds)
        .setIdleConnectionTimeout(600)

        // Max concurrent connections
        .setMaxConnectionNum(10000)

        // Enable GZIP compression for REST responses
        .enableGzip(true)

        // Static file serving: serve the frontend from /frontend
        .setDocumentRoot("../frontend")

        .run();

    /* Cleanup */
    AttackGenerator::get().stop();
    LOG_INFO << "[Main] Shutdown complete.";
    return 0;
}
