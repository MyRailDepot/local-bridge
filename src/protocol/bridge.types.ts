export interface BridgeTokenPayload {
  sub:         string;
  workspaceId: string;
  bridgeId:    string;
  permissions: string[];
  exp:         number;
}
