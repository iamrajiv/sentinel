import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { Label } from "@/client/components/ui/label";
import { Textarea } from "@/client/components/ui/textarea";
import { Mono } from "@/client/components/severity";
import type { Waiver } from "@/lib/types.ts";

/**
 * Recorded exceptions.
 *
 * The form asks for a reason and an owner before it will accept anything,
 * because an unattributed waiver is just a disabled rule with extra steps. The
 * expiry is the other half: it forces the exception back in front of a human
 * instead of quietly becoming permanent.
 */
export function WaiversPanel({
	waivers,
	ruleIds,
	onGrant,
	onRevoke,
	busy,
}: {
	waivers: Waiver[];
	ruleIds: string[];
	onGrant: (input: { ruleId: string; pathGlob: string; reason: string; grantedBy: string; expiresInDays: number }) => void;
	onRevoke: (id: string) => void;
	busy: boolean;
}) {
	const [ruleId, setRuleId] = useState(ruleIds[0] ?? "CDX-001");
	const [pathGlob, setPathGlob] = useState("src/**");
	const [reason, setReason] = useState("");
	const [grantedBy, setGrantedBy] = useState("");
	const [expiresInDays, setExpiresInDays] = useState("90");

	const canSubmit = reason.trim().length >= 10 && grantedBy.trim().length > 0 && !busy;

	return (
		<div>
			<div className="mb-4 grid gap-2.5 rounded-lg border p-3">
				<div className="grid grid-cols-2 gap-2.5">
					<div>
						<Label className="mb-1 text-[10px] tracking-wider uppercase">Rule</Label>
						<select
							value={ruleId}
							onChange={(e) => setRuleId(e.target.value)}
							className="h-8 w-full rounded-md border bg-background px-2 font-mono text-[11.5px]"
						>
							{ruleIds.map((id) => (
								<option key={id} value={id}>
									{id}
								</option>
							))}
						</select>
					</div>
					<div>
						<Label className="mb-1 text-[10px] tracking-wider uppercase">Path glob</Label>
						<Input
							value={pathGlob}
							onChange={(e) => setPathGlob(e.target.value)}
							className="h-8 font-mono text-[11.5px]"
							placeholder="src/legacy/**"
						/>
					</div>
				</div>

				<div>
					<Label className="mb-1 text-[10px] tracking-wider uppercase">
						Reason {reason.trim().length > 0 && reason.trim().length < 10 ? "(too short)" : ""}
					</Label>
					<Textarea
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						className="min-h-[58px] font-mono text-[11.5px]"
						placeholder="Why this rule genuinely does not apply here. Someone will read this in 90 days."
					/>
				</div>

				<div className="grid grid-cols-2 gap-2.5">
					<div>
						<Label className="mb-1 text-[10px] tracking-wider uppercase">Owner</Label>
						<Input
							value={grantedBy}
							onChange={(e) => setGrantedBy(e.target.value)}
							className="h-8 font-mono text-[11.5px]"
							placeholder="platform-team"
						/>
					</div>
					<div>
						<Label className="mb-1 text-[10px] tracking-wider uppercase">Expires in (days)</Label>
						<Input
							value={expiresInDays}
							onChange={(e) => setExpiresInDays(e.target.value)}
							className="h-8 font-mono text-[11.5px]"
							inputMode="numeric"
						/>
					</div>
				</div>

				<Button
					size="sm"
					disabled={!canSubmit}
					onClick={() => {
						onGrant({
							ruleId,
							pathGlob,
							reason: reason.trim(),
							grantedBy: grantedBy.trim(),
							expiresInDays: Math.max(1, Number.parseInt(expiresInDays, 10) || 90),
						});
						setReason("");
					}}
				>
					Record waiver
				</Button>
			</div>

			{waivers.length === 0 ? (
				<p className="py-6 text-center text-[12px] text-muted-foreground">
					No exceptions recorded. Every rule applies everywhere.
				</p>
			) : (
				<div className="overflow-hidden rounded-lg border">
					{waivers.map((w) => (
						<div key={w.id} className="flex items-start gap-3 border-b px-3 py-2.5 last:border-b-0">
							<div className="min-w-0 flex-1">
								<div className="flex flex-wrap items-baseline gap-2">
									<Mono className="font-semibold text-primary">{w.ruleId}</Mono>
									<Mono className="text-muted-foreground">{w.pathGlob}</Mono>
									<Mono className="text-muted-foreground">
										{w.grantedBy} · expires {w.expiresAt ? w.expiresAt.slice(0, 10) : "never"}
									</Mono>
								</div>
								<p className="mt-0.5 text-[12px] text-muted-foreground">{w.reason}</p>
							</div>
							<Button
								size="icon"
								variant="ghost"
								className="size-7 shrink-0 text-muted-foreground hover:text-blocking"
								onClick={() => onRevoke(w.id)}
								aria-label={`Revoke waiver for ${w.ruleId}`}
							>
								<Trash2 className="size-3.5" />
							</Button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
