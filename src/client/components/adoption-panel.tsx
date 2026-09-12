import { cn } from "cn";
import { Mono } from "@/client/components/severity";

export interface AdoptionRule {
	ruleId: string;
	title: string;
	kind: string;
	severity: string;
	findings: number;
	reviewsHit: number;
	compliance: number;
	trend: string;
}

export interface AdoptionReport {
	windowDays: number;
	reviews: number;
	codexVersion: string;
	rules: AdoptionRule[];
}

/**
 * Adoption, worst rule first.
 *
 * The ordering is the point. A rule sitting at 40% compliance is telling you
 * something - either it is badly specified, or it is genuinely expensive to
 * satisfy and needs tooling rather than a stricter gate. Sorting by compliance
 * puts that rule at the top instead of burying it under the nine that work.
 */
export function AdoptionPanel({ report }: { report: AdoptionReport | null }) {
	if (!report || report.reviews === 0) {
		return (
			<p className="py-8 text-center text-[12px] text-muted-foreground">
				No reviews recorded yet. Run a review and the adoption history builds from there.
			</p>
		);
	}

	return (
		<div>
			<p className="mb-3 font-mono text-[11px] text-muted-foreground">
				Codex {report.codexVersion} · {report.reviews} review(s) over {report.windowDays} days
			</p>

			<div className="overflow-hidden rounded-lg border">
				{report.rules.map((rule) => (
					<div key={rule.ruleId} className="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0">
						<Mono className="w-[58px] shrink-0 font-semibold">{rule.ruleId}</Mono>

						<div className="min-w-0 flex-1">
							<p className="truncate text-[12.5px]">{rule.title}</p>
							<p className="font-mono text-[10.5px] text-muted-foreground">
								{rule.kind} · {rule.findings} finding(s) across {rule.reviewsHit} review(s)
							</p>
						</div>

						<div className="h-1 w-[86px] shrink-0 overflow-hidden rounded-sm bg-muted">
							<span
								className={cn(
									"block h-full",
									rule.compliance >= 0.9 ? "bg-pass" : rule.compliance >= 0.6 ? "bg-warning" : "bg-blocking",
								)}
								style={{ width: `${Math.round(rule.compliance * 100)}%` }}
							/>
						</div>

						<Mono className="w-[38px] shrink-0 text-right">{Math.round(rule.compliance * 100)}%</Mono>

						<Mono
							className={cn(
								"w-[62px] shrink-0 text-right tracking-wider uppercase",
								rule.trend === "improving" && "text-pass",
								rule.trend === "declining" && "text-blocking",
								rule.trend === "flat" && "text-muted-foreground",
							)}
						>
							{rule.trend}
						</Mono>
					</div>
				))}
			</div>
		</div>
	);
}
