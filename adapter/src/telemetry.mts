import { channel } from 'node:diagnostics_channel';

const telemetryChannel = channel('musu.remote-mcp.telemetry');

export function emitTelemetry(event: Record<string, unknown>): void {
  telemetryChannel.publish(event);
}
