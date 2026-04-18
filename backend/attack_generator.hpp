#pragma once
// attack_generator.hpp — Simulated DDoS event generator
// Uses a thread pool + lock-free-style atomic queue to produce events.
// SAFETY: Generates SIMULATED data only — no real network packets are sent.

#include <string>
#include <vector>
#include <functional>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <queue>
#include <random>
#include <chrono>

/* ── Attack event ── */
struct AttackEvent {
    std::string source_ip;
    std::string source_country;
    std::string target_ip;
    std::string target_country;
    std::string attack_type;
    int         packet_rate;
    long long   timestamp;   // Unix ms
};

/* ── Generator ── */
class AttackGenerator {
public:
    using EventCB = std::function<void(const AttackEvent&)>;

    static AttackGenerator& get() {
        static AttackGenerator inst;
        return inst;
    }

    // Set callback invoked for each generated event (thread-safe)
    void setCallback(EventCB cb) {
        std::lock_guard<std::mutex> lk(cb_mx_);
        callback_ = std::move(cb);
    }

    // Start background generation threads
    void start(int threads = 4, int events_per_sec = 200) {
        if (running_) return;
        running_        = true;
        events_per_sec_ = events_per_sec;
        interval_us_    = 1'000'000 / events_per_sec;

        for (int i = 0; i < threads; i++)
            workers_.emplace_back([this]{ workerLoop(); });

        LOG_INFO << "[AttackGenerator] Started " << threads
                 << " workers at ~" << events_per_sec << " events/sec";
    }

    void stop() {
        running_ = false;
        cv_.notify_all();
        for (auto& t : workers_) if (t.joinable()) t.join();
        workers_.clear();
    }

    ~AttackGenerator() { stop(); }

private:
    AttackGenerator()
        : running_(false), events_per_sec_(200), interval_us_(5000)
    {
        seedData();
    }

    /* ── Seed static data ── */
    void seedData() {
        countries_ = {
            "United States", "China", "Russia", "Germany", "Brazil",
            "United Kingdom", "France", "Japan", "Australia", "India",
            "South Korea", "Canada", "Netherlands", "Ukraine", "Iran",
            "North Korea", "Turkey", "Romania", "Vietnam", "Nigeria",
            "Singapore", "Poland", "Sweden", "Mexico", "Argentina",
            "Indonesia", "Pakistan", "Saudi Arabia", "South Africa",
            "Israel", "Taiwan", "Czech Republic", "Bulgaria", "Thailand",
        };
        attack_types_ = {
            "SYN Flood", "UDP Flood", "HTTP Flood",
            "DNS Amplification", "ICMP Flood", "NTP Amplification",
        };
        /* Weighted distribution */
        type_weights_ = {30, 25, 18, 12, 8, 7};
        int sum = 0;
        for (int w : type_weights_) { sum += w; type_cumul_.push_back(sum); }
        type_total_ = sum;
    }

    /* ── Worker thread ── */
    void workerLoop() {
        std::mt19937_64 rng(std::random_device{}());

        while (running_) {
            auto t0 = std::chrono::steady_clock::now();

            AttackEvent ev = generateEvent(rng);
            dispatchEvent(ev);

            auto elapsed = std::chrono::steady_clock::now() - t0;
            auto sleep   = std::chrono::microseconds(interval_us_) - elapsed;
            if (sleep.count() > 0)
                std::this_thread::sleep_for(sleep);
        }
    }

    /* ── Generate one event ── */
    AttackEvent generateEvent(std::mt19937_64& rng) {
        AttackEvent ev;

        // Random source & distinct target
        size_t si = rng() % countries_.size();
        size_t di;
        do { di = rng() % countries_.size(); } while (di == si);

        ev.source_country = countries_[si];
        ev.target_country = countries_[di];
        ev.source_ip      = randomIP(rng);
        ev.target_ip      = randomIP(rng);
        ev.attack_type    = weightedType(rng);
        ev.packet_rate    = 500 + static_cast<int>(rng() % 94501);
        ev.timestamp      = nowMs();

        return ev;
    }

    std::string randomIP(std::mt19937_64& rng) {
        return std::to_string(1 + rng() % 253) + '.' +
               std::to_string(rng() % 256) + '.' +
               std::to_string(rng() % 256) + '.' +
               std::to_string(rng() % 256);
    }

    std::string weightedType(std::mt19937_64& rng) {
        int r = static_cast<int>(rng() % type_total_);
        for (size_t i = 0; i < type_cumul_.size(); i++)
            if (r < type_cumul_[i]) return attack_types_[i];
        return attack_types_.back();
    }

    long long nowMs() {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
    }

    void dispatchEvent(const AttackEvent& ev) {
        std::lock_guard<std::mutex> lk(cb_mx_);
        if (callback_) callback_(ev);
    }

    /* ── Members ── */
    std::atomic<bool>        running_;
    int                      events_per_sec_;
    int                      interval_us_;
    std::vector<std::thread> workers_;
    std::mutex               cv_mx_;
    std::condition_variable  cv_;

    std::mutex               cb_mx_;
    EventCB                  callback_;

    std::vector<std::string> countries_;
    std::vector<std::string> attack_types_;
    std::vector<int>         type_weights_;
    std::vector<int>         type_cumul_;
    int                      type_total_;
};

/* ── Quick LOG shim (replaced by Drogon's trantor in real build) ── */
#ifndef LOG_INFO
#include <iostream>
#define LOG_INFO  std::cout << "[INFO] "
#define LOG_ERROR std::cerr << "[ERR]  "
#endif
