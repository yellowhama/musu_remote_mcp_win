import { channel } from "node:diagnostics_channel";
import { statfs } from "node:fs/promises";

import type { AppConfig } from "./config.js";
import type { McpServices } from "./mcp-server.js";

const LATENCY_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

interface TelemetryEvent {
  type?: unknown;
  outcome?: unknown;
  durationMs?: unknown;
  totalBytes?: unknown;
  pending?: unknown;
}

function labels(values: Record<string, string>): string {
  return `{${Object.entries(values).map(([key, value]) => `${key}="${value}"`).join(",")}}`;
}

export class MetricsRegistry {
  private readonly telemetryChannel = channel("musu.remote-mcp.telemetry");
  private readonly telemetryListener = (message: unknown) => {
    this.recordTelemetry(message as TelemetryEvent);
  };
  private readonly httpCounts = new Map<string, number>();
  private readonly authRejections = new Map<string, number>();
  private readonly latencyCounts = new Map<number, number>(LATENCY_BUCKETS.map((bucket) => [bucket, 0]));
  private latencyCount = 0;
  private latencySum = 0;
  private checkpointSuccess = 0;
  private checkpointFailure = 0;
  private checkpointBytes = 0;
  private checkpointDurationSeconds = 0;
  private mutationQueuePending = 0;

  constructor() {
    this.telemetryChannel.subscribe(this.telemetryListener);
  }

  close(): void {
    this.telemetryChannel.unsubscribe(this.telemetryListener);
  }

  observeHttp(route: string, status: number, durationMs: number): void {
    const statusClass = `${Math.floor(status / 100)}xx`;
    const key = `${route}|${statusClass}`;
    this.httpCounts.set(key, (this.httpCounts.get(key) ?? 0) + 1);
    const seconds = Math.max(0, durationMs / 1000);
    this.latencyCount += 1;
    this.latencySum += seconds;
    for (const bucket of LATENCY_BUCKETS) {
      if (seconds <= bucket) this.latencyCounts.set(bucket, (this.latencyCounts.get(bucket) ?? 0) + 1);
    }
  }

  rejectAuth(reason: "bearer" | "host" | "origin"): void {
    this.authRejections.set(reason, (this.authRejections.get(reason) ?? 0) + 1);
  }

  private recordTelemetry(event: TelemetryEvent): void {
    if (event.type === "checkpoint") {
      if (event.outcome === "success") this.checkpointSuccess += 1;
      else if (event.outcome === "failure") this.checkpointFailure += 1;
      if (typeof event.totalBytes === "number" && Number.isFinite(event.totalBytes)) {
        this.checkpointBytes += Math.max(0, event.totalBytes);
      }
      if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs)) {
        this.checkpointDurationSeconds += Math.max(0, event.durationMs / 1000);
      }
    } else if (event.type === "mutation_queue" && typeof event.pending === "number") {
      this.mutationQueuePending = Math.max(0, Math.floor(event.pending));
    }
  }

  async render(config: AppConfig, services: McpServices): Promise<string> {
    const lines = [
      "# HELP musu_http_requests_total Completed HTTP requests by bounded route and status class.",
      "# TYPE musu_http_requests_total counter",
    ];
    for (const [key, value] of [...this.httpCounts].sort()) {
      const [route, statusClass] = key.split("|") as [string, string];
      lines.push(`musu_http_requests_total${labels({ route, status_class: statusClass })} ${value}`);
    }
    lines.push(
      "# HELP musu_http_request_duration_seconds HTTP request duration.",
      "# TYPE musu_http_request_duration_seconds histogram",
    );
    for (const bucket of LATENCY_BUCKETS) {
      lines.push(`musu_http_request_duration_seconds_bucket{le="${bucket}"} ${this.latencyCounts.get(bucket) ?? 0}`);
    }
    lines.push(`musu_http_request_duration_seconds_bucket{le="+Inf"} ${this.latencyCount}`);
    lines.push(`musu_http_request_duration_seconds_sum ${this.latencySum}`);
    lines.push(`musu_http_request_duration_seconds_count ${this.latencyCount}`);
    lines.push("# HELP musu_auth_rejections_total Authentication boundary rejections.", "# TYPE musu_auth_rejections_total counter");
    for (const reason of ["bearer", "host", "origin"] as const) {
      lines.push(`musu_auth_rejections_total${labels({ reason })} ${this.authRejections.get(reason) ?? 0}`);
    }
    const processes = services.processManager.list();
    lines.push("# HELP musu_managed_processes Managed process sessions.", "# TYPE musu_managed_processes gauge");
    lines.push(`musu_managed_processes${labels({ state: "running" })} ${processes.filter((item) => item.running).length}`);
    lines.push(`musu_managed_processes${labels({ state: "retained" })} ${processes.filter((item) => !item.running).length}`);
    lines.push("# HELP musu_mutation_queue_pending Mutations waiting or executing.", "# TYPE musu_mutation_queue_pending gauge", `musu_mutation_queue_pending ${this.mutationQueuePending}`);
    lines.push("# HELP musu_checkpoints_total Checkpoint attempts.", "# TYPE musu_checkpoints_total counter");
    lines.push(`musu_checkpoints_total${labels({ outcome: "success" })} ${this.checkpointSuccess}`);
    lines.push(`musu_checkpoints_total${labels({ outcome: "failure" })} ${this.checkpointFailure}`);
    lines.push("# HELP musu_checkpoint_bytes_total Source bytes protected by successful checkpoints.", "# TYPE musu_checkpoint_bytes_total counter", `musu_checkpoint_bytes_total ${this.checkpointBytes}`);
    lines.push("# HELP musu_checkpoint_duration_seconds_total Cumulative checkpoint duration.", "# TYPE musu_checkpoint_duration_seconds_total counter", `musu_checkpoint_duration_seconds_total ${this.checkpointDurationSeconds}`);
    try {
      const disk = await statfs(config.defaultCwd);
      lines.push("# HELP musu_workspace_disk_free_bytes Free bytes on the workspace volume.", "# TYPE musu_workspace_disk_free_bytes gauge", `musu_workspace_disk_free_bytes ${disk.bavail * disk.bsize}`);
    } catch {
      lines.push("# HELP musu_workspace_disk_probe_success Whether workspace free-space collection succeeded.", "# TYPE musu_workspace_disk_probe_success gauge", "musu_workspace_disk_probe_success 0");
    }
    return `${lines.join("\n")}\n`;
  }
}

export function metricRoute(pathname: string, endpoint: string): string {
  if (pathname === endpoint) return "mcp";
  if (pathname === "/health") return "health";
  if (pathname === "/metrics") return "metrics";
  if (pathname.startsWith("/.well-known/")) return "discovery";
  if (["/authorize", "/token", "/register", "/revoke"].includes(pathname)) return "oauth";
  return "other";
}
