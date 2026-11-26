// Privileged (host-side) handlers for アバター総合管理.
//
// CR-24: the キャラチャット auto-sync needs to know whether this
// environment contains an app to reflect profiles INTO. That must not
// depend on any environment-specific value (a fixed slug, space id, or
// app name baked into this artifact): the destination is discovered by
// FUNCTION, following the receiver-side interop contract —
//   primary: an app that publishes the self-introduction action
//     (getAvatarReceiverInfo). Whether it truly is a receiver is
//     decided by that action's RESPONSE (protocol
//     "avatar-profile-receiver", protocol_version 1); the mediator
//     performs that handshake check immediately before pushing, so
//     this scan only has to find the candidates.
//   fallback (older receivers without the self-introduction): an app
//     that publishes all of the import interface actions
//     (importCharactersBulk / getImportStates / getImportStatus).
// Neither judgment uses a slug or app id. The sandboxed action worker
// cannot read the host filesystem, so the scan lives here; actions
// reach it through ctx.executePrivileged and fall back to "not
// available" on any error, so a failed scan never breaks saving or
// any other feature.

import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const privileged = definePrivilegedContracts({
  findProfileImportTarget: {
    request: z.object({
      // The calling space's own slug (runtime-provided), excluded from
      // the scan so an app never "discovers" itself.
      self_slug: z.string().min(1).max(200),
      // The self-introduction action name (primary discovery method).
      handshake_action: z.string().min(1).max(100),
      // Action names a legacy receiver must ALL publish to qualify
      // under the fallback method.
      required_actions: z.array(z.string().min(1).max(100)).min(1).max(20),
    }),
    response: z.object({
      found: z.boolean(),
      // The discovered space's slug / display name, read from its own
      // space.json at scan time (never a constant of this artifact).
      slug: z.string().nullable(),
      name: z.string().nullable(),
      // Which contract method matched: "handshake" (publishes the
      // self-introduction action; its response is verified by the
      // mediator before pushing) or "legacy" (publishes the import
      // interface actions only).
      method: z.enum(["handshake", "legacy"]).nullable(),
    }),
  },
});

// Action names a space's server entry defines, extracted from its
// `name: defineAction(...)` entries. Presence in the source is the
// functional signature the discovery matches on.
function extractDefinedActions(source: string): Set<string> {
  const defined = new Set<string>();
  const re = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*defineAction\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = m[1];
    if (name) defined.add(name);
  }
  return defined;
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async findProfileImportTarget(args) {
    // Current spaces live under ts-spaces; legacy ones under spaces.
    const roots = [
      join(homedir(), "workspace", "ts-spaces"),
      join(homedir(), "workspace", "spaces"),
    ];
    let legacy: { slug: string; name: string | null } | null = null;
    for (const root of roots) {
      let entries: string[] = [];
      try {
        const dirents = await readdir(root, { withFileTypes: true });
        entries = dirents
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort();
      } catch {
        continue;
      }
      for (const entry of entries) {
        const dir = join(root, entry);
        let slug = entry;
        let name: string | null = null;
        try {
          const meta = JSON.parse(
            await readFile(join(dir, "space.json"), "utf8"),
          ) as Record<string, unknown>;
          if (typeof meta.slug === "string" && meta.slug) slug = meta.slug;
          if (typeof meta.name === "string" && meta.name) name = meta.name;
        } catch {
          continue;
        }
        if (slug === args.self_slug) continue;
        let source = "";
        try {
          source = await readFile(
            join(dir, "server", "src", "actions.ts"),
            "utf8",
          );
        } catch {
          continue;
        }
        const defined = extractDefinedActions(source);
        // Primary method wins immediately: a self-introduction action
        // marks a current receiver.
        if (defined.has(args.handshake_action)) {
          return { found: true, slug, name, method: "handshake" as const };
        }
        // Fallback: remember the first legacy receiver, but keep
        // scanning — a handshake receiver anywhere outranks it.
        if (
          !legacy &&
          args.required_actions.every((a) => defined.has(a))
        ) {
          legacy = { slug, name };
        }
      }
    }
    if (legacy) {
      return {
        found: true,
        slug: legacy.slug,
        name: legacy.name,
        method: "legacy" as const,
      };
    }
    return { found: false, slug: null, name: null, method: null };
  },
});
