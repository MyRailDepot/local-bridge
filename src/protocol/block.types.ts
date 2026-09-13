/**
 * A connection from one side of a block to a neighbouring block.
 * When `viaAccessoryId` is absent the connection is unconditional.
 * When present, `accessoryPosition` must also be set.
 */
export type BlockConnection =
  | {
      toBlockId: string;
      toSide: 'A' | 'B';
      viaAccessoryId?: never;
      accessoryPosition?: never;
    }
  | {
      toBlockId: string;
      toSide: 'A' | 'B';
      viaAccessoryId: string;
      accessoryPosition: 'straight' | 'deviated';
    };

/**
 * Which Z21 feedback bus a block's occupancy detector sits on.
 * 'rbus'    — Roco R-BUS / S88 (module 1–20, channel 1–8)
 * 'loconet' — LocoNet occupancy detector (report address, channel always 0)
 * 'can'     — Z21 CAN detector (module address, port/channel 0–7)
 */
export type FeedbackBus = 'rbus' | 'loconet' | 'can';

/**
 * A track section (block) — the bridge↔cloud protocol shape. Occupation
 * state is NOT part of this shape — it lives in BlockState, ephemeral,
 * never persisted.
 *
 * feedbackBus:     Which Z21 feedback bus the detector is wired to.
 * feedbackModule:  Module / report address on that bus, as reported by the
 *                  z21-client 'occupancy' event (channel.address).
 * feedbackChannel: Channel / input on that module (channel.channel).
 *                  R-BUS: 1–8. LocoNet: 0. CAN: 0–7.
 *
 * sideA / sideB represent the two physical ends of the section.
 * A train entering from sideA exits from sideB and vice versa.
 * The labels A/B are direction-neutral; the UI may display custom labels.
 */
export interface Block {
  id: string;
  workspaceId: string;
  infraId: string;
  name: string;
  feedbackBus: FeedbackBus;
  feedbackModule: number;
  feedbackChannel: number;
  sideA: BlockConnection[];
  sideB: BlockConnection[];
  createdDate: string;
  updatedDate?: string;
}

/**
 * Ephemeral occupation state for a block, held in bridge memory only.
 * Never persisted to Firestore. Broadcast to PWA clients via WebSocket.
 */
export interface BlockState {
  blockId: string;
  occupied: boolean;
}
