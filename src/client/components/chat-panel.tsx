import { useEffect, useRef, useState } from "react";
import { SendHorizonal } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";

export interface ChatMessage {
	id: string;
	role: "user" | "sentinel" | "error";
	text: string;
}

const SUGGESTIONS = [
	"Why did CDX-002 fail on this PR?",
	"Which rule are we worst at, and why?",
	"Should we waive CDX-005 for generated code?",
	"Summarise this review for the PR description.",
];

/**
 * The chat surface.
 *
 * Everything interesting happens server-side, in the system prompt: the agent
 * injects the codex, this review's findings, the live waivers and the adoption
 * history before the question. That is what separates a useful answer ("CDX-002
 * fired on line 9 because `actions/checkout@v4` is a tag; line 17 passed
 * because it is already a SHA") from a generic explanation of supply-chain
 * pinning that the engineer could have read in the rule text.
 */
export function ChatPanel({
	messages,
	streaming,
	onSend,
}: {
	messages: ChatMessage[];
	streaming: boolean;
	onSend: (text: string) => void;
}) {
	const [draft, setDraft] = useState("");
	const logRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
	}, [messages]);

	const submit = (text: string) => {
		const trimmed = text.trim();
		if (trimmed.length === 0 || streaming) return;
		onSend(trimmed);
		setDraft("");
	};

	return (
		<div className="flex h-full flex-col">
			<div ref={logRef} className="flex flex-1 flex-col gap-3 overflow-y-auto p-3.5">
				{messages.length === 0 ? (
					<p className="py-6 text-center text-[12px] text-muted-foreground">
						Ask about a finding, a rule, or this repository&rsquo;s history.
					</p>
				) : (
					messages.map((m) => (
						<div key={m.id} className={cn("max-w-[88%]", m.role === "user" && "self-end")}>
							<p
								className={cn(
									"mb-1 font-mono text-[10px] tracking-wider text-muted-foreground uppercase",
									m.role === "user" && "text-right",
								)}
							>
								{m.role === "user" ? "you" : m.role === "error" ? "error" : "sentinel"}
							</p>
							<div
								className={cn(
									"rounded-lg border px-3 py-2 text-[12.5px] whitespace-pre-wrap",
									m.role === "user" && "bg-muted",
									m.role === "error" && "border-blocking/40 text-blocking",
								)}
							>
								{m.text || (streaming ? "…" : "")}
							</div>
						</div>
					))
				)}
			</div>

			{messages.length === 0 ? (
				<div className="flex flex-wrap gap-1.5 px-3.5 pb-2.5">
					{SUGGESTIONS.map((s) => (
						<Badge
							key={s}
							variant="outline"
							className="cursor-pointer text-[11px] font-normal hover:border-primary hover:text-primary"
							onClick={() => submit(s)}
						>
							{s}
						</Badge>
					))}
				</div>
			) : null}

			<form
				className="flex gap-2 border-t p-3"
				onSubmit={(e) => {
					e.preventDefault();
					submit(draft);
				}}
			>
				<Input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="Ask Sentinel…"
					disabled={streaming}
					className="h-8 text-[12.5px]"
				/>
				<Button type="submit" size="sm" disabled={streaming || draft.trim().length === 0} className="h-8">
					<SendHorizonal className="size-3.5" />
				</Button>
			</form>
		</div>
	);
}
