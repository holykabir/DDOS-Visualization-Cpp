#pragma once
#include <drogon/HttpController.h>
#include <drogon/HttpResponse.h>
#include "stats_tracker.hpp"
#include <json/json.h>

class ApiRoutes : public drogon::HttpController<ApiRoutes>
{
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(ApiRoutes::stats,        "/api/stats",         drogon::Get);
    ADD_METHOD_TO(ApiRoutes::topAttackers, "/api/top-attackers", drogon::Get);
    ADD_METHOD_TO(ApiRoutes::topTargets,   "/api/top-targets",   drogon::Get);
    ADD_METHOD_TO(ApiRoutes::attackTypes,  "/api/attack-types",  drogon::Get);
    ADD_METHOD_TO(ApiRoutes::health,       "/api/health",        drogon::Get);
    METHOD_LIST_END

    void stats(const drogon::HttpRequestPtr& /*req*/, std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
        auto& st = StatsTracker::get();
        Json::Value root;
        root["total_attacks"]   = static_cast<Json::UInt64>(st.totalAttacks());
        root["attacks_per_sec"] = static_cast<Json::UInt64>(st.aps());
        root["peak_rate_pps"]   = st.peakRate();
        cb(jsonResp(root));
    }

    void topAttackers(const drogon::HttpRequestPtr& /*req*/, std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
        auto list = StatsTracker::get().topAttackers(10);
        Json::Value arr(Json::arrayValue);
        for (auto& cs : list) { Json::Value o; o["country"] = cs.name; o["count"] = static_cast<Json::UInt64>(cs.count); arr.append(o); }
        cb(jsonResp(arr));
    }

    void topTargets(const drogon::HttpRequestPtr& /*req*/, std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
        auto list = StatsTracker::get().topTargets(10);
        Json::Value arr(Json::arrayValue);
        for (auto& cs : list) { Json::Value o; o["country"] = cs.name; o["count"] = static_cast<Json::UInt64>(cs.count); arr.append(o); }
        cb(jsonResp(arr));
    }

    void attackTypes(const drogon::HttpRequestPtr& /*req*/, std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
        auto breakdown = StatsTracker::get().typeBreakdown();
        Json::Value root;
        for (auto& [k, v] : breakdown) root[k] = static_cast<Json::UInt64>(v);
        cb(jsonResp(root));
    }

    void health(const drogon::HttpRequestPtr& /*req*/, std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
        Json::Value root;
        root["status"]  = "ok";
        root["service"] = "threatscope-backend";
        cb(jsonResp(root));
    }

private:
    static drogon::HttpResponsePtr jsonResp(const Json::Value& v) {
        Json::FastWriter fw;
        auto resp = drogon::HttpResponse::newHttpResponse();
        resp->setStatusCode(drogon::k200OK);
        resp->setContentTypeCode(drogon::CT_APPLICATION_JSON);
        resp->setBody(fw.write(v));
        resp->addHeader("Access-Control-Allow-Origin", "*");
        return resp;
    }
};
