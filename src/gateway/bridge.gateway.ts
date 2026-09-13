import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import { CentralManagerService } from '../central/central-manager.service';
import { BridgeTokenVerifier } from '../auth/bridge-token.verifier';
import { DriveSessionService } from '../drive-session/drive-session.service';
import { BlockSessionService } from '../block-session/block-session.service';

const ESTOP_GRACE_MS           = 8_000;
const AUTH_TIMEOUT_MS          = 5_000;
const SESSION_CLEANUP_MS       = 30 * 60 * 1_000; // 30 min

@WebSocketGateway({ path: '/ws' })
export class BridgeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(BridgeGateway.name);
  private readonly authenticatedClients = new Set<WebSocket>();
  private readonly pendingAuth = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  private eStopTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionCleanupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly centralManager: CentralManagerService,
    private readonly verifier: BridgeTokenVerifier,
    private readonly driveSession: DriveSessionService,
    private readonly blockSession: BlockSessionService,
  ) {}

  afterInit(): void {
    this.centralManager.statusChange$.subscribe((centrals) => {
      const msg = JSON.stringify({ type: 'central-status', centrals });
      this.broadcast(msg);
    });

    // Sync track power state from the Z21 hardware into the session.
    // driveSession.change$ will then broadcast it to all WS clients.
    // When power goes off, S88 detection becomes unreliable — reset all block states.
    this.centralManager.trackPower$.subscribe((on) => {
      this.driveSession.setTrackPower(on);
      if (!on) this.blockSession.resetStates();
    });

    let prevInfraId: string | null = null;
    this.driveSession.change$.subscribe((session) => {
      const msg = JSON.stringify({ type: 'session-status', session });
      this.broadcast(msg);
      // Only clear blocks when the session transitions to no-infra (not on every null-infraId event)
      if (prevInfraId !== null && session.infraId === null) {
        this.blockSession.clearBlocks();
      }
      prevInfraId = session.infraId;
    });

    this.centralManager.occupancy$.subscribe((update) => {
      this.blockSession.processOccupancy(update);
    });

    this.blockSession.change$.subscribe((blocks) => {
      this.broadcast(JSON.stringify({ type: 'block-status', blocks }));
    });

    // Session cleanup: end session 30 min after all centrals disconnect with an active session.
    this.centralManager.statusChange$.subscribe((centrals) => {
      const allGone = centrals.every(c => c.status !== 'connected');
      const hasSession = this.driveSession.getSession().infraId !== null;

      if (allGone && hasSession) {
        if (!this.sessionCleanupTimer) {
          this.logger.warn(`All centrals disconnected (session active) — cleanup in ${SESSION_CLEANUP_MS / 60_000} min.`);
          this.sessionCleanupTimer = setTimeout(() => {
            this.sessionCleanupTimer = null;
            this.driveSession.endSession();
            this.broadcastSessionEnded('central-disconnected');
            this.logger.warn('Session cleanup: grace elapsed → session ended.');
          }, SESSION_CLEANUP_MS);
        }
      } else if (!allGone && this.sessionCleanupTimer) {
        clearTimeout(this.sessionCleanupTimer);
        this.sessionCleanupTimer = null;
        this.logger.log('Central reconnected — session cleanup timer cancelled.');
      }
    });
  }

  private broadcastSessionEnded(reason: string): void {
    this.broadcast(JSON.stringify({ type: 'session-ended', reason }));
  }

  private broadcast(msg: string): void {
    this.authenticatedClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
  }

  handleConnection(client: WebSocket, _req: IncomingMessage): void {
    // Token is NOT read from the URL — the client must send { type: "auth", token } as its
    // first message. This keeps the JWT out of URLs and server logs.
    // G1: named function so the timer can remove it via client.off() — prevents a
    // message buffered just before timeout from racing into authenticatedClients.
    const onAuthMessage = (data: RawData) => {
      const timer = this.pendingAuth.get(client);
      if (timer) { clearTimeout(timer); this.pendingAuth.delete(client); }

      // G1: guard against socket already closing (race with timer expiry)
      if (client.readyState !== WebSocket.OPEN) return;

      // G4: RawData can be Buffer | ArrayBuffer | Buffer[] — normalise to Buffer
      const raw = Buffer.isBuffer(data) ? data
        : Array.isArray(data)           ? Buffer.concat(data)
        :                                 Buffer.from(data);

      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; token?: string };
        if (msg.type !== 'auth' || typeof msg.token !== 'string') {
          client.close(4401, 'Expected auth message');
          return;
        }
        this.verifier.verify(msg.token);
      } catch {
        this.logger.warn('WebSocket auth failed — closing connection.');
        client.close(4401, 'Unauthorized');
        return;
      }

      this.authenticatedClients.add(client);

      // Cancel any pending E-STOP — a client reconnected in time
      if (this.eStopTimer) {
        clearTimeout(this.eStopTimer);
        this.eStopTimer = null;
        this.logger.log('Client reconnected — E-STOP cancelled.');
      }

      client.send(JSON.stringify({ type: 'central-status', centrals: this.centralManager.getAll() }));
      client.send(JSON.stringify({ type: 'session-status', session: this.driveSession.getSession() }));
      client.send(JSON.stringify({ type: 'block-status', blocks: this.blockSession.getStates() }));
    };

    client.once('message', onAuthMessage);

    const authTimer = setTimeout(() => {
      client.off('message', onAuthMessage); // G1: prevent race with buffered message
      this.pendingAuth.delete(client);
      if (!this.authenticatedClients.has(client)) {
        this.logger.warn('WebSocket auth timeout — closing connection.'); // G3
        client.close(4401, 'Auth timeout');
      }
    }, AUTH_TIMEOUT_MS);

    this.pendingAuth.set(client, authTimer);
  }

  handleDisconnect(client: WebSocket): void {
    const timer = this.pendingAuth.get(client);
    if (timer) { clearTimeout(timer); this.pendingAuth.delete(client); }

    const wasAuthenticated = this.authenticatedClients.delete(client);

    if (wasAuthenticated && this.authenticatedClients.size === 0 && this.eStopTimer === null) {
      this.logger.warn(`All PWA clients disconnected — E-STOP in ${ESTOP_GRACE_MS}ms if no reconnection.`);
      this.eStopTimer = setTimeout(() => {
        this.eStopTimer = null;
        this.logger.warn('Grace period elapsed — sending E-STOP to all centrals.');
        void this.centralManager.emergencyStopAll();
      }, ESTOP_GRACE_MS);
    }
  }
}
