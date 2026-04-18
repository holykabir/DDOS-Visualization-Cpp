/**
 * websocket-client.js — WebSocket client with auto-reconnect
 */
export class WSClient {
  constructor(url, { onMessage, onConnect, onDisconnect, onError } = {}) {
    this.url          = url;
    this.onMessage    = onMessage;
    this.onConnect    = onConnect;
    this.onDisconnect = onDisconnect;
    this.onError      = onError;

    this.ws           = null;
    this.connected    = false;
    this._retryTimer  = null;
    this._retries     = 0;
    this._maxRetries  = 3;

    this._connect();
  }

  _connect() {
    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.connected  = true;
        this._retries   = 0;
        this.onConnect?.();
      };

      this.ws.onmessage = (e) => {
        this.onMessage?.(e.data);
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.onDisconnect?.();
        if (this._retries < this._maxRetries) {
          this._retries++;
          this._retryTimer = setTimeout(() => this._connect(), 4000);
        }
      };

      this.ws.onerror = () => {
        this.onError?.();
        this.ws?.close();
      };
    } catch {
      this.onError?.();
    }
  }

  send(data) {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }

  disconnect() {
    clearTimeout(this._retryTimer);
    this._maxRetries = 0;   // prevent reconnect
    this.ws?.close();
  }
}
