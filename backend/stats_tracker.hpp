#pragma once
// stats_tracker.hpp — Thread-safe global statistics accumulator

#include <atomic>
#include <mutex>
#include <unordered_map>
#include <string>
#include <vector>
#include <algorithm>
#include <chrono>

struct CountryStat {
    std::string name;
    uint64_t    count;
};

class StatsTracker {
public:
    static StatsTracker& get() {
        static StatsTracker instance;
        return instance;
    }

    void record(const std::string& src,
                const std::string& dst,
                const std::string& type,
                int                rate) {
        total_attacks_.fetch_add(1, std::memory_order_relaxed);
        total_pps_.fetch_add(rate,  std::memory_order_relaxed);

        {
            std::lock_guard<std::mutex> lk(mx_);
            attackers_[src]++;
            targets_[dst]++;
            types_[type]++;
            if (rate > peak_rate_) peak_rate_ = rate;
        }

        // APS counter
        aps_bucket_.fetch_add(1, std::memory_order_relaxed);
    }

    uint64_t totalAttacks()  const { return total_attacks_.load(); }
    uint64_t aps()           const { return current_aps_.load();   }
    int      peakRate()      const { return peak_rate_;            }

    std::vector<CountryStat> topAttackers(size_t n = 10) const {
        std::lock_guard<std::mutex> lk(mx_);
        return topN(attackers_, n);
    }
    std::vector<CountryStat> topTargets(size_t n = 10) const {
        std::lock_guard<std::mutex> lk(mx_);
        return topN(targets_, n);
    }
    std::unordered_map<std::string,uint64_t> typeBreakdown() const {
        std::lock_guard<std::mutex> lk(mx_);
        return types_;
    }

    // Call once per second from a timer
    void drainAPS() {
        uint64_t bucket = aps_bucket_.exchange(0, std::memory_order_relaxed);
        current_aps_.store(bucket, std::memory_order_relaxed);
    }

private:
    StatsTracker() = default;

    std::atomic<uint64_t> total_attacks_{0};
    std::atomic<uint64_t> total_pps_{0};
    std::atomic<uint64_t> aps_bucket_{0};
    std::atomic<uint64_t> current_aps_{0};
    int                   peak_rate_{0};

    mutable std::mutex mx_;
    std::unordered_map<std::string,uint64_t> attackers_;
    std::unordered_map<std::string,uint64_t> targets_;
    std::unordered_map<std::string,uint64_t> types_;

    static std::vector<CountryStat> topN(
        const std::unordered_map<std::string,uint64_t>& m, size_t n)
    {
        std::vector<CountryStat> v;
        v.reserve(m.size());
        for (auto& [k, cnt] : m) v.push_back({k, cnt});
        std::partial_sort(v.begin(),
            v.begin() + std::min(n, v.size()),
            v.end(),
            [](const CountryStat& a, const CountryStat& b){ return a.count > b.count; });
        if (v.size() > n) v.resize(n);
        return v;
    }
};
