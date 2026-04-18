#pragma once
#include <drogon/WebSocketController.h>
#include <drogon/drogon.h>
#include <set>
#include <mutex>
#include <string>

class AttackStreamWS
    : public drogon::WebSocketController<AttackStreamWS>
{
public:
    void handleNewConnection(
        const drogon::HttpRequestPtr&         /*req*/,
        const drogon::WebSocketConnectionPtr& conn) override
    {
        conn->setContext(std::make_shared<ClientCtx>());
        { std::lock_guard<std::mutex> lk(mx_); clients_.insert(conn); }
        LOG_INFO << "[WS] Client connected: " << conn->peerAddr().toIpPort()
                 << "  total=" << clientCount();
        conn->send(R"({"type":"connected","msg":"ThreatScope stream active"})");
    }

    void handleConnectionClosed(
        const drogon::WebSocketConnectionPtr& conn) override
    {
        { std::lock_guard<std::mutex> lk(mx_); clients_.erase(conn); }
        LOG_INFO << "[WS] Client disconnected. total=" << clientCount();
    }

    void handleNewMessage(
        const drogon::WebSocketConnectionPtr& /*conn*/,
        std::string&&                          msg,
        const drogon::WebSocketMessageType&    type) override
    {
        if (type == drogon::WebSocketMessageType::Text)
            LOG_DEBUG << "[WS] Client msg: " << msg;
    }

    static void broadcast(const std::string& json) {
        std::lock_guard<std::mutex> lk(mx_);
        for (auto& c : clients_)
            if (c->connected()) c->send(json);
    }

    static size_t clientCount() {
        std::lock_guard<std::mutex> lk(mx_);
        return clients_.size();
    }

    WS_PATH_LIST_BEGIN
    WS_PATH_ADD("/ws/attacks", drogon::Get);
    WS_PATH_LIST_END

private:
    struct ClientCtx {};
    static inline std::set<drogon::WebSocketConnectionPtr> clients_;
    static inline std::mutex                               mx_;
};
