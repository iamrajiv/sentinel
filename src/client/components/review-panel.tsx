import { AlertTriangle, ShieldCheck } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/client/components/ui/badge";
import { Progress } from "@/client/components/ui/progress";
import { DECISION_STYLE, Mono, SEVERITY_BORDER, SEVERITY_TEXT } from "@/client/components/severity";
import type { Finding, ReviewProgress, Verdict } from "@/lib/types.ts";

/** The live progress of a running review, driven by Workflow step callbacks. */
function RunningReview({ active }: { active: ReviewProgress }) {
	return (
		<div className="mb-4 rounded-lg border">
			<div className="flex items-baseline gap-3 px-3 py-2.5">
				<Mono className="uppercase tracking-wider text-primary">{active.phase}</Mono>
				<span className="text-sm">{active.label}</span>
				{active.detail ? <Mono className="ml-auto text-muted-foreground">{active.detail}</Mono> : null}
			</div>
			<Progress value={active.percent * 100} className="h-0.5 rounded-none" />
		</div>
	);
}

function FindingCard({ finding }: { finding: Finding }) {
	const where = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;

	return (
		<div className={cn("mb-2 rounded-md border border-l-2 px-3 py-2.5", SEVERITY_BORDER[finding.severity])}>
			<div className="mb-1.5 flex flex-wrap items-baseline gap-2">
				<Mono className={cn("font-semibold", SEVERITY_TEXT[finding.severity])}>{finding.ruleId}</Mono>
				<Mono className="text-muted-foreground">{where}</Mono>

				{finding.source === "judged" ? (
					<Badge variant="outline" className="border-primary/40 font-mono text-[9.5px] text-primary uppercase">
						judged {finding.confidence.toFixed(2)}
					</Badge>
				) : (
					<Badge variant="outline" className="font-mono text-[9.5px] text-muted-foreground uppercase">
						static
					</Badge>
				)}
			</div>

			<p className="mb-1.5 text-[13px]">{finding.message}</p>

			{finding.evidence ? (
				<code className="mb-1.5 block overflow-x-auto rounded bg-background px-2 py-1.5 font-mono text-[11px] whitespace-pre text-muted-foreground">
					{finding.evidence}
				</code>
			) : null}

			<p className="text-[12px] text-muted-foreground">
				<span className="font-semibold">Fix: </span>
				{finding.remediation}
			</p>
		</div>
	);
}

export function ReviewPanel({ active, verdict }: { active: ReviewProgress | null; verdict: Verdict | null }) {
	if (!verdict && !active) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
				<ShieldCheck className="size-6 opacity-40" />
				<p className="text-[13px]">Paste a diff and run a review.</p>
			</div>
		);
	}

	const style = verdict ? DECISION_STYLE[verdict.decision] : null;

	return (
		<div>
			{active ? <RunningReview active={active} /> : null}

			{verdict && style ? (
				<>
					<div className={cn("mb-4 flex items-center gap-3 rounded-lg border px-3.5 py-2.5", style.ring)}>
						<span className={cn("font-mono text-[13px] font-bold tracking-wider", style.text)}>{style.label}</span>
						<span className="text-[12px] text-muted-foreground">
							{verdict.repo}#{verdict.pr}
						</span>
						<Mono className="ml-auto text-muted-foreground">
							{verdict.stats.filesChanged} files · {verdict.stats.rulesEvaluated} rules · {verdict.stats.blocking}B{" "}
							{verdict.stats.warning}W {verdict.stats.advisory}A
							{verdict.stats.waived > 0 ? ` · ${verdict.stats.waived} waived` : ""}
						</Mono>
					</div>

					{verdict.degraded && verdict.degraded.length > 0 ? (
						<div className="mb-3 flex items-start gap-2 rounded-md border border-dashed border-warning/40 px-3 py-2 text-[12px] text-warning">
							<AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
							<span>
								These rules could not be evaluated and were excluded from the decision: {verdict.degraded.join(", ")}
							</span>
						</div>
					) : null}

					{verdict.findings.length === 0 ? (
						<div className="rounded-md border border-pass/30 bg-pass/5 px-3 py-6 text-center text-[13px] text-muted-foreground">
							No findings. The change satisfies every rule in the codex.
						</div>
					) : (
						verdict.findings.map((f, i) => <FindingCard key={`${f.ruleId}-${f.path}-${f.line}-${i}`} finding={f} />)
					)}

					{verdict.waived.length > 0 ? (
						<div className="mt-4">
							<p className="mb-2 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
								Waived ({verdict.waived.length})
							</p>
							{verdict.waived.map((w, i) => (
								<div key={`${w.ruleId}-${i}`} className="mb-1.5 rounded-md border border-dashed px-3 py-2">
									<div className="flex items-baseline gap-2">
										<Mono className="text-muted-foreground line-through">{w.ruleId}</Mono>
										<Mono className="text-muted-foreground">{w.path}</Mono>
										<Mono className="ml-auto text-muted-foreground">
											expires {w.waiverExpiresAt ? w.waiverExpiresAt.slice(0, 10) : "never"}
										</Mono>
									</div>
									<p className="mt-0.5 text-[12px] text-muted-foreground">{w.waiverReason}</p>
								</div>
							))}
						</div>
					) : null}
				</>
			) : null}
		</div>
	);
}
