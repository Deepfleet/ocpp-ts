/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/quotes */
import EventEmitter from 'events';
import WebSocket, { WebSocketServer } from 'ws';
import { SecureContextOptions } from 'tls';
import { createServer as createHttpsServer } from 'https';
import { createServer as createHttpServer, IncomingMessage } from 'http';
import stream from 'node:stream';
import { OCPP_PROTOCOL_1_6 } from './schemas';
import { Client } from './Client';
import { OcppClientConnection } from '../OcppClientConnection';
import { Protocol } from './Protocol';
import { ServerOptions } from './ServerOptions';

export class Server extends EventEmitter {
  private server: WebSocket.Server | null = null;

  private clients: Array<Client> = [];

  private options: ServerOptions;

  private DEFAULT_PING_INTERVEL = 30000;

  private isDebug = process.env.ENV === 'dev';

  constructor(options: ServerOptions) {
    super();
    this.options = options;
  }

  protected listen(port = 9220, options?: SecureContextOptions) {
    let server;
    if (options) {
      server = createHttpsServer(options || {});
    } else {
      server = createHttpServer();
    }

    const wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols: Set<string>) => {
        if (protocols.has(OCPP_PROTOCOL_1_6)) {
          return OCPP_PROTOCOL_1_6;
        }
        return false;
      },
    });

    wss.on('wsClientError', (err, request) => {
      console.error(`Error ->wsClientError from ${request.url}`);
      console.error(err);
    });
    wss.on('error', (err) => {
      console.error('Error ->error');
      console.error(err);
    });
    wss.on('headers', (headers) => {
      console.error('headers ->headers');
      console.error(JSON.stringify(headers));
    });

    wss.on('connection', (ws, req) => this.onNewConnection(ws, req));

    server.on('upgrade', (req: IncomingMessage, socket: stream.Duplex, head: Buffer) => {
      const cpId = Server.getCpIdFromUrl(req.url);
      if (!cpId) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
      } else if (this.listenerCount('authorization')) {
        this.emit('authorization', cpId, req, (err?: Error) => {
          if (err) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
          } else {
            wss.handleUpgrade(req, socket, head, (ws) => {
              wss.emit('connection', ws, req);
            });
          }
        });
      } else {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      }
    });

    server.listen(port);
  }

  private onNewConnection(socket: WebSocket, req: IncomingMessage) {
    console.log(`Connection recevied from ${req.url}`);
    const cpId = Server.getCpIdFromUrl(req.url);
    if (!socket.protocol || !cpId) {
      // From Spec: If the Central System does not agree to using one of the subprotocols offered
      // by the client, it MUST complete the WebSocket handshake with a response without a
      // Sec-WebSocket-Protocol header and then immediately close the WebSocket connection.
      console.info('Closed connection due to unsupported protocol');
      socket.close();
      return;
    }

    const client = new OcppClientConnection(cpId);
    client.setConnection(new Protocol(client, socket));

    let isAlive = true;
    socket.on('pong', () => {
      if (this.isDebug) {
        console.error('Recevied a pong');
      }
      isAlive = true;
    });
    const pingInterval = setInterval(() => {
      if (isAlive === false) {
        socket.terminate();
        return;
      }
      isAlive = false;
      if (socket.readyState < WebSocket.CLOSING) {
        socket.ping(() => {
          if (this.isDebug) {
            console.error('Send Ping');
          }
        });
      }
    }, this.options.pingInterval ?? this.DEFAULT_PING_INTERVEL);
    socket.on('error', (err) => {
      console.info(err.message, socket.readyState);
      client.emit('error', err);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      const index = this.clients.indexOf(client);
      this.clients.splice(index, 1);
      console.error('Websocket is closed and clearing pingpong task');
      clearInterval(pingInterval);
      client.emit('close', code, reason);
      // this.emit('close', client, code, reason);
    });
    this.clients.push(client);
    this.emit('connection', client);
  }

  static getCpIdFromUrl(url: string | undefined): string | undefined {
    try {
      if (url) {
        const encodedCpId = url.split('/').pop();
        if (encodedCpId) {
          return decodeURI(encodedCpId.split('?')[0]);
        }
      }
    } catch (e) {
      console.error(e);
    }
    return undefined;
  }
}
