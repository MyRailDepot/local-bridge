export interface CentralConfig {
  id: string;
  name: string;
  type: string;
  network: { host: string; port: number };
}

export type CentralStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface CentralConnectionStatus {
  id: string;
  name: string;
  type: string;
  status: CentralStatus;
}

/**
 * Why a drive command reached no command station.
 * - NO_CENTRAL: no station is connected.
 * - CENTRAL_SEND_FAILED: sending failed on every connected station.
 * - ESTOP_UNCONFIRMED: the e-stop was sent but no station broadcast LAN_X_BC_STOPPED in time.
 */
export type CentralCommandErrorCode = 'NO_CENTRAL' | 'CENTRAL_SEND_FAILED' | 'ESTOP_UNCONFIRMED';

export class CentralCommandError extends Error {
  constructor(readonly code: CentralCommandErrorCode, message: string) {
    super(message);
    this.name = 'CentralCommandError';
  }
}

/** Thrown by a station client when its e-stop confirmation does not arrive in time. */
export class EstopUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EstopUnconfirmedError';
  }
}
