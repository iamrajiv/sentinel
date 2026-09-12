import { cn } from "cn";
import type { Decision, Severity } from "@/lib/types.ts";

/**
 * Severity is the one visual scale in this UI, so it is defined once.
 *
 * Blocking / warning / advisory / pass appears on the verdict banner, the
 * finding rail, the adoption bars and the rule list. Learning it once and
 * reading it everywhere is the difference between a console an engineer scans
 * and one they have to parse.
 */
export const SEVERITY_TEXT: Record<Severity, string> = {
	blocking: "text-blocking",
	warning: "text-warning",
	advisory: "text-advisory",
};

export const SEVERITY_BORDER: Record<Severity, string> = {
	blocking: "border-l-blocking",
	warning: "border-l-warning",
	advisory: "border-l-advisory",
};

export const DECISION_STYLE: Record<Decision, { text: string; ring: string; label: string }> = {
	block: { text: "text-blocking", ring: "border-blocking/40 bg-blocking/8", label: "BLOCK" },
	warn: { text: "text-warning", ring: "border-warning/40 bg-warning/8", label: "WARN" },
	pass: { text: "text-pass", ring: "border-pass/40 bg-pass/8", label: "PASS" },
};

export function Mono({ className, children }: { className?: string; children: React.ReactNode }) {
	return <span className={cn("font-mono text-[11px]", className)}>{children}</span>;
}
