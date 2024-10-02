import { validateMessage } from "../shared/message.js";
import { Transport } from "../shared/transport.js";
import { JSONRPCMessage } from "../types.js";

const SUBPROTOCOL = "mcp";

/**
 * Client transport for WebSocket: this will connect to a server over the WebSocket protocol.
 */
export class WebSocketClientTransport implements Transport {
  private _socket?: WebSocket;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  connect(url: URL): Promise<void> {
    return new Promise((resolve, reject) => {
      this._socket = new WebSocket(url, SUBPROTOCOL);

      this._socket.onerror = (event) => {
        const error =
          "error" in event
            ? (event.error as Error)
            : new Error(`WebSocket error: ${JSON.stringify(event)}`);
        reject(error);
        this.onerror?.(error);
      };

      this._socket.onopen = () => {
        resolve();
      };

      this._socket.onclose = () => {
        this.onclose?.();
      };

      this._socket.onmessage = (event: MessageEvent) => {
        let message: JSONRPCMessage;
        try {
          message = JSON.parse(event.data);
          validateMessage(message);
        } catch (error) {
          this.onerror?.(error as Error);
          return;
        }

        this.onmessage?.(message);
      };
    });
  }

  async close(): Promise<void> {
    this._socket?.close();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this._socket) {
        reject(new Error("Not connected"));
        return;
      }

      this._socket?.send(JSON.stringify(message));
      resolve();
    });
  }
}
