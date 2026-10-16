// Loading the background documents a debate reasons over.
//
// Lives apart from index.ts for a concrete reason: index.ts is the CLI entry point and
// runs `main()` at module scope, so importing anything from it would execute the whole
// program. A test that wants to check the `role:path` parsing has to be able to import
// just that.

import { readFile } from "node:fs/promises";
import type { Material } from "./debate.ts";
import { injectionNotice, redactSecrets, scanInjection } from "./sanitize.ts";

/** Progress sink, so this module never has to know how the caller prints things. */
export type MaterialReport = { warn?: (msg: string) => void; info?: (msg: string) => void };

/**
 * Load background material: a local file, or a URL fetched as text.
 *
 * Everything loaded here is UNTRUSTED and is about to be shipped to two or three
 * different vendors, so it passes two guards first: credentials are redacted, and
 * injection attempts are reported to the user and flagged to the agents. See
 * src/sanitize.ts for why one of those edits and the other only warns.
 */
export async function loadMaterial(
  refs: string[],
  knownRoles: Set<string>,
  report: MaterialReport = {},
): Promise<Material | undefined> {
  if (refs.length === 0) return undefined;
  const shared: string[] = [];
  const byRole: Record<string, string[]> = {};
  const sources: Record<string, string[]> = {};

  for (const rawRef of refs) {
    const { role, ref } = splitMaterialRef(rawRef, knownRoles);
    let raw: string;
    let heading: string;
    if (/^https?:\/\//i.test(ref)) {
      heading = `### Nguồn: ${ref}`;
      try {
        const res = await fetch(ref, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = (await res.text()).slice(0, 100_000);
      } catch (e) {
        // Material is context, not the task: note the gap and carry on rather than
        // killing a run that may not even need this source.
        report.warn?.(`không tải được ${ref}: ${(e as Error).message}`);
        raw = `(không tải được: ${(e as Error).message})`;
      }
    } else {
      heading = `### Tư liệu: ${ref}`;
      raw = await readFile(ref, "utf8");
    }

    const { text, redactions } = redactSecrets(raw);
    if (redactions.length) {
      const what = redactions.map((r) => `${r.kind}×${r.count}`).join(", ");
      report.warn?.(`đã che thông tin bí mật trong ${ref}: ${what} (không gửi ra ngoài)`);
    }

    const hits = scanInjection(text);
    if (hits.length) {
      report.warn?.(`${ref} có ${hits.length} dấu hiệu prompt-injection — đã cảnh báo cho các agent, giữ nguyên nội dung:`);
      for (const h of hits.slice(0, 5)) report.info?.(`  dòng ${h.line} [${h.kind}]: ${h.excerpt}`);
    }

    const block = `${heading}\n\n${text}${injectionNotice(hits)}`;
    if (role) {
      (byRole[role] ??= []).push(block);
      (sources[role] ??= []).push(ref);
      report.info?.(`tư liệu riêng → ${role}: ${ref}`);
    } else {
      shared.push(block);
    }
  }

  return {
    ...(shared.length && { shared: shared.join("\n\n") }),
    ...(Object.keys(byRole).length && {
      byRole: Object.fromEntries(Object.entries(byRole).map(([k, v]) => [k, v.join("\n\n")])),
      sources,
    }),
  };
}

/**
 * Split `-m researcher:./file.md` into role + path.
 *
 * The prefix only counts when it names a role that is actually in this debate. That is
 * what keeps `-m https://example.com/x` and `-m C:\\docs\\spec.md` working: "https" and
 * "c" are not roles, so the whole string stays a path. Guessing from the colon alone
 * would quietly turn every URL into a half-parsed role reference.
 */
export function splitMaterialRef(raw: string, knownRoles: Set<string>): { role?: string; ref: string } {
  const m = raw.match(/^([A-Za-z0-9][A-Za-z0-9_-]*):(.+)$/);
  if (m && knownRoles.has(m[1].toLowerCase())) return { role: m[1].toLowerCase(), ref: m[2] };
  return { ref: raw };
}
