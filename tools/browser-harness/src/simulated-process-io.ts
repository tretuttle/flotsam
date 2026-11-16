import type { ProcessIo } from "./owned-process.ts";
import {
  redeemOrder,
  type HarnessSelf,
  type ProcessIdentity,
  type StopSignal,
} from "./signal-policy.ts";

// A process table that tests drive with fixed data. Its `perform` redeems each order exactly as
// the host performer does, then applies the signal to the table instead of the system.

export const HARNESS: HarnessSelf = { pid: 2000, parentPid: 1800, pgrp: 1900 };

export function processIdentity(
  pid: number,
  fields: {
    readonly parentPid?: number;
    readonly pgrp?: number | null;
    readonly startTime?: string;
    readonly args?: readonly string[];
  } = {},
): ProcessIdentity {
  const args = fields.args ?? [`/opt/proc-${String(pid)}`];
  return {
    pid,
    parentPid: fields.parentPid ?? 1,
    pgrp: fields.pgrp === undefined ? pid : fields.pgrp,
    startTime: fields.startTime ?? String(pid * 10),
    args,
    commandLine: args.join(" "),
  };
}

const HOST_BACKGROUND: readonly ProcessIdentity[] = [
  processIdentity(1, { parentPid: 0, args: ["/sbin/init"] }),
  processIdentity(1800, { pgrp: 1800, args: ["/bin/sh"] }),
  processIdentity(2000, { parentPid: 1800, pgrp: 1900, args: ["node", "harness"] }),
];

export type SentSignal = {
  readonly rawTarget: number;
  readonly signal: StopSignal;
  readonly at: number;
};

export type SimulatedProcesses = {
  readonly io: ProcessIo;
  readonly sent: SentSignal[];
  readonly running: (pid: number) => boolean;
};

export function simulateProcesses(
  processes: readonly ProcessIdentity[],
  options: {
    readonly survives?: Readonly<Record<number, "SIGTERM" | "everything">>;
    readonly groupSignals?: boolean;
  } = {},
): SimulatedProcesses {
  const live = new Map<number, ProcessIdentity>();
  for (const identity of [...HOST_BACKGROUND, ...processes]) live.set(identity.pid, identity);
  const sent: SentSignal[] = [];
  let clock = 0;
  const io: ProcessIo = {
    groupSignals: options.groupSignals ?? true,
    self: () => HARNESS,
    table: () => new Map(live),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    perform: (order) => {
      const { rawTarget, signal } = redeemOrder(order);
      sent.push({ rawTarget, signal, at: clock });
      const targets =
        rawTarget < 0
          ? [...live.values()].filter((identity) => identity.pgrp === -rawTarget)
          : [live.get(rawTarget)].filter((identity) => identity !== undefined);
      for (const target of targets) {
        const survives = options.survives?.[target.pid];
        if (survives === "everything" || (survives === "SIGTERM" && signal === "SIGTERM")) continue;
        live.delete(target.pid);
      }
      return targets.length > 0;
    },
  };
  return { io, sent, running: (pid) => live.has(pid) };
}
