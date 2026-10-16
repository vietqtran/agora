// Casting: bind roles to the runtimes this machine actually has.
//
// This is the module the whole tool exists for. The brief was: "on my server, if
// claude is there use claude, if codex is there use codex, use whatever is there" —
// so a lineup is a RESULT, not a precondition. The rules, in order of importance:
//
//   1. A role states a preference; the caster obeys reality. An unavailable favourite
//      silently steps down the preference list.
//   2. DIVERSITY FIRST. A debate between two personas on the same runtime is a model
//      talking to itself — the disagreement that makes this worth doing comes from
//      different vendors. So a provider is used for a second role only after every
//      other eligible provider is taken.
//   3. DEGRADE, NEVER ABORT. One CLI installed still yields a real multi-persona
//      debate; it just gets labelled `shared` and warned about, so the user can read
//      the transcript knowing how much independence it actually had.
//   4. A hard `needs` is the one thing that can leave a seat empty: a researcher with
//      no web access is not a degraded researcher, it is a fabrication risk.
//   5. The judge should not grade its own argument — it prefers a runtime that did not
//      debate, and only doubles up when there is nothing else.
//
// Pure function over plain data, so every rule above is unit-testable with no CLI,
// no filesystem and no network.

import type { Role, RoleNeed } from "./roles.ts";
import type { Capability } from "./providers/types.ts";

export type AvailableProvider = {
  key: string;
  label: string;
  vendor: string;
  caps: Capability;
  /** Pinned binary path when it was not the one on PATH. */
  bin?: string;
  /** Version string the binary reported, recorded for reproducibility. */
  version?: string;
  /** Set when upstream retired the CLI: eligible, but never preferred. */
  deprecated?: string;
};

export type Binding = {
  roleId: string;
  roleName: string;
  provider: string;
  providerLabel: string;
  vendor: string;
  bin?: string;
  /** Which build answered. A dossier revisited months later needs this to be checkable. */
  providerVersion?: string;
  /** Capabilities switched on for this participant. */
  grants: { web: boolean; execute: boolean };
  /** True when this runtime also plays another role in the same debate. */
  shared: boolean;
  /** Human-readable justification, printed by `doctor` and stored in the transcript. */
  reason: string;
};

export type Unfilled = {
  roleId: string;
  roleName: string;
  reason: string;
  /** Providers that would have satisfied the role, for an install hint. */
  wanted: string[];
};

export type CastResult = {
  debaters: Binding[];
  judge?: Binding;
  unfilled: Unfilled[];
  warnings: string[];
};

export type CastInput = {
  roles: Role[];
  judgeRole?: Role;
  available: AvailableProvider[];
  /** Hard role→provider pins from config. A pin that cannot be honoured is an error. */
  pins?: Record<string, string>;
  /** Allow one runtime to play several roles when there is no alternative. */
  allowShared?: boolean;
};

function meetsNeeds(p: AvailableProvider, needs: RoleNeed[]): boolean {
  return needs.every((n) => (n === "web" ? p.caps.web : p.caps.execute));
}

/**
 * Eligible providers for a role, best first: the role's own preference order, then
 * anything else that qualifies (so a brand-new CLI the role never heard of is still
 * usable), with retired runtimes pushed to the back of each group.
 */
export function eligibleFor(role: Role, available: AvailableProvider[]): AvailableProvider[] {
  const ok = available.filter((p) => meetsNeeds(p, role.needs));
  const rank = (p: AvailableProvider): number => {
    const i = role.prefer.indexOf(p.key);
    // Unpreferred-but-eligible sorts after every preferred one; retired sorts last.
    return (i === -1 ? role.prefer.length : i) + (p.deprecated ? 1000 : 0);
  };
  return [...ok].sort((a, b) => rank(a) - rank(b));
}

function grantsFor(role: Role, p: AvailableProvider): { web: boolean; execute: boolean } {
  const wanted = new Set<RoleNeed>([...role.needs, ...role.wants]);
  return {
    // A want is only granted when the runtime can actually deliver it; a need was
    // already proven by eligibility.
    web: wanted.has("web") && p.caps.web,
    execute: wanted.has("execute") && p.caps.execute,
  };
}

export function cast(input: CastInput): CastResult {
  const { roles, judgeRole, available, pins = {}, allowShared = true } = input;
  const byKey = new Map(available.map((p) => [p.key, p]));
  const debaters: Binding[] = [];
  const unfilled: Unfilled[] = [];
  const warnings: string[] = [];
  const used = new Set<string>();

  const bind = (role: Role, p: AvailableProvider, shared: boolean, reason: string): Binding => ({
    roleId: role.id,
    roleName: role.name,
    provider: p.key,
    providerLabel: p.label,
    vendor: p.vendor,
    ...(p.bin && { bin: p.bin }),
    ...(p.version && { providerVersion: p.version }),
    grants: grantsFor(role, p),
    shared,
    reason,
  });

  // Honour pins first: an explicit choice outranks every heuristic below.
  const pinned = new Map<string, AvailableProvider>();
  for (const role of roles.concat(judgeRole ? [judgeRole] : [])) {
    const want = pins[role.id];
    if (!want) continue;
    const p = byKey.get(want);
    if (!p) {
      warnings.push(`vai "${role.id}" được ghim vào "${want}" nhưng runtime đó không khả dụng — bỏ ghim, chọn tự động`);
      continue;
    }
    if (!meetsNeeds(p, role.needs)) {
      warnings.push(`vai "${role.id}" được ghim vào "${want}" nhưng runtime đó thiếu: ${role.needs.join(", ")} — bỏ ghim`);
      continue;
    }
    pinned.set(role.id, p);
  }

  // Most-constrained role first, so a role with a single eligible runtime is not left
  // empty by a less constrained role that had alternatives and took it anyway.
  // `index` keeps the output in the user's declared order afterwards.
  const queue = roles
    .map((role, index) => ({ role, index, options: eligibleFor(role, available) }))
    .sort((a, b) => a.options.length - b.options.length || a.index - b.index);

  for (const { role, options } of queue) {
    const pin = pinned.get(role.id);
    if (pin) {
      const shared = used.has(pin.key);
      used.add(pin.key);
      debaters.push(bind(role, pin, shared, `ghim trong cấu hình → ${pin.label}`));
      continue;
    }
    if (options.length === 0) {
      unfilled.push({
        roleId: role.id,
        roleName: role.name,
        reason: role.needs.length
          ? `không runtime nào khả dụng có đủ năng lực bắt buộc: ${role.needs.join(", ")}`
          : "không có runtime nào khả dụng",
        wanted: role.prefer,
      });
      continue;
    }
    // Diversity first: take an unused runtime if one is eligible.
    const fresh = options.find((p) => !used.has(p.key));
    if (fresh) {
      used.add(fresh.key);
      const why = role.prefer.includes(fresh.key)
        ? `ưu tiên #${role.prefer.indexOf(fresh.key) + 1} của vai`
        : "không nằm trong danh sách ưu tiên nhưng đủ năng lực";
      debaters.push(bind(role, fresh, false, `${why} → ${fresh.label}`));
      continue;
    }
    if (!allowShared) {
      unfilled.push({
        roleId: role.id,
        roleName: role.name,
        reason: "mọi runtime đủ điều kiện đã được dùng cho vai khác (allowShared=false)",
        wanted: role.prefer,
      });
      continue;
    }
    const reuse = options[0];
    debaters.push(bind(role, reuse, true, `dùng chung ${reuse.label} vì không còn runtime nào khác`));
  }

  // Restore the user's declared role order for output.
  const order = new Map(roles.map((r, i) => [r.id, i]));
  debaters.sort((a, b) => (order.get(a.roleId) ?? 0) - (order.get(b.roleId) ?? 0));

  // The judge prefers a runtime that did not debate: a model that argued a position
  // and then rules on it is grading its own homework.
  let judge: Binding | undefined;
  if (judgeRole) {
    const pin = pinned.get(judgeRole.id);
    const options = eligibleFor(judgeRole, available);
    const choice = pin ?? options.find((p) => !used.has(p.key)) ?? options[0];
    if (!choice) {
      unfilled.push({
        roleId: judgeRole.id,
        roleName: judgeRole.name,
        reason: "không có runtime nào khả dụng cho chủ tọa",
        wanted: judgeRole.prefer,
      });
    } else {
      const alsoDebated = used.has(choice.key);
      judge = bind(
        judgeRole,
        choice,
        alsoDebated,
        pin ? `ghim trong cấu hình → ${choice.label}` : alsoDebated ? `dùng chung ${choice.label} (đã tham gia tranh luận)` : `runtime độc lập → ${choice.label}`,
      );
      if (alsoDebated) {
        warnings.push(
          `chủ tọa chạy trên ${choice.label} — cùng runtime với một bên tranh luận, nên phán quyết có thể thiên vị chính lập luận của nó`,
        );
      }
    }
  }

  // The value of this exercise is cross-vendor disagreement. Say so when it is absent.
  const vendors = new Set(debaters.map((b) => b.vendor));
  if (debaters.length >= 2 && vendors.size === 1) {
    warnings.push(
      `cả ${debaters.length} bên tranh luận đều chạy trên nhà cung cấp "${[...vendors][0]}" — tranh luận sẽ kém độc lập; cài thêm một CLI khác hãng để có đối chất thực sự`,
    );
  }
  if (debaters.length === 1) {
    warnings.push("chỉ có 1 vai được phân — đây là độc thoại, không phải tranh luận");
  }

  return { debaters, ...(judge && { judge }), unfilled, warnings };
}
