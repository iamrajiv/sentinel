import "./index.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { Loader2, ShieldAlert } from "lucide-react";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/client/components/ui/tabs";
import { Textarea } from "@/client/components/ui/textarea";
import { AdoptionPanel, type AdoptionReport } from "@/client/components/adoption-panel";
import { ChatPanel, type ChatMessage } from "@/client/components/chat-panel";
import { ReviewPanel } from "@/client/components/review-panel";
import { WaiversPanel } from "@/client/components/waivers-panel";
import { Mono } from "@/client/components/severity";
import type { CodexAgent, CodexState } from "@/agents/codex-agent.ts";
import { CODEX, CODEX_VERSION } from "@/codex/rules.ts";
import { FIXTURES } from "@/fixtures/diffs.ts";
import { repoSlug } from "@/lib/repo.ts";
import type { Waiver } from "@/lib/types.ts";

const RULE_IDS = CODEX.map((r) => r.id);
const TABS = ["verdict", "waivers", "adoption", "ask"] as const;
type Tab = (typeof TABS)[number];

function App() {
	const [repo, setRepo] = useState("acme/edge-api");
	const [fixtureId, setFixtureId] = useState(FIXTURES[0]!.id);
	const [patch, setPatch] = useState(FIXTURES[0]!.patch);
	const [tab, setTab] = useState<Tab>("verdict");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	const [state, setState] = useState<CodexState | null>(null);
	const [waivers, setWaivers] = useState<Waiver[]>([]);
	const [adoption, setAdoption] = useState<AdoptionReport | null>(null);

	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [streaming, setStreaming] = useState(false);

	// One Agent instance per repository. Changing the repo reconnects the socket
	// to a different instance, which is also a different SQLite database - so the
	// waivers and history below swap with it.
	const agent = useAgent<CodexAgent, CodexState>({
		agent: "CodexAgent",
		name: repoSlug(repo),
		onStateUpdate: (next) => setState(next),
	});

	const refreshMemory = useCallback(async () => {
		try {
			const [nextWaivers, nextAdoption] = await Promise.all([
				agent.stub.listWaivers(),
				agent.stub.adoptionReport(30),
			]);
			setWaivers(nextWaivers as Waiver[]);
			setAdoption(nextAdoption as AdoptionReport);
		} catch {
			// The socket is still connecting on first mount; the next state update
			// or user action will retry. Surfacing this would be noise.
		}
	}, [agent]);

	useEffect(() => {
		setMessages([]);
		void refreshMemory();
	}, [refreshMemory]);

	// A completed review changes both the adoption numbers and (via waivers
	// applied during the run) what the memory tab should show.
	const lastReviewId = state?.lastVerdict?.reviewId;
	useEffect(() => {
		if (lastReviewId) void refreshMemory();
	}, [lastReviewId, refreshMemory]);

	const reviewing = state?.active != null && state.active.phase !== "failed";

	async function runReview() {
		setError(null);
		setSubmitting(true);
		setTab("verdict");

		const fixture = FIXTURES.find((f) => f.id === fixtureId);
		try {
			await agent.stub.reviewDiff({
				repo,
				pr: fixture?.pr ?? 0,
				title: fixture?.title ?? "Manual review",
				author: fixture?.author ?? "you",
				patch,
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : "Review failed to start.");
		} finally {
			setSubmitting(false);
		}
	}

	async function sendChat(text: string) {
		const userId = crypto.randomUUID();
		const replyId = crypto.randomUUID();

		setMessages((prev) => [
			...prev,
			{ id: userId, role: "user", text },
			{ id: replyId, role: "sentinel", text: "" },
		]);
		setStreaming(true);

		const append = (chunk: string) =>
			setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, text: m.text + chunk } : m)));

		try {
			await agent.call("chat", [text], {
				stream: {
					onChunk: (chunk: unknown) => append(String(chunk)),
					onDone: () => setStreaming(false),
					onError: (message: unknown) => {
						setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, role: "error", text: String(message) } : m)));
						setStreaming(false);
					},
				},
			});
		} catch (e) {
			setMessages((prev) =>
				prev.map((m) =>
					m.id === replyId ? { ...m, role: "error", text: e instanceof Error ? e.message : "Chat failed." } : m,
				),
			);
			setStreaming(false);
		}
	}

	const counts = useMemo(
		() => ({
			verdict: state?.lastVerdict?.findings.length ?? 0,
			waivers: waivers.length,
			adoption: adoption?.reviews ?? 0,
			ask: messages.filter((m) => m.role === "user").length,
		}),
		[state, waivers, adoption, messages],
	);

	return (
		<div className="grid h-full grid-rows-[auto_1fr]">
			<header className="flex h-12 items-center gap-4 border-b bg-card px-4">
				<div className="flex items-baseline gap-2">
					<ShieldAlert className="size-4 translate-y-0.5 text-primary" />
					<span className="text-[12px] font-semibold tracking-[0.16em] uppercase">Sentinel</span>
				</div>

				<Input
					value={repo}
					onChange={(e) => setRepo(e.target.value)}
					className="h-7 w-[190px] font-mono text-[11px]"
					aria-label="Repository"
				/>

				<div className="ml-auto flex items-center gap-4">
					<Mono className="text-muted-foreground">codex {CODEX_VERSION}</Mono>
					<Mono className="text-muted-foreground">{CODEX.length} rules</Mono>
					<Mono className="text-muted-foreground">{state?.reviewCount ?? 0} reviews</Mono>
				</div>
			</header>

			<div className="grid grid-cols-1 overflow-hidden md:grid-cols-[minmax(380px,42%)_1fr]">
				{/* ---- change under review ---- */}
				<section className="flex min-w-0 flex-col overflow-hidden">
					<div className="flex min-h-[38px] items-center border-b px-3.5 py-2">
						<span className="text-[11px] tracking-wider text-muted-foreground uppercase">Change</span>
					</div>

					<div className="flex-1 overflow-y-auto p-3.5">
						<div className="mb-2.5 flex flex-wrap gap-1.5">
							{FIXTURES.map((f) => (
								<Badge
									key={f.id}
									variant="outline"
									title={f.description}
									onClick={() => {
										setFixtureId(f.id);
										setPatch(f.patch);
									}}
									className={
										fixtureId === f.id
											? "cursor-pointer border-primary text-[11px] font-normal text-primary"
											: "cursor-pointer text-[11px] font-normal text-muted-foreground hover:border-foreground/40"
									}
								>
									{f.label}
								</Badge>
							))}
						</div>

						<Textarea
							value={patch}
							onChange={(e) => {
								setPatch(e.target.value);
								setFixtureId("");
							}}
							spellCheck={false}
							className="min-h-[300px] font-mono text-[11.5px] leading-[1.55]"
							placeholder="Paste a unified diff (git diff)…"
						/>

						<div className="mt-2.5 flex items-center gap-2.5">
							<Button size="sm" onClick={runReview} disabled={submitting || reviewing || patch.trim().length === 0}>
								{submitting || reviewing ? <Loader2 className="size-3.5 animate-spin" /> : null}
								{reviewing ? "Reviewing…" : "Run codex review"}
							</Button>
							<Mono className="text-muted-foreground">{patch.split("\n").length} lines</Mono>
						</div>

						{error ? (
							<div className="mt-2.5 rounded-md border border-blocking/40 px-3 py-2 text-[12px] text-blocking">{error}</div>
						) : null}

						<div className="mt-5">
							<p className="mb-2 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
								Codex {CODEX_VERSION}
							</p>
							<div className="rounded-lg border">
								{CODEX.map((rule) => (
									<div key={rule.id} className="border-b px-3 py-2 last:border-b-0">
										<div className="flex items-baseline gap-2">
											<Mono className="font-semibold">{rule.id}</Mono>
											<span className="text-[12.5px]">{rule.title}</span>
											<Mono className="ml-auto text-muted-foreground">
												{rule.severity} · {rule.kind}
											</Mono>
										</div>
									</div>
								))}
							</div>
						</div>
					</div>
				</section>

				{/* ---- verdict and memory ---- */}
				<section className="flex min-w-0 flex-col overflow-hidden border-t md:border-t-0 md:border-l">
					<Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex h-full flex-col gap-0">
						<div className="flex min-h-[38px] items-center border-b px-3.5 py-1.5">
							<TabsList className="h-7 bg-transparent p-0">
								{TABS.map((t) => (
									<TabsTrigger key={t} value={t} className="h-7 px-2.5 text-[11px] tracking-wider uppercase">
										{t}
										{counts[t] > 0 ? <span className="ml-1.5 font-mono text-muted-foreground">{counts[t]}</span> : null}
									</TabsTrigger>
								))}
							</TabsList>
						</div>

						<div className="flex-1 overflow-hidden">
							{tab === "ask" ? (
								<ChatPanel messages={messages} streaming={streaming} onSend={sendChat} />
							) : (
								<div className="h-full overflow-y-auto p-3.5">
									{tab === "verdict" ? (
										<ReviewPanel active={state?.active ?? null} verdict={state?.lastVerdict ?? null} />
									) : null}

									{tab === "waivers" ? (
										<WaiversPanel
											waivers={waivers}
											ruleIds={RULE_IDS}
											busy={submitting}
											onGrant={async (input) => {
												setError(null);
												try {
													await agent.stub.grantWaiver(input);
													await refreshMemory();
												} catch (e) {
													setError(e instanceof Error ? e.message : "Could not record the waiver.");
												}
											}}
											onRevoke={async (id) => {
												await agent.stub.revokeWaiver(id);
												await refreshMemory();
											}}
										/>
									) : null}

									{tab === "adoption" ? <AdoptionPanel report={adoption} /> : null}
								</div>
							)}
						</div>
					</Tabs>
				</section>
			</div>
		</div>
	);
}

document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")!).render(<App />);
