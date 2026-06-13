/**
 * WebSocket client for real-time comment syncing with the FCT backend.
 * Auto-reconnects with exponential backoff.
 */

import * as vscode from 'vscode';
import WebSocket from 'ws';
import { WSMessage } from './types';

export type WSMessageHandler = (message: WSMessage) => void;

export class FCTWebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private repoId: string;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private isDisposed = false;
  private messageHandlers: WSMessageHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(backendUrl: string, repoId: string) {
    // Convert http(s) to ws(s)
    this.url = backendUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:')
      .replace(/\/+$/, '') + `/ws?repo=${encodeURIComponent(repoId)}`;
    this.repoId = repoId;
  }

  /**
   * Register a handler for incoming WebSocket messages.
   */
  onMessage(handler: WSMessageHandler): vscode.Disposable {
    this.messageHandlers.push(handler);
    return {
      dispose: () => {
        const idx = this.messageHandlers.indexOf(handler);
        if (idx >= 0) {
          this.messageHandlers.splice(idx, 1);
        }
      },
    };
  }

  /**
   * Connect to the backend WebSocket.
   */
  connect(): void {
    if (this.isDisposed) { return; }

    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        console.log('[FCT] WebSocket connected');
        this.reconnectDelay = 1000; // Reset backoff
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message: WSMessage = JSON.parse(data.toString());
          for (const handler of this.messageHandlers) {
            handler(message);
          }
        } catch (error) {
          console.warn('[FCT] Failed to parse WebSocket message:', error);
        }
      });

      this.ws.on('close', () => {
        console.log('[FCT] WebSocket disconnected');
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        console.warn('[FCT] WebSocket error:', error.message);
        // 'close' event will follow, triggering reconnect
      });
    } catch (error) {
      console.warn('[FCT] Failed to create WebSocket:', error);
      this.scheduleReconnect();
    }
  }

  /**
   * Send a message to the backend.
   */
  private send(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.isDisposed) { return; }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      console.log(`[FCT] Reconnecting in ${this.reconnectDelay}ms...`);
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff with jitter
    this.reconnectDelay = Math.min(
      this.maxReconnectDelay,
      this.reconnectDelay * 2 + Math.random() * 1000
    );
  }

  /**
   * Disconnect and clean up.
   */
  dispose(): void {
    this.isDisposed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.messageHandlers = [];
  }
}
