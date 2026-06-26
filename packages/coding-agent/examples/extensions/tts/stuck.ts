export type StuckReason = "short_response" | "refusal" | "repetition" | "retry_limit";

const REFUSAL_PATTERNS = [
	/\bi cannot assist\b/i,
	/\bi'm unable to\b/i,
	/\bi am unable to\b/i,
	/\bas an ai language model\b/i,
	/\bi cannot help with\b/i,
	/\bi'm not able to\b/i,
	/\bi am not able to\b/i,
];

const SHORT_RESPONSE_THRESHOLD = 80;
const RETRY_LIMIT = 3;

export interface StuckCheckOptions {
	retryCount: number;
	previousResponse?: string;
}

export function isStuck(response: string, opts: StuckCheckOptions): boolean {
	if (opts.retryCount >= RETRY_LIMIT) return true;
	if (response.trim().length < SHORT_RESPONSE_THRESHOLD) return true;
	if (opts.previousResponse !== undefined && response.trim() === opts.previousResponse.trim()) return true;
	for (const pattern of REFUSAL_PATTERNS) {
		if (pattern.test(response)) return true;
	}
	return false;
}

export function detectStuckReason(response: string, opts: StuckCheckOptions): StuckReason | null {
	if (opts.retryCount >= RETRY_LIMIT) return "retry_limit";
	if (response.trim().length < SHORT_RESPONSE_THRESHOLD) return "short_response";
	if (opts.previousResponse !== undefined && response.trim() === opts.previousResponse.trim()) return "repetition";
	for (const pattern of REFUSAL_PATTERNS) {
		if (pattern.test(response)) return "refusal";
	}
	return null;
}

export function buildRetryPrompt(originalPrompt: string, reason: StuckReason, attempt: number): string {
	const hint =
		reason === "short_response"
			? "Please provide a more detailed and complete response."
			: reason === "refusal"
				? "Please focus on what you can do and proceed step by step."
				: reason === "repetition"
					? "Your previous response was identical. Try a different approach."
					: "Please try again with a fresh approach.";

	const escalationNote =
		attempt >= 2
			? " If you are truly blocked, indicate that you need expert guidance."
			: "";

	return `${originalPrompt}\n\n[Hint: ${hint}${escalationNote}]`;
}
